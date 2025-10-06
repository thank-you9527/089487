const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { addItemToInventory } = require('./lib/inventory');
const { canonicalize, validateItemBaseName } = require('./lib/names');
const {
  pickRandomPrefix,
  resolvePrefix,
  formatEffectsSummary,
  buildItem,
  getPrefixLabel
} = require('./lib/itemPrefixes');

function assertEnvOrExit() {
  const missing = [];
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (missing.length) {
    for (const key of missing) {
      console.error(`Missing required environment variable: ${key}`);
    }
    process.exit(1);
  }
}

assertEnvOrExit();

const db = require('./db');
const { SESSION_TTL_MS, SESSION_IDLE_TIMEOUT_MS } = db;
const dispatchCommands = require('./commands');

function createRateLimiter({ windowMs, refillPerWindow, burst }) {
  const buckets = new Map();
  return function rateLimit(req, res, next) {
    if (req.path === '/api/events') return next();
    const now = Date.now();
    const accountId = req.user?.id || 'anon';
    const key = `${accountId}:${req.ip}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: burst, updatedAt: now };
      buckets.set(key, bucket);
    }
    const elapsed = now - bucket.updatedAt;
    if (elapsed > 0) {
      const refill = (elapsed / windowMs) * refillPerWindow;
      bucket.tokens = Math.min(burst, bucket.tokens + refill);
      bucket.updatedAt = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      const remaining = Math.max(0, Math.floor(bucket.tokens));
      const resetSeconds = Math.ceil(
        Math.max(0, (burst - bucket.tokens) / refillPerWindow)
      );
      res.set('X-RateLimit-Limit', String(refillPerWindow));
      res.set('X-RateLimit-Remaining', String(remaining));
      res.set('X-RateLimit-Reset', String(resetSeconds));
      return next();
    }

    const needed = 1 - bucket.tokens;
    const waitMs = (needed / refillPerWindow) * windowMs;
    const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
    res.set('X-RateLimit-Limit', String(refillPerWindow));
    res.set('X-RateLimit-Remaining', '0');
    res.set('X-RateLimit-Reset', String(retryAfter));
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'rate-limited', retryAfter });
  };
}

function streamEvent(res, event) {
  if (!res || !event) return;
  const id = event.id ?? event.event_id;
  const kind = event.kind || 'message';
  const data = JSON.stringify(event.payload ?? {});
  const parts = [];
  if (id != null) parts.push(`id: ${id}`);
  parts.push(`event: ${kind}`);
  parts.push(`data: ${data}`);
  res.write(`${parts.join('\n')}\n\n`);
}

function createEventHub() {
  const listeners = new Map();
  return {
    subscribe(playerId, res) {
      if (!playerId || !res) return;
      if (!listeners.has(playerId)) listeners.set(playerId, new Set());
      listeners.get(playerId).add(res);
    },
    unsubscribe(playerId, res) {
      const subs = listeners.get(playerId);
      if (!subs) return;
      subs.delete(res);
      if (subs.size === 0) listeners.delete(playerId);
    },
    publish(playerId, event) {
      if (!playerId || !event) return;
      const subs = listeners.get(playerId);
      if (!subs || subs.size === 0) return;
      for (const res of Array.from(subs)) {
        try {
          streamEvent(res, event);
        } catch (err) {
          subs.delete(res);
        }
      }
      if (subs.size === 0) listeners.delete(playerId);
    }
  };
}

const eventHub = createEventHub();
const EVENT_KEEPALIVE_MS = 25_000;

async function runEventCleanup() {
  if (!db._pool) return 0;
  const client = await db._pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1,$2) AS locked', [42, 1]);
    locked = rows?.[0]?.locked;
    if (!locked) return 0;
    let total = 0;
    while (true) {
      const { rowCount } = await client.query(
        `WITH stale AS (
           SELECT id FROM events
           WHERE is_read=true AND created_at < now() - interval '30 days'
           LIMIT 1000
         )
         DELETE FROM events WHERE id IN (SELECT id FROM stale)`
      );
      if (!rowCount) break;
      total += rowCount;
    }
    if (total > 0) {
      console.log('[events-cleanup]', { deleted: total });
    }
    const removedSessions = await db.cleanupStaleSessions(client);
    if (removedSessions > 0) {
      console.log('[sessions-cleanup]', {
        deleted: removedSessions,
        idleTimeoutSec: SESSION_IDLE_TIMEOUT_SEC
      });
    }
    return total;
  } catch (err) {
    console.error('events cleanup failed', err);
    return 0;
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1,$2)', [42, 1]);
      } catch (unlockErr) {
        console.error('failed to release cleanup lock', unlockErr);
      }
    }
    client.release();
  }
}

let cleanupTimer = null;
let cleanupStarted = false;

function ensureCleanupJob() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const kickoff = () => runEventCleanup().catch(err => console.error('initial cleanup failed', err));
  setTimeout(kickoff, 5_000).unref?.();
  cleanupTimer = setInterval(() => {
    runEventCleanup().catch(err => console.error('scheduled cleanup failed', err));
  }, 60 * 60 * 1000);
  cleanupTimer.unref?.();
}

const RATE_LIMITER = createRateLimiter({ windowMs: 1000, refillPerWindow: 3, burst: 6 });

const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  req.id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const accountId = req.user?.id || '-';
    console.log(
      `[${req.id}] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms ${accountId}`
    );
  });
  next();
});

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});
app.get('/player.html', (req, res) => {
  res.redirect(302, '/');
});
app.use(express.static(__dirname));

const mapPath = path.join(__dirname, 'data', 'map.json');
let worldMap = {};
let mapWriteLock = Promise.resolve();

const normalizeName = canonicalize;

function forEachMonster(callback) {
  if (typeof callback !== 'function') return;
  for (const key in worldMap) {
    const loc = worldMap[key];
    if (!loc || !Array.isArray(loc.monsters)) continue;
    for (const monster of loc.monsters) {
      if (!monster) continue;
      callback(monster, key, loc);
    }
  }
}

function findMonstersByNormalizedName(name) {
  const target = normalizeName(name);
  if (!target) return [];
  const matches = [];
  forEachMonster((monster, location, loc) => {
    if (normalizeName(monster.name) === target) {
      matches.push({ monster, location, loc });
    }
  });
  return matches;
}

async function isItemNameTaken(name, client) {
  const canonical = canonicalize(name);
  if (!canonical) return false;
  const item = await db.findActiveItemByNameNorm(canonical, client);
  return !!item;
}

async function isAnyNameTaken(name, options = {}) {
  const canonical = canonicalize(name);
  if (!canonical) return false;
  if (findMonstersByNormalizedName(name).length > 0) return true;
  const players = await db.findPlayersByNameInsensitive(name, options.client);
  if (players.length > 0) return true;
  const item = await db.findActiveItemByNameNorm(canonical, options.client);
  return !!item;
}

function scheduleMapWrite(task) {
  const next = mapWriteLock.then(() => task());
  mapWriteLock = next.catch(() => {});
  return next;
}

async function loadMap() {
  try {
    const data = await fs.readFile(mapPath, 'utf8');
    worldMap = JSON.parse(data);
    for (const key in worldMap) {
      const loc = worldMap[key];
      if (loc && loc.name === '荒山野嶺') {
        loc.name = '廢墟';
        if (typeof loc.description === 'string') {
          loc.description = loc.description.replace(/荒山野嶺/g, '廢墟');
        }
      }
      if (loc && Array.isArray(loc.monsters)) {
        if (loc.monsters.length > 5) {
          loc.monsters = loc.monsters.slice(0, 5);
          worldMap[key].monsters = loc.monsters;
        }
        for (const m of loc.monsters) {
          if (!m.maxHp) m.maxHp = hpAtLevel(m.level);
        }
      }
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      worldMap = {};
      await fs.writeFile(mapPath, JSON.stringify(worldMap, null, 2));
    } else {
      console.error('Failed to read map', err);
      worldMap = {};
    }
  }
}
async function saveMap() {
  return scheduleMapWrite(async () => {
    try {
      await fs.writeFile(mapPath, JSON.stringify(worldMap, null, 2));
    } catch (err) {
      console.error('Failed to save map', err);
    }
  });
}

function hydrateCharacter(row) {
  if (!row) return null;
  const position = {
    x: row.x ?? 0,
    y: row.y ?? 0,
    z: row.z ?? 0
  };
  const bindPoint =
    row.bindX != null && row.bindY != null && row.bindZ != null
      ? { x: row.bindX, y: row.bindY, z: row.bindZ }
      : null;
  const expCurrent = typeof row.expCurrent === 'number' ? row.expCurrent : 0;
  const expMax = typeof row.expMax === 'number' ? row.expMax : 0;
  const maxHp = typeof row.hpMax === 'number' ? row.hpMax : Math.max(1, row.hp || 1);
  const maxAction =
    typeof row.actionMax === 'number' ? row.actionMax : Math.max(0, row.action || 0);
  return {
    accountId: row.id,
    name: row.name,
    status: row.status,
    dayAge: row.dayAge ?? 0,
    level: row.level ?? 1,
    identity: row.identity ?? '探求者',
    morality: row.morality ?? 50,
    action: row.action ?? maxAction,
    maxAction,
    attack: row.attack ?? 0,
    hp: row.hp ?? maxHp,
    maxHp,
    exp: { current: expCurrent, max: expMax },
    position,
    bio: row.bio || '',
    gold: row.gold ?? 0,
    inventory: Array.isArray(row.inventory) ? row.inventory : [],
    bindPoint,
    dodge: row.dodge ?? 3,
    lastHpUpdate: row.lastHpUpdate ?? Date.now(),
    lastActionUpdate: row.lastActionUpdate ?? Date.now()
  };
}

function clampNumber(value, min, max) {
  const n = typeof value === 'number' ? value : Number(value) || 0;
  if (typeof max === 'number') return Math.max(min, Math.min(max, n));
  return Math.max(min, n);
}

function serializeCharacter(character) {
  const maxHp = clampNumber(
    character.maxHp ?? character.hpMax ?? character.hp ?? 1,
    1
  );
  const actionMax = clampNumber(
    character.maxAction ?? character.actionMax ?? character.action ?? 0,
    0
  );
  const hp = clampNumber(character.hp, 0, maxHp);
  const action = clampNumber(character.action, 0, actionMax);
  const morality = clampNumber(character.morality, 0, 100);
  const expCurrent = clampNumber(character.exp?.current, 0);
  const expMax = clampNumber(character.exp?.max ?? expCurrent, 0);
  const bind = character.bindPoint || null;
  return {
    id: character.accountId,
    name: character.name,
    status: character.status,
    identity: character.identity,
    dayAge: character.dayAge ?? 0,
    morality,
    level: character.level ?? 1,
    attack: clampNumber(character.attack, 0),
    hp,
    hpMax: maxHp,
    action,
    actionMax,
    expCurrent,
    expMax,
    x: character.position?.x ?? 0,
    y: character.position?.y ?? 0,
    z: character.position?.z ?? 0,
    bindX: bind ? bind.x : null,
    bindY: bind ? bind.y : null,
    bindZ: bind ? bind.z : null,
    gold: clampNumber(character.gold, 0),
    dodge: clampNumber(character.dodge, 0),
    inventory: Array.isArray(character.inventory) ? character.inventory : [],
    lastHpUpdate: character.lastHpUpdate ?? Date.now(),
    lastActionUpdate: character.lastActionUpdate ?? Date.now()
  };
}

function responseCharacter(character) {
  const { accountId, ...rest } = character;
  return rest;
}

const userRegex = /^[A-Za-z0-9!@#$%^&*]{5,20}$/;
const passRegex = /^[A-Za-z0-9!@#$%^&*]{8,20}$/;
const nameRegex = /^[A-Za-z0-9\u4E00-\u9FFF.,•，。_]{1,10}$/;
const areaNameRegex = /^[A-Za-z0-9\u4E00-\u9FFF]{3,11}$/;
const monsterNameRegex = /^[A-Za-z0-9\u4E00-\u9FFF]{3,11}$/;

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

const captchas = new Map();

const SECURE_COOKIE =
  process.env.COOKIE_SECURE != null
    ? process.env.COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production';

const COOKIE_BASE = { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIE, path: '/' };
const COOKIE_WITH_MAX_AGE = { ...COOKIE_BASE, maxAge: SESSION_TTL_MS };
const DISABLE_CAPTCHA = process.env.DISABLE_CAPTCHA === 'true';
const JWT_EXPIRES_IN = '7d';
const SESSION_IDLE_TIMEOUT_SEC = Math.max(0, Math.floor(SESSION_IDLE_TIMEOUT_MS / 1000));

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const [rawKey, ...rest] = part.split('=');
    if (!rawKey) return acc;
    const key = rawKey.trim();
    const value = rest.join('=').trim();
    if (!key) return acc;
    acc[key] = decodeURIComponent(value || '');
    return acc;
  }, {});
}

function setAuthCookie(res, token) {
  res.cookie('jwt', token, COOKIE_WITH_MAX_AGE);
}

function clearAuthCookie(res) {
  res.clearCookie('jwt', COOKIE_BASE);
}

const itemsPath = path.join(__dirname, 'data', 'items.json');
let itemsDB = [];
async function loadItems() {
  try {
    const data = await fs.readFile(itemsPath, 'utf8');
    itemsDB = JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      itemsDB = [];
      await fs.writeFile(itemsPath, '[]');
    } else {
      itemsDB = [];
    }
  }
}

async function auth(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const token = cookies.jwt;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    let payload;
    try {
      payload = jwt.verify(token, SECRET);
    } catch (err) {
      clearAuthCookie(res);
      const code = err?.name === 'TokenExpiredError' ? 'session-expired' : 'bad-token';
      return res.status(401).json({ error: code });
    }
    const { sub, jti, username } = payload;
    if (!sub || !jti || !username) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'bad-token' });
    }
    const session = await db.getSession(jti);
    if (!session) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'session-gone' });
    }
    req.user = { id: sub, sessionId: jti, username };
    req.username = username;
    req.sessionRow = session;
    return next();
  } catch (err) {
    console.error('auth middleware failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
}

async function ensureActiveSession(req, res, next) {
  try {
    const session = req.sessionRow;
    if (!session) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'unauthorized' });
    }
    const now = Date.now();
    let failureCode = 'unauthorized';
    if (session?.expires_at) {
      const expiresAt = new Date(session.expires_at).getTime();
      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        failureCode = 'session-expired';
      }
    }
    if (failureCode === 'unauthorized' && session?.last_seen && SESSION_IDLE_TIMEOUT_MS > 0) {
      const lastSeen = new Date(session.last_seen).getTime();
      if (Number.isFinite(lastSeen) && lastSeen + SESSION_IDLE_TIMEOUT_MS <= now) {
        failureCode = 'session-timeout';
      }
    }
    const touched = await db.touchSession(session.session_id);
    if (!touched) {
      clearAuthCookie(res);
      return res.status(401).json({ error: failureCode });
    }
    return next();
  } catch (err) {
    console.error('ensureActiveSession failed', err);
    clearAuthCookie(res);
    return res.status(401).json({ error: 'unauthorized' });
  }
}

// attribute growth constants
const MAX_HP = 9487000;
const MAX_ATK = 8700000;
const MAX_EXP = 9487000;
const MAX_GAIN = 870000;
const HP_L1_TARGET = 100;
const ATK_L1_TARGET = 10;
const EXPCAP_L1_TARGET = 100;
const EXPGAIN_L1_TARGET = 15;
const K = 0.0046;
const CENTER = 2500;

function s(level) {
  return 1 / (1 + Math.exp(-K * (level - CENTER)));
}

const S1 = s(1);
const S5000 = s(5000);

function scaled(level) {
  return (s(level) - S1) / (S5000 - S1);
}

function hpAtLevel(level) {
  const val = HP_L1_TARGET + scaled(level) * (MAX_HP - HP_L1_TARGET);
  return Math.round(val);
}

function attackAtLevel(level) {
  const val = ATK_L1_TARGET + scaled(level) * (MAX_ATK - ATK_L1_TARGET);
  return Math.round(val);
}

function expMaxAtLevel(level) {
  const val = EXPCAP_L1_TARGET + scaled(level) * (MAX_EXP - EXPCAP_L1_TARGET);
  return Math.round(val);
}

function expGainForLevel(level) {
  const val = EXPGAIN_L1_TARGET + scaled(level) * (MAX_GAIN - EXPGAIN_L1_TARGET);
  return Math.round(val);
}

function actionAtLevel(level) {
  if (level <= 1) return 100;
  if (level >= 300) return 300;
  const frac = (level - 1) / (300 - 1);
  const val = 100 + frac * (300 - 100);
  return Math.round(val);
}

function updateStats(character) {
  const newMaxHp = hpAtLevel(character.level);
  if (!character.maxHp) character.maxHp = newMaxHp;
  if (character.hp > character.maxHp) character.hp = character.maxHp;
  character.maxHp = newMaxHp;

  character.attack = attackAtLevel(character.level);

  const newMaxAction = actionAtLevel(character.level);
  if (!character.maxAction) character.maxAction = newMaxAction;
  if (character.action > character.maxAction) character.action = character.maxAction;
  character.maxAction = newMaxAction;

  if (character.exp && typeof character.exp === 'object') {
    character.exp.max = expMaxAtLevel(character.level);
  }
}

function fmt(n) {
  return typeof n === 'number' ? Math.round(n) : n;
}

function regen(character) {
  const now = Date.now();
  if (!character.lastHpUpdate) character.lastHpUpdate = now;
  if (character.hp > 0) {
    const elapsed = (now - character.lastHpUpdate) / 1000;
    if (elapsed > 0) {
      const gain = character.maxHp * 0.0008 * elapsed;
      character.hp = Math.min(character.maxHp, character.hp + gain);
    }
  }
  character.lastHpUpdate = now;

  if (!character.lastActionUpdate) character.lastActionUpdate = now;
  const actionElapsed = Math.floor((now - character.lastActionUpdate) / 60000);
  if (actionElapsed > 0) {
    character.action = Math.min(character.maxAction, character.action + actionElapsed);
    character.lastActionUpdate += actionElapsed * 60000;
  }
}

function monsterDrop(mon, c, loc, logs, options = {}) {
  c.gold = c.gold || 0;
  if (itemsDB.length === 0 || Math.random() < 0.15) {
    const gold = mon.level * 10 + Math.floor(Math.random() * 21) - 10;
    c.gold += gold;
    logs.push(`獲得金幣${fmt(gold)}`);
  } else {
    const item = itemsDB[Math.floor(Math.random() * itemsDB.length)];
    const result = addItemToInventory(c, { name: item.name, level: item.level, prefix: item.prefix }, options);
    logs.push(`獲得${item.name}`);
    if (result.dropped) {
      const droppedName = result.dropped.name || '一件道具';
      logs.push(`背包太滿，${droppedName}被系統丟棄。`);
    }
  }
}

async function pickupItems(c, options = {}) {
  const { queueEvent, logs, dbClient } = options;
  const key = `${c.position.x},${c.position.y},${c.position.z}`;
  const loc = worldMap[key];
  if (!loc || !Array.isArray(loc.items)) return;
  const remaining = [];
  for (const item of loc.items) {
    if (item.owner === c.name) {
      const result = addItemToInventory(
        c,
        { name: item.name, level: item.level, prefix: item.prefix, id: item.id },
        { queueEvent }
      );
      if (item.id) {
        await db.setItemOwner(item.id, c.accountId, dbClient);
      }
      if (result.dropped?.id) {
        await db.setItemOwner(result.dropped.id, null, dbClient);
      }
      if (result.dropped && Array.isArray(logs)) {
        const droppedName = result.dropped.name || '一件道具';
        logs.push(`背包太滿，${droppedName}被系統丟棄。`);
      }
    } else {
      remaining.push(item);
    }
  }
  if (remaining.length > 0) loc.items = remaining; else delete loc.items;
  await saveMap();
}

function reviveMonsters() {
  const minute = new Date().getMinutes();
  if (minute % 15 !== 0) return;
  let changed = false;
  for (const key in worldMap) {
    const loc = worldMap[key];
    if (!loc || !loc.owner || !Array.isArray(loc.monsters)) continue;
    for (const m of loc.monsters) {
      if (m.hp <= 0 && m.lastReviveMinute !== minute) {
        m.hp = hpAtLevel(m.level);
        m.lastReviveMinute = minute;
        changed = true;
      }
    }
  }
  if (changed) saveMap();
}

async function handleDeath(c, logs, markDirty, queueEvent, dbClient) {
  const deathPos = { ...c.position };
  if (c.inventory && c.inventory.length > 0 && Math.random() < 0.5) {
    const idx = Math.floor(Math.random() * c.inventory.length);
    const item = c.inventory.splice(idx, 1)[0];
    if (item?.id) {
      await db.setItemOwner(item.id, null, dbClient);
    }
    const key = `${deathPos.x},${deathPos.y},${deathPos.z}`;
    const loc = worldMap[key] || {};
    loc.items = loc.items || [];
    loc.items.push({ ...item, owner: c.name });
    worldMap[key] = loc;
    await saveMap();
    logs.push('你掉落了一件道具');
  }
  const respawn = c.bindPoint || { x: 0, y: 0, z: 0 };
  c.position = { ...respawn };
  c.hp = c.maxHp * 0.05;
  const now = Date.now();
  c.lastHpUpdate = now;
  c.lastActionUpdate = now;
  c.status = '鼠了';
  logs.push(`${c.name}死亡並在(${c.position.x},${c.position.y},${c.position.z})復活`);
  await pickupItems(c, { queueEvent, logs, dbClient });
  if (typeof markDirty === 'function') markDirty(c.accountId);
}

function findMonsterByName(name) {
  const matches = findMonstersByNormalizedName(name);
  if (matches.length === 0) return null;
  const { monster, location } = matches[0];
  return { monster, location };
}

app.get('/api/captcha', (req, res) => {
  const id = Math.random().toString(36).substring(2, 10);
  const text = Math.random().toString(36).substring(2, 7).toUpperCase();
  captchas.set(id, text);
  setTimeout(() => captchas.delete(id), 5 * 60 * 1000);
  res.json({ id, text });
});

app.post('/api/register', async (req, res) => {
  const { username, password, captchaId, captcha } = req.body;
  if (!userRegex.test(username) || !passRegex.test(password)) {
    return res.status(400).json({ error: 'invalid input' });
  }
  if (!DISABLE_CAPTCHA) {
    const expected = captchas.get(captchaId);
    if (!expected || expected !== captcha) {
      return res.status(400).json({ error: 'invalid captcha' });
    }
  }
  if (captchaId) {
    captchas.delete(captchaId);
  }
  try {
    if (await isAnyNameTaken(username)) {
      return res.status(400).json({ error: 'username-taken' });
    }
    let existing = null;
    try {
      existing = await db.findAccountByUsername(username);
    } catch (err) {
      if (err && err.code === 'CANONICAL_COLLISION') {
        return res.status(400).json({ error: 'username-taken' });
      }
      throw err;
    }
    if (existing) {
      return res.status(400).json({ error: 'username-taken' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await db.createAccount(username, passwordHash);
    res.json({ ok: true });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(400).json({ error: 'username-taken' });
    }
    console.error('account creation failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    let account = null;
    try {
      account = await db.findAccountByUsername(username);
    } catch (err) {
      if (err && err.code === 'CANONICAL_COLLISION') {
        return res.status(409).json({ error: 'username-collision' });
      }
      throw err;
    }
    if (!account) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(password, account.passwordHash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    const userAgent = req.get('user-agent') || null;
    const ipHeader = req.headers['x-forwarded-for'];
    const ip = Array.isArray(ipHeader)
      ? ipHeader[0]
      : typeof ipHeader === 'string'
      ? ipHeader.split(',')[0].trim()
      : req.ip;
    try {
      const { sessionId } = await db.createSession(account.id, { userAgent, ip });
      const token = jwt.sign({ sub: account.id, jti: sessionId, username: account.username }, SECRET, {
        expiresIn: JWT_EXPIRES_IN
      });
      setAuthCookie(res, token);
      return res.status(204).end();
    } catch (err) {
      console.error('createSession failed', err);
      return res.status(500).json({ error: 'internal error' });
    }
  } catch (err) {
    console.error('login failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/logout', auth, ensureActiveSession, async (req, res) => {
  try {
    await db.deleteSession(req.user.sessionId);
  } catch (err) {
    console.error('deleteSession failed', err);
  }
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.post('/api/logout-beacon', auth, ensureActiveSession, async (req, res) => {
  try {
    await db.deleteSession(req.user.sessionId);
  } catch (err) {
    console.error('logout-beacon failed', err);
  }
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.post('/api/ping', auth, ensureActiveSession, (req, res) => {
  res.json({ ok: true });
});

app.get('/api/db-ping', async (req, res) => {
  try {
    if (!db._pool) {
      throw new Error('database not configured');
    }
    const r = await db._pool.query('select 1 as ok');
    res.json({ ok: r.rows[0].ok === 1 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/events', auth, ensureActiveSession, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write('\n');

  const lastIdHeader = Number(req.get('Last-Event-ID'));
  const sinceQuery = Number(req.query?.sinceId);
  const sinceId = Number.isFinite(lastIdHeader)
    ? lastIdHeader
    : Number.isFinite(sinceQuery)
    ? sinceQuery
    : 0;

  let closed = false;
  const keepAlive = setInterval(() => {
    if (closed) return;
    try {
      res.write(':ka\n\n');
    } catch (err) {
      cleanup();
    }
  }, EVENT_KEEPALIVE_MS);
  keepAlive.unref?.();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    eventHub.unsubscribe(req.user.id, res);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);

  (async () => {
    try {
      const backlog = await db.listEventsSince(req.user.id, sinceId, 200);
      for (const event of backlog) {
        streamEvent(res, event);
      }
    } catch (err) {
      console.error(`[${req.id}] failed to backfill events`, err);
      streamEvent(res, {
        id: Date.now(),
        kind: 'error',
        payload: { message: 'failed to load previous events' }
      });
    }
    if (!closed) {
      eventHub.subscribe(req.user.id, res);
    }
  })();
});

app.get('/api/character', auth, ensureActiveSession, RATE_LIMITER, async (req, res) => {
  try {
    const result = await db.withPlayerTx(req.user.id, async client => {
      const row = await db.getPlayer(req.user.id, client);
      if (!row) return null;
      const character = hydrateCharacter(row);
      updateStats(character);
      regen(character);
      await db.upsertPlayer(serializeCharacter(character), client);
      return responseCharacter(character);
    });
    if (!result) {
      return res.status(404).json({ error: 'character-missing' });
    }
    res.json({
      name: result.name,
      dayAge: result.dayAge,
      level: result.level,
      identity: result.identity,
      morality: fmt(result.morality),
      action: fmt(result.action),
      attack: fmt(result.attack),
      hp: fmt(result.hp),
      exp: { current: fmt(result.exp.current), max: fmt(result.exp.max) },
      position: { x: result.position.x, y: result.position.y, z: result.position.z },
      bio: result.bio || '看屁看'
    });
  } catch (err) {
    console.error('failed to load character', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/character', auth, ensureActiveSession, RATE_LIMITER, async (req, res) => {
  const { name } = req.body;
  if (!nameRegex.test(name)) {
    return res.status(400).json({ error: 'invalid name' });
  }
  if (name === req.username) {
    return res.status(400).json({ error: 'name cannot equal username' });
  }
  if (await isAnyNameTaken(name)) {
    return res.status(400).json({ error: 'name taken' });
  }
  try {
    const account = await db.findAccountByUsername(req.username);
    if (!account) return res.status(400).json({ error: 'user not found' });
    if (await bcrypt.compare(name, account.passwordHash)) {
      return res.status(400).json({ error: 'name cannot equal password' });
    }
    const created = await db.withPlayerTx(req.user.id, async client => {
      const existing = await db.getPlayer(req.user.id, client);
      if (existing) {
        return { error: 'character exists' };
      }
      const nameMatches = await db.findPlayersByNameInsensitive(name, client);
      if (nameMatches.length > 0) {
        return { error: 'name taken' };
      }
      const maxHp = hpAtLevel(1);
      const maxAction = actionAtLevel(1);
      const character = {
        accountId: req.user.id,
        name,
        status: '醒著',
        dayAge: 0,
        level: 1,
        identity: '探求者',
        morality: Math.floor(Math.random() * 41) + 30,
        action: maxAction,
        maxAction,
        attack: attackAtLevel(1),
        hp: maxHp,
        maxHp,
        exp: { current: 0, max: expMaxAtLevel(1) },
        position: { x: 0, y: 0, z: 0 },
        bio: '',
        gold: 0,
        inventory: [],
        bindPoint: null,
        dodge: 3,
        lastHpUpdate: Date.now(),
        lastActionUpdate: Date.now()
      };
      await db.upsertPlayer(serializeCharacter(character), client);
      return responseCharacter(character);
    });
    if (created && created.error) {
      return res.status(400).json({ error: created.error });
    }
    res.json(created);
  } catch (err) {
    console.error('failed to create character', err);
    res.status(500).json({ error: 'internal error' });
  }
});

function countPlayersAtPosition(playersIterable, pos) {
  let count = 0;
  for (const ch of playersIterable) {
    if (
      ch &&
      ch.position &&
      ch.position.x === pos.x &&
      ch.position.y === pos.y &&
      ch.position.z === pos.z
    ) {
      count += 1;
    }
  }
  return count;
}

function getLocationInfo(playersIterable, pos) {
  const key = `${pos.x},${pos.y},${pos.z}`;
  const loc = worldMap[key];
  const playersHere = countPlayersAtPosition(playersIterable, pos);
  if (loc) {
    const npcs = Array.isArray(loc.npcs) ? loc.npcs.length : 0;
    const monsters = Array.isArray(loc.monsters) ? loc.monsters.length : 0;
    return {
      name: loc.name,
      level: loc.level || '',
      owner: loc.owner || '無所屬',
      population: playersHere + npcs + monsters,
      description: loc.description || '這個人很懶，什麼都沒寫。',
      address: pos,
      returnMark: !!loc.returnMark
    };
  }
  return {
    name: '未開拓之地',
    level: '',
    owner: '無所屬',
    population: playersHere,
    description: '嗚啦呀哈呀哈嗚啦',
    address: pos,
    returnMark: false
  };
}

function formatLocationInfo(info) {
  const lvl = info.level === '' ? '' : fmt(info.level);
  let text = `地區名稱：${info.name}\n等級：${lvl}\n擁有者：${info.owner}\n地區人數：${fmt(info.population)}\n簡介：${info.description}\n地址：(${info.address.x},${info.address.y},${info.address.z})`;
  if (info.returnMark) text += '\n【回歸標記】';
  return text;
}

function formatCharacterInfo(ch) {
  return `名稱：${ch.name}\n狀態：${ch.status}\n日齡：${fmt(ch.dayAge)}\n等級：${fmt(ch.level)}\n身份：${ch.identity}\n道德：${fmt(ch.morality)}\n行動值：${fmt(ch.action)}\n攻擊力：${fmt(ch.attack)}\n血量：${fmt(ch.hp)}\n經驗值：${fmt(ch.exp.current)}/${fmt(ch.exp.max)}\n位置：(${ch.position.x},${ch.position.y},${ch.position.z})\n簡介：${ch.bio || ''}`;
}

function findCharactersByNameIn(playersIterable, name) {
  const matches = [];
  const target = normalizeName(name);
  if (!target) return matches;
  for (const ch of playersIterable) {
    if (!ch || !ch.name) continue;
    if (normalizeName(ch.name) === target) {
      matches.push(ch);
    }
  }
  return matches;
}

app.post('/api/command', auth, ensureActiveSession, RATE_LIMITER, async (req, res) => {
  const { command } = req.body || {};
  const trimmed = typeof command === 'string' ? command.trim() : '';
  if (!trimmed) {
    return res.status(400).json({ error: 'invalid command' });
  }

  try {
    const participants = new Set([req.user.id]);
    let targetPlayerId = null;

    if (trimmed.startsWith('歐拉/')) {
      const targetName = trimmed.slice(3).trim();
      if (targetName) {
        const matches = await db.findPlayersByNameInsensitive(targetName);
        const target = matches.find(player => player.id !== req.user.id);
        if (target) {
          targetPlayerId = target.id;
          participants.add(target.id);
        }
      }
    } else if (trimmed === '歐拉') {
      const attackerRow = await db.getPlayer(req.user.id);
      if (!attackerRow) {
        return res.status(400).json({ error: 'character not found' });
      }
      const { rows } = await db._pool.query(
        'SELECT id FROM players WHERE x=$1 AND y=$2 AND z=$3 AND id <> $4',
        [attackerRow.x, attackerRow.y, attackerRow.z, req.user.id]
      );
      for (const row of rows) {
        participants.add(row.id);
      }
    }

    const participantIds = Array.from(participants);
    const eventsToPublish = [];
    const queuedEvents = [];
    const outcome = await db.withPlayersTx(participantIds, async client => {
      reviveMonsters();
      const rows = await db.listPlayers(client);
      const playersMap = new Map();
      const playersByName = new Map();
      for (const row of rows) {
        const hydrated = hydrateCharacter(row);
        playersMap.set(row.id, hydrated);
        const keyName = normalizeName(hydrated.name);
        if (!playersByName.has(keyName)) playersByName.set(keyName, []);
        playersByName.get(keyName).push(hydrated);
      }

      const ownerIds = rows.map(row => row.id);
      const itemsByOwner = await db.listActiveItemsByOwners(ownerIds, client);
      for (const row of rows) {
        const hydrated = playersMap.get(row.id);
        if (hydrated) {
          hydrated.inventory = itemsByOwner.get(row.id) || [];
        }
      }

      const c = playersMap.get(req.user.id);
      if (!c) {
        return { status: 400, body: { error: 'character not found' } };
      }

      updateStats(c);
      regen(c);
      const queueEventFn = entry => {
        if (entry && entry.playerId && entry.kind) {
          queuedEvents.push(entry);
        }
      };

      await pickupItems(c, { queueEvent: queueEventFn, dbClient: client });

      if (c.status === '鼠了' && c.hp > 0) c.status = '醒著';
      if (c.status === '眼睛閉著' && trimmed !== '歐歐睏') c.status = '醒著';

      const logs = [];
      const dirtyPlayers = new Set([req.user.id]);
      const markPlayerDirty = id => {
        if (id) dirtyPlayers.add(id);
      };

      const usersList = Array.from(playersMap.entries()).map(([id, character]) => ({
        username: id,
        character
      }));

      const currentLocationKey = `${c.position.x},${c.position.y},${c.position.z}`;

      const context = {
        c,
        users: usersList,
        worldMap,
        saveMap,
        getLocationInfo: pos => getLocationInfo(playersMap.values(), pos),
        countPlayersAt: pos => countPlayersAtPosition(playersMap.values(), pos),
        getRegionFromDb: pos => {
          if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') {
            return Promise.resolve(null);
          }
          return db.getRegionByCoord(pos.x, pos.y, pos.z, client);
        },
        listRegionMobsFromDb: regionId => db.listRegionMobs(regionId, client),
        formatLocationInfo,
        formatCharacterInfo,
        listPlayersByName: name => playersByName.get(normalizeName(name)) || [],
        findCharactersByName: name => findCharactersByNameIn(playersMap.values(), name),
        findMonsterByName,
        listMonstersByName: findMonstersByNormalizedName,
        isAnyNameTaken: name => isAnyNameTaken(name, { client }),
        isMonsterNameTaken: name => isAnyNameTaken(name, { client }),
        handleDeath: async (target, ctxLogs) =>
          handleDeath(target, ctxLogs, markPlayerDirty, queueEventFn, client),
        pickupItems: (character, options = {}) =>
          pickupItems(character, { ...options, queueEvent: queueEventFn, dbClient: client }),
        attackAtLevel,
        hpAtLevel,
        expGainForLevel,
        fmt,
        areaNameRegex,
        monsterNameRegex,
        monsterDrop: (monster, character, loc, logList, options = {}) =>
          monsterDrop(monster, character, loc, logList, {
            ...options,
            queueEvent: queueEventFn
          }),
        dbClient: client,
        markPlayerDirty,
        currentLocationKey,
        queueEvent: queueEventFn
      };

      await dispatchCommands(trimmed, context, logs);

      for (const id of dirtyPlayers) {
        const player = playersMap.get(id);
        if (player) {
          await db.upsertPlayer(serializeCharacter(player), client);
        }
      }

      for (const entry of queuedEvents) {
        const row = await db.appendEvent(entry.playerId, entry.kind, entry.payload, client);
        eventsToPublish.push({ playerId: entry.playerId, event: row });
      }

      const block = logs.slice();

      const selfEvent = await db.appendEvent(
        req.user.id,
        'command',
        { command: trimmed, block, logs: block },
        client
      );
      eventsToPublish.push({ playerId: req.user.id, event: selfEvent });
      if (targetPlayerId && dirtyPlayers.has(targetPlayerId)) {
        const targetEvent = await db.appendEvent(
          targetPlayerId,
          'command',
          { command: trimmed, block, logs: block },
          client
        );
        eventsToPublish.push({ playerId: targetPlayerId, event: targetEvent });
      }

      return { status: 200, body: { block, logs: block } };
    });

    const status = outcome?.status ?? 500;
    const body = outcome?.body ?? { error: 'server error' };
    if (Array.isArray(eventsToPublish)) {
      for (const entry of eventsToPublish) {
        if (entry?.playerId && entry.event) {
          eventHub.publish(entry.playerId, entry.event);
        }
      }
    }
    res.status(status).json(body);
  } catch (err) {
    console.error('command handler failed', err);
    res.status(500).json({ error: 'server error' });
  }
});

app.use((err, req, res, next) => {
  console.error(`[${req?.id || '-'}]`, err?.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'server' });
});

async function init() {
  await loadMap();
  await loadItems();
  await db.init();
  ensureCleanupJob();
  return app;
}

if (require.main === module) {
  init()
    .then(() => {
      const PORT = process.env.PORT || 3000;
      app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    })
    .catch(err => {
      console.error('Failed to initialize server', err);
    });
}

module.exports = {
  app,
  init,
  hpAtLevel,
  attackAtLevel,
  expMaxAtLevel,
  expGainForLevel,
  actionAtLevel,
  runEventCleanup
};
