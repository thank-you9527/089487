const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');
const cors = require('cors');
const cookieParser = require('cookie-parser');
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
const { mergeDbMonstersIntoLocation } = require('./lib/regions');

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

function normalizeValue(value) {
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) return String(value);
    return value;
  }
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value instanceof Map) {
    const out = {};
    for (const [key, val] of value.entries()) {
      if (typeof key === 'string') out[key] = normalizeValue(val);
    }
    return out;
  }
  if (value instanceof Set) return Array.from(value, normalizeValue);
  if (typeof value === 'object') {
    if (typeof value.toJSON === 'function') {
      return normalizeValue(value.toJSON());
    }
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (val === undefined) continue;
      out[key] = normalizeValue(val);
    }
    return out;
  }
  return String(value);
}

function normalizeOutput(payload) {
  const normalized = normalizeValue(payload);
  if (normalized == null) return {};
  if (Array.isArray(normalized)) return { result: normalized };
  if (typeof normalized === 'object') return normalized;
  return { result: normalized };
}

function safeStringify(value) {
  return JSON.stringify(normalizeValue(value));
}

function safeJson(value) {
  return JSON.parse(safeStringify(value));
}

function normalizeEvent(event) {
  const normalized = normalizeOutput(event);
  const payload = normalizeValue(normalized.payload ?? {});
  return { ...normalized, payload };
}

function streamEvent(res, event) {
  if (!res || !event) return;
  const safeEvent = normalizeEvent(event);
  const id = safeEvent.id ?? safeEvent.event_id;
  const kind = safeEvent.kind || 'message';
  const data = safeStringify(safeEvent.payload ?? {});
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

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(cors());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});
app.get('/player.html', (req, res) => {
  res.redirect(302, '/');
});

const worldMap = Object.create(null);

const normalizeName = canonicalize;

function locationKeyFromPosition(pos) {
  if (!pos) return null;
  const { x, y, z } = pos;
  if (![x, y, z].every(value => Number.isFinite(value))) return null;
  return `${x},${y},${z}`;
}

function ensureWorldLocation(pos) {
  const key = locationKeyFromPosition(pos);
  if (!key) return null;
  if (!worldMap[key]) worldMap[key] = {};
  const loc = worldMap[key];
  if (!loc.name) loc.name = '未開拓之地';
  if (loc.level == null) loc.level = '';
  if (!loc.owner) loc.owner = '無所屬';
  if (typeof loc.description !== 'string') loc.description = '嗚啦呀哈呀哈嗚啦';
  if (!Array.isArray(loc.monsters)) loc.monsters = [];
  if (!Array.isArray(loc.items)) loc.items = [];
  loc.address = { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0 };
  return loc;
}

function applyRegionToLocation(pos, region) {
  const loc = ensureWorldLocation(pos);
  if (!loc) return null;
  if (region) {
    loc.regionId = region.id || null;
    loc.name = region.name || loc.name || '未開拓之地';
    loc.level = region.level != null ? region.level : loc.level ?? '';
    const ownerLabel = region.ownerDisplay || region.ownerName;
    if (ownerLabel) {
      loc.owner = ownerLabel;
    } else if (!region.ownerAccountId) {
      loc.owner = '無所屬';
    }
    loc.ownerAccountId = region.ownerAccountId || null;
    loc.ownerDisplay = region.ownerDisplay || null;
    loc.isSystem = !!region.isSystem;
    loc.isClaimable = region.isClaimable !== false;
    loc.isDestructible = region.isDestructible !== false;
  } else {
    loc.regionId = null;
    loc.ownerAccountId = null;
    loc.ownerDisplay = null;
    loc.isSystem = false;
    loc.isClaimable = true;
    loc.isDestructible = true;
    loc.name = loc.name || '未開拓之地';
    loc.level = '';
    loc.owner = '無所屬';
  }
  return loc;
}

function forEachMonster(callback) {
  if (typeof callback !== 'function') return;
  for (const key of Object.keys(worldMap)) {
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
  if (await db.isRegionMobNameTaken(canonical, options.client)) return true;
  const players = await db.findPlayersByNameInsensitive(name, options.client);
  if (players.length > 0) return true;
  const item = await db.findActiveItemByNameNorm(canonical, options.client);
  return !!item;
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

const AUTH_COOKIE_NAME = 'jwt';
const COOKIE_BASE = { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIE, path: '/' };
const COOKIE_WITH_MAX_AGE = { ...COOKIE_BASE, maxAge: SESSION_TTL_MS };
const DISABLE_CAPTCHA = process.env.DISABLE_CAPTCHA === 'true';
const JWT_EXPIRES_IN = '7d';
const SESSION_IDLE_TIMEOUT_SEC = Math.max(0, Math.floor(SESSION_IDLE_TIMEOUT_MS / 1000));

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, COOKIE_WITH_MAX_AGE);
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, COOKIE_BASE);
}

