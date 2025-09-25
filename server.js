const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const db = require('./db');
const dispatchCommands = require('./commands');

const app = express();
app.use(cors());
app.use(express.json());
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});
app.use(express.static(__dirname));

const dataPath = path.join(__dirname, 'data', 'users.json');
let users = [];
async function loadUsers() {
  try {
    const data = await fs.readFile(dataPath, 'utf8');
    users = JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      users = [];
      await fs.writeFile(dataPath, JSON.stringify(users, null, 2));
    } else {
      console.error('Failed to read users', err);
      users = [];
    }
  }
}
let writeLock = Promise.resolve();
function scheduleWrite(task) {
  const next = writeLock.then(() => task());
  writeLock = next.catch(() => {});
  return next;
}
async function saveUsers() {
  return scheduleWrite(async () => {
    try {
      await fs.writeFile(dataPath, JSON.stringify(users, null, 2));
    } catch (err) {
      console.error('Failed to save users', err);
    }
  });
}

const mapPath = path.join(__dirname, 'data', 'map.json');
let worldMap = {};
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
  return scheduleWrite(async () => {
    try {
      await fs.writeFile(mapPath, JSON.stringify(worldMap, null, 2));
    } catch (err) {
      console.error('Failed to save map', err);
    }
  });
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
    const { sub, jti } = payload;
    if (!sub || !jti) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'unauthorized' });
    }
    const session = await db.getSession(jti);
    if (!session) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'session-gone' });
    }
    req.user = { id: sub, sessionId: jti };
    req.username = sub;
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

async function handleDeath(c, logs) {
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
}

function findCharacterByName(name) {
  return users.find(u => u.character && u.character.name === name)?.character;
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
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'user exists' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  users.push({ username, passwordHash });
  await saveUsers();
  res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const userAgent = req.get('user-agent') || null;
  const ipHeader = req.headers['x-forwarded-for'];
  const ip = Array.isArray(ipHeader)
    ? ipHeader[0]
    : typeof ipHeader === 'string'
    ? ipHeader.split(',')[0].trim()
    : req.ip;
  try {
    const { sessionId } = await db.createSession(username, { userAgent, ip });
    const token = jwt.sign({ sub: username, jti: sessionId }, SECRET, { expiresIn: '7d' });
    res.cookie('token', token, COOKIE_WITH_MAX_AGE);
    res.json({ ok: true });
  } catch (err) {
    if (err && err.code === 'ALREADY_LOGGED_IN') {
      return res.status(409).json({ error: 'already-logged-in' });
    }
    console.error('createSession failed', err);
    return res.status(500).json({ error: 'internal error' });
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
  const user = users.find(u => u.username === req.username);
  if (!user || !user.character) {
    return res.status(404).json({ error: 'not found' });
  }
  const c = user.character;
  updateStats(c);
  regen(c);
  await saveUsers();
  res.json({
    name: c.name,
    dayAge: c.dayAge,
    level: c.level,
    identity: c.identity,
    morality: fmt(c.morality),
    action: fmt(c.action),
    attack: fmt(c.attack),
    hp: fmt(c.hp),
    exp: { current: fmt(c.exp.current), max: fmt(c.exp.max) },
    position: { x: c.position.x, y: c.position.y, z: c.position.z },
    bio: c.bio || '看屁看'
  });
});

app.post('/api/character', auth, async (req, res) => {
  const { name } = req.body;
  const user = users.find(u => u.username === req.username);
  if (!user) return res.status(400).json({ error: 'user not found' });
  if (!nameRegex.test(name)) {
    return res.status(400).json({ error: 'invalid name' });
  }
  if (name === req.username) {
    return res.status(400).json({ error: 'name cannot equal username' });
  }
  try {
    if (await bcrypt.compare(name, user.passwordHash)) {
      return res.status(400).json({ error: 'name cannot equal password' });
    }
  } catch (err) {
    console.error('password comparison failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
  if (user.character) {
    return res.status(400).json({ error: 'character exists' });
  }
  const maxHp = hpAtLevel(1);
  const maxAction = actionAtLevel(1);
  const character = {
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
    lastHpUpdate: Date.now(),
    lastActionUpdate: Date.now()
  };
  user.character = character;
  await saveUsers();
  res.json(character);
});

function getLocationInfo(pos) {
  const key = `${pos.x},${pos.y},${pos.z}`;
  const loc = worldMap[key];
  const playersHere = users.filter(
    u => u.character && u.character.position.x === pos.x && u.character.position.y === pos.y && u.character.position.z === pos.z
  ).length;
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

app.post('/api/command', auth, async (req, res) => {
  const { command } = req.body || {};
  const user = users.find(u => u.username === req.username);
  if (!user || !user.character) {
    return res.status(400).json({ error: 'character not found' });
  }
  const trimmed = typeof command === 'string' ? command.trim() : '';
  try {
    const result = await db.withPlayerTx(req.username, async client => {
      reviveMonsters();
      const c = user.character;
      updateStats(c);
      regen(c);
      await pickupItems(c);
      const cmd = trimmed;
      if (c.status === '鼠了' && c.hp > 0) c.status = '醒著';
      if (c.status === '眼睛閉著' && cmd !== '歐歐睏') c.status = '醒著';
      const logs = [];

      const context = {
        c,
        users,
        worldMap,
        saveMap,
        getLocationInfo,
        formatLocationInfo,
        formatCharacterInfo,
        findCharacterByName,
        findMonsterByName,
        handleDeath,
        pickupItems,
        attackAtLevel,
        hpAtLevel,
        expGainForLevel,
        fmt,
        areaNameRegex,
        monsterNameRegex,
        monsterDrop,
        dbClient: client
      };

      await dispatchCommands(cmd, context, logs);
      await saveUsers();
      if (client) {
        try {
          await db.appendEvent(req.username, 'command', { command: cmd, logs }, client);
        } catch (eventErr) {
          console.error('appendEvent failed', eventErr);
        }
      }
      return { logs };
    });

    res.json(result);
  } catch (err) {
    console.error('command handler failed', err);
    res.status(500).json({ error: 'server error' });
  }
});

async function init() {
  await loadUsers();
  await loadMap();
  await loadItems();
  try {
    await db.init();
  } catch (err) {
    console.warn('Skipping database init:', err.message);
  }
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
