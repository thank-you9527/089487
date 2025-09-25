const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');
const cors = require('cors');
const jwt = require('jsonwebtoken');

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
const dispatchCommands = require('./commands');

const app = express();
app.use(cors());
app.use(express.json());
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});
app.use(express.static(__dirname));

const mapPath = path.join(__dirname, 'data', 'map.json');
let worldMap = {};
let mapWriteLock = Promise.resolve();

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

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_BASE = { httpOnly: true, secure: true, sameSite: 'lax' };
const COOKIE_WITH_MAX_AGE = { ...COOKIE_BASE, maxAge: SESSION_TTL_MS };

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

function clearAuthCookie(res) {
  res.clearCookie('token', COOKIE_BASE);
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
    const token = cookies.token;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    let payload;
    try {
      payload = jwt.verify(token, SECRET);
    } catch (err) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { sub, jti, username } = payload;
    if (!sub || !jti || !username) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'unauthorized' });
    }
    const session = await db.getSession(jti);
    if (!session) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'session-gone' });
    }
    req.user = { id: sub, sessionId: jti, username };
    req.username = username;
    db.touchSession(jti).catch(err => console.error('touchSession failed', err));
    return next();
  } catch (err) {
    console.error('auth middleware failed', err);
    return res.status(500).json({ error: 'internal error' });
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

function addItemToInventory(c, item) {
  c.inventory = c.inventory || [];
  c.inventory.push(item);
  if (c.inventory.length > 20) {
    const minLv = Math.min(...c.inventory.map(it => it.level || 0));
    const lowest = c.inventory.filter(it => (it.level || 0) === minLv);
    const discard = lowest[Math.floor(Math.random() * lowest.length)];
    c.inventory.splice(c.inventory.indexOf(discard), 1);
  }
}

function monsterDrop(mon, c, loc, logs) {
  c.gold = c.gold || 0;
  if (itemsDB.length === 0 || Math.random() < 0.15) {
    const gold = mon.level * 10 + Math.floor(Math.random() * 21) - 10;
    c.gold += gold;
    logs.push(`獲得金幣${fmt(gold)}`);
  } else {
    const item = itemsDB[Math.floor(Math.random() * itemsDB.length)];
    addItemToInventory(c, { name: item.name, level: item.level });
    logs.push(`獲得${item.name}`);
  }
}

async function pickupItems(c) {
  const key = `${c.position.x},${c.position.y},${c.position.z}`;
  const loc = worldMap[key];
  if (!loc || !Array.isArray(loc.items)) return;
  const remaining = [];
  for (const item of loc.items) {
    if (item.owner === c.name) {
      addItemToInventory(c, { name: item.name, level: item.level });
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

async function handleDeath(c, logs, markDirty) {
  const deathPos = { ...c.position };
  if (c.inventory && c.inventory.length > 0 && Math.random() < 0.5) {
    const idx = Math.floor(Math.random() * c.inventory.length);
    const item = c.inventory.splice(idx, 1)[0];
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
  await pickupItems(c);
  if (typeof markDirty === 'function') markDirty(c.accountId);
}

function findMonsterByName(name) {
  for (const key in worldMap) {
    const loc = worldMap[key];
    if (loc && Array.isArray(loc.monsters)) {
      const m = loc.monsters.find(mon => mon.name === name);
      if (m) return { monster: m, location: key };
    }
  }
  return null;
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
  const expected = captchas.get(captchaId);
  if (!expected || expected !== captcha) {
    return res.status(400).json({ error: 'invalid captcha' });
  }
  captchas.delete(captchaId);
  try {
    const existing = await db.findAccountByUsername(username);
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
    const account = await db.findAccountByUsername(username);
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
        expiresIn: '7d'
      });
      res.cookie('token', token, COOKIE_WITH_MAX_AGE);
      res.json({ ok: true });
    } catch (err) {
      if (err && err.code === 'ALREADY_LOGGED_IN') {
        return res.status(409).json({ error: 'already-logged-in' });
      }
      console.error('createSession failed', err);
      return res.status(500).json({ error: 'internal error' });
    }
  } catch (err) {
    console.error('login failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/api/logout', auth, async (req, res) => {
  try {
    await db.deleteSession(req.user.sessionId);
  } catch (err) {
    console.error('deleteSession failed', err);
  }
  clearAuthCookie(res);
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

app.get('/api/character', auth, async (req, res) => {
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
      return res.status(404).json({ error: 'not found' });
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

app.post('/api/character', auth, async (req, res) => {
  const { name } = req.body;
  if (!nameRegex.test(name)) {
    return res.status(400).json({ error: 'invalid name' });
  }
  if (name === req.username) {
    return res.status(400).json({ error: 'name cannot equal username' });
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
      const nameHolder = await db.findPlayerByName(name, client);
      if (nameHolder) {
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

function findCharacterByNameIn(playersIterable, name) {
  for (const ch of playersIterable) {
    if (ch && ch.name === name) return ch;
  }
  return null;
}

app.post('/api/command', auth, async (req, res) => {
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
        const target = await db.findPlayerByName(targetName);
        if (target && target.id !== req.user.id) {
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
    const outcome = await db.withPlayersTx(participantIds, async client => {
      reviveMonsters();
      const rows = await db.listPlayers(client);
      const playersMap = new Map();
      for (const row of rows) {
        const hydrated = hydrateCharacter(row);
        playersMap.set(row.id, hydrated);
      }

      const c = playersMap.get(req.user.id);
      if (!c) {
        return { status: 400, body: { error: 'character not found' } };
      }

      updateStats(c);
      regen(c);
      await pickupItems(c);

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

      const context = {
        c,
        users: usersList,
        worldMap,
        saveMap,
        getLocationInfo: pos => getLocationInfo(playersMap.values(), pos),
        formatLocationInfo,
        formatCharacterInfo,
        findCharacterByName: name => findCharacterByNameIn(playersMap.values(), name),
        findMonsterByName,
        handleDeath: async (target, ctxLogs) => handleDeath(target, ctxLogs, markPlayerDirty),
        pickupItems,
        attackAtLevel,
        hpAtLevel,
        expGainForLevel,
        fmt,
        areaNameRegex,
        monsterNameRegex,
        monsterDrop,
        dbClient: client,
        markPlayerDirty
      };

      await dispatchCommands(trimmed, context, logs);

      for (const id of dirtyPlayers) {
        const player = playersMap.get(id);
        if (player) {
          await db.upsertPlayer(serializeCharacter(player), client);
        }
      }

      await db.appendEvent(req.user.id, 'command', { command: trimmed, logs }, client);
      if (targetPlayerId && dirtyPlayers.has(targetPlayerId)) {
        await db.appendEvent(targetPlayerId, 'command', { command: trimmed, logs }, client);
      }

      return { status: 200, body: { logs } };
    });

    const status = outcome?.status ?? 500;
    const body = outcome?.body ?? { error: 'server error' };
    res.status(status).json(body);
  } catch (err) {
    console.error('command handler failed', err);
    res.status(500).json({ error: 'server error' });
  }
});

async function init() {
  await loadMap();
  await loadItems();
  await db.init();
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
  actionAtLevel
};