function logAndClearAuthCookie(req, res, reason, statusCodeOverride) {
  const ipHeader = req?.headers?.['x-forwarded-for'];
  const ip = Array.isArray(ipHeader)
    ? ipHeader[0]
    : typeof ipHeader === 'string'
    ? ipHeader.split(',')[0].trim()
    : req?.ip;
  const status = statusCodeOverride ?? res?.statusCode ?? 0;
  const path = req?.originalUrl || req?.path || 'unknown-path';
  const routePath = req?.route?.path || null;
  const userAgent = req?.get ? req.get('user-agent') : req?.headers?.['user-agent'];
  console.warn('[auth] clearing jwt cookie', {
    method: req?.method,
    path,
    routePath,
    status,
    reason: reason || 'unspecified',
    ip,
    userAgent
  });
  clearAuthCookie(res);
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

function clearAuthContext(req) {
  req.accountId = null;
  req.sessionId = null;
  req.account = null;
  req.user = null;
  req.username = null;
}

function authenticateRequest(req) {
  clearAuthContext(req);
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (!token) {
    return { ok: false, error: 'no-cookie' };
  }
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch (err) {
    return { ok: false, error: 'bad-jwt' };
  }
  const accountId = payload?.account_id;
  const sessionId = payload?.session_id;
  if (!accountId || !sessionId) {
    return { ok: false, error: 'bad-jwt' };
  }
  const username = payload?.username || null;
  req.accountId = accountId;
  req.sessionId = sessionId;
  req.account = { id: accountId, username };
  req.user = { id: accountId, sessionId, username };
  req.username = username;
  return { ok: true };
}

async function requireAuth(req, res, next) {
  try {
    const result = authenticateRequest(req);
    if (!result.ok) {
      req.authError = result.error;
      return res.status(401).json({ ok: false, error: result.error });
    }
    req.authError = null;
    return next();
  } catch (err) {
    console.error('auth middleware failed', err);
    req.authError = 'server-error';
    clearAuthContext(req);
    return res.status(500).json({ ok: false, error: 'server-error' });
  }
}

function authOptional(req, res, next) {
  try {
    const result = authenticateRequest(req);
    if (!result.ok) {
      req.authError = result.error;
    } else {
      req.authError = null;
    }
  } catch (err) {
    console.error('authOptional middleware failed', err);
    req.authError = 'server-error';
    clearAuthContext(req);
  }
  next();
}

async function ensureActiveSession(req, res, next) {
  try {
    if (!req.sessionId) {
      return res.status(401).json({ ok: false, error: 'no-session' });
    }
    const session = await db.getSession(req.sessionId);
    if (!session) {
      return res.status(401).json({ ok: false, error: 'session-missing' });
    }
    const expiresAt = session?.expires_at ? new Date(session.expires_at).getTime() : null;
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return res.status(401).json({ ok: false, error: 'session-expired' });
    }
    const touched = await db.touchSession(req.sessionId);
    if (!touched) {
      return res.status(401).json({ ok: false, error: 'session-missing' });
    }
    req.sessionRow = session;
    return next();
  } catch (err) {
    console.error('ensureActiveSession failed', err);
    return res.status(503).json({ ok: false, error: 'auth-db-failed' });
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
  if (!loc || !Array.isArray(loc.items) || loc.items.length === 0) return;
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
    const loc = ensureWorldLocation(deathPos) || {};
    loc.items = Array.isArray(loc.items) ? loc.items : [];
    loc.items.push({ ...item, owner: c.name });
    worldMap[key] = loc;
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
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'invalid input' });
  }
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
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'invalid input' });
  }
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
      const token = jwt.sign(
        { account_id: account.id, session_id: sessionId, username: account.username },
        SECRET,
        {
          expiresIn: JWT_EXPIRES_IN
        }
      );
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

app.post('/api/logout', requireAuth, ensureActiveSession, async (req, res) => {
  try {
    await db.deleteSession(req.sessionId);
  } catch (err) {
    console.error('deleteSession failed', err);
  }
  logAndClearAuthCookie(req, res, 'logout', 200);
  res.json({ ok: true });
});

app.post('/api/logout-beacon', async (req, res) => {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (!token) {
    logAndClearAuthCookie(req, res, 'missing-jwt', 204);
    return res.status(204).end();
  }
  try {
    const payload = jwt.verify(token, SECRET);
    const sessionId = payload?.session_id;
    if (sessionId) {
      await db.deleteSession(sessionId);
    }
  } catch (err) {
    console.error('logout-beacon failed', err);
    logAndClearAuthCookie(req, res, 'logout-beacon-invalid-jwt', 204);
    return res.status(204).end();
  }
  logAndClearAuthCookie(req, res, 'logout-beacon', 204);
  res.status(204).end();
});

app.post('/api/ping', requireAuth, ensureActiveSession, (req, res) => {
  res.json({ ok: true });
});

app.get('/api/whoami', authOptional, (req, res) => {
  if (!req.accountId) {
    const error = req.authError || 'no-session';
    const status = error === 'server-error' ? 500 : 401;
    return res.status(status).json({ ok: false, error });
  }
  res.json({
    ok: true,
    accountId: req.accountId,
    username: req.account?.username || null
  });
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

app.get('/api/events', requireAuth, ensureActiveSession, (req, res) => {
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

app.get('/api/character', requireAuth, ensureActiveSession, RATE_LIMITER, async (req, res) => {
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
    const status = err?.code === '42P01' || err?.code === '08001' || err?.code === 'ECONNREFUSED'
      ? 503
      : 500;
    console.error('failed to load character', err);
    res.status(status).json({ error: status === 503 ? 'db-unavailable' : 'internal error' });
  }
});

app.post('/api/character', requireAuth, ensureActiveSession, RATE_LIMITER, async (req, res) => {
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
  const target =
    pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)
      ? pos
      : { x: 0, y: 0, z: 0 };
  const loc = ensureWorldLocation(target);
  const address = loc?.address || { x: target.x, y: target.y, z: target.z };
  const playersHere = countPlayersAtPosition(playersIterable, address);
  const npcs = Array.isArray(loc?.npcs) ? loc.npcs.length : 0;
  const monsters = Array.isArray(loc?.monsters) ? loc.monsters.length : 0;
  return {
    name: loc?.name || '未開拓之地',
    level: loc?.level != null ? loc.level : '',
    owner: loc?.owner || '無所屬',
    population: playersHere + npcs + monsters,
    description: loc?.description || '這個人很懶，什麼都沒寫。',
    address,
    returnMark: !!loc?.returnMark
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

app.post('/api/command', requireAuth, ensureActiveSession, RATE_LIMITER, async (req, res) => {
  const commandText = (req.body?.command ?? '').trim();
  if (!commandText) {
    return res.status(400).json({ ok: false, error: 'bad-command' });
  }

  if (/^help$/i.test(commandText)) {
    const lines = [
      '指令列表：',
      'help：顯示指令列表',
      '看看：顯示目前角色資訊',
      '看看/名稱：查詢其他玩家或怪物資訊',
      '看路：顯示目前所在地區資訊',
      '前進：往目前面向方向前進一格',
      '後退：往相反方向退一格',
      '左轉：向左移動一格',
      '右轉：向右移動一格',
      '打老鷹：向上移動一格',
      '挖地瓜：向下移動一格',
      '佔領/地名：命名並佔領目前地區',
      '孵化/名稱：在目前地區孵化守護神候補或怪物',
      '歐歐睏：在有回歸標記的地區綁定復活點',
      '歐拉：對當前目標發動攻擊或友善互動',
      '歐拉/名稱：指定攻擊目前所在地區的玩家或怪物',
      '捏捏/道具名：製作或刷新道具',
      '蛋雕/道具名：刪除背包內的道具',
      '讓我看看/前綴+道具名：查看指定道具的詳細資訊',
      '查看家當：列出自己的背包內容'
    ];
    return res.json(safeJson({ ok: true, lines }));
  }

  try {
    const participants = new Set([req.user.id]);
    let targetPlayerId = null;

    if (commandText.startsWith('歐拉/')) {
      const targetName = commandText.slice(3).trim();
      if (targetName) {
        const matches = await db.findPlayersByNameInsensitive(targetName);
        const target = matches.find(player => player.id !== req.user.id);
        if (target) {
          targetPlayerId = target.id;
          participants.add(target.id);
        }
      }
    } else if (commandText === '歐拉') {
      const attackerRow = await db.getPlayer(req.user.id);
      if (!attackerRow) {
        return res.status(400).json({ ok: false, error: 'character not found' });
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

      const regionCache = new Map();
      const regionIdToKey = new Map();

      const rememberRegion = (position, region) => {
        if (!position) return region;
        const key = locationKeyFromPosition(position);
        if (!key) return region;
        regionCache.set(key, region || null);
        applyRegionToLocation(position, region);
        if (region?.id) {
          regionIdToKey.set(region.id, key);
        }
        return region;
      };

      const loadRegion = async position => {
        if (
          !position ||
          typeof position.x !== 'number' ||
          typeof position.y !== 'number' ||
          typeof position.z !== 'number'
        ) {
          return null;
        }
        const key = locationKeyFromPosition(position);
        if (regionCache.has(key)) return regionCache.get(key);
        const region = await db.getRegionByCoord(position.x, position.y, position.z, client);
        return rememberRegion(position, region);
      };

      const loadRegionMobs = async regionId => {
        if (!regionId) return [];
        const mobs = await db.listRegionMobs(regionId, client);
        const key = regionIdToKey.get(regionId);
        if (key) {
          const [x, y, z] = key.split(',').map(Number);
          const entry = ensureWorldLocation({ x, y, z });
          if (entry) {
            mergeDbMonstersIntoLocation(entry, mobs, {
              attackAtLevel,
              hpAtLevel,
              expGainForLevel
            });
          }
        }
        return mobs;
      };

      const findRegionsByName = async name => {
        const results = await db.findRegionsByName(name, client);
        return results.map(region => {
          const position = { x: region.x, y: region.y, z: region.z };
          rememberRegion(position, region);
          return { region, position };
        });
      };

      try {
        const region = await loadRegion(c.position);
        if (region?.id) {
          await loadRegionMobs(region.id);
        }
      } catch (err) {
        console.error('failed to prime region cache', err);
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
      if (c.status === '眼睛閉著' && commandText !== '歐歐睏') c.status = '醒著';

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
        getLocationInfo: pos => getLocationInfo(playersMap.values(), pos),
        countPlayersAt: pos => countPlayersAtPosition(playersMap.values(), pos),
        getRegionFromDb: loadRegion,
        listRegionMobsFromDb: loadRegionMobs,
        findRegionCoordsByName: findRegionsByName,
        maybeRespawnMobs: (regionId, options = {}) =>
          db.maybeRespawn(regionId, { now: new Date(), ...options }, client),
        killMobInDb: (mobId, options = {}) =>
          db.killMob(mobId, { now: new Date(), ...options }, client),
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

      await dispatchCommands(commandText, context, logs);

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
        { command: commandText, block, logs: block },
        client
      );
      eventsToPublish.push({ playerId: req.user.id, event: selfEvent });
      if (targetPlayerId && dirtyPlayers.has(targetPlayerId)) {
        const targetEvent = await db.appendEvent(
          targetPlayerId,
          'command',
          { command: commandText, block, logs: block },
          client
        );
        eventsToPublish.push({ playerId: targetPlayerId, event: targetEvent });
      }

      return { status: 200, body: { block, logs: block } };
    });

    const status = outcome?.status ?? 500;
    const normalized = normalizeOutput(outcome?.body ?? {});
    const responsePayload =
      status >= 200 && status < 300
        ? { ok: true, ...normalized }
        : { ok: false, ...normalized };
    if (Array.isArray(eventsToPublish)) {
      for (const entry of eventsToPublish) {
        if (entry?.playerId && entry.event) {
          eventHub.publish(entry.playerId, entry.event);
        }
      }
    }
    return res.status(status).json(safeJson(responsePayload));
  } catch (err) {
    console.error('[command] error', {
      accountId: req.user?.id,
      username: req.user?.username,
      cmd: commandText,
      when: new Date().toISOString(),
      stack: err?.stack || String(err)
    });
    return res.status(500).json(
      safeJson({ ok: false, error: 'server-error', trace: err?.message || 'command-failed' })
    );
  }
});

app.use(express.static(__dirname));

app.use((err, req, res, next) => {
  console.error(`[${req?.id || '-'}]`, err?.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'server' });
});

async function init() {
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
