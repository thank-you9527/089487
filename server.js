const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const dataPath = path.join(__dirname, 'data', 'users.json');
let users = [];
if (fs.existsSync(dataPath)) {
  users = JSON.parse(fs.readFileSync(dataPath));
}
function saveUsers() {
  fs.writeFileSync(dataPath, JSON.stringify(users, null, 2));
}

const mapPath = path.join(__dirname, 'data', 'map.json');
let worldMap = {};
if (fs.existsSync(mapPath)) {
  worldMap = JSON.parse(fs.readFileSync(mapPath));
} else {
  fs.writeFileSync(mapPath, JSON.stringify({}));
}
function saveMap() {
  fs.writeFileSync(mapPath, JSON.stringify(worldMap, null, 2));
}

const userRegex = /^[A-Za-z0-9!@#$%^&*]{5,20}$/;
const passRegex = /^[A-Za-z0-9!@#$%^&*]{8,20}$/;
const nameRegex = /^[A-Za-z0-9\u4E00-\u9FFF.,•，。_]{1,10}$/;
const areaNameRegex = nameRegex;

// attribute growth constants
const MAX_HP = 9487000;
const MAX_ATK = 8700000;
const MAX_EXP = 9487000;
const MAX_GAIN = 870000;
const K = 0.00092;
const CENTER = 2500;

function hpAtLevel(level) {
  return Math.round(MAX_HP / (1 + Math.exp(-K * (level - CENTER))));
}

function attackAtLevel(level) {
  return Math.round(10 + (MAX_ATK - 10) / (1 + Math.exp(-K * (level - CENTER))));
}

function expMaxAtLevel(level) {
  return Math.round(MAX_EXP / (1 + Math.exp(-K * (level - CENTER))));
}

function expGainForLevel(level) {
  return Math.round(MAX_GAIN / (1 + Math.exp(-K * (level - CENTER))));
}

function actionAtLevel(level) {
  return Math.round(100 + (10000 - 100) * (level - 1) / 4999);
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

function pickupItems(c) {
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
  saveMap();
}

function handleDeath(c, logs) {
  const deathPos = { ...c.position };
  if (c.inventory && c.inventory.length > 0 && Math.random() < 0.5) {
    const idx = Math.floor(Math.random() * c.inventory.length);
    const item = c.inventory.splice(idx, 1)[0];
    const key = `${deathPos.x},${deathPos.y},${deathPos.z}`;
    const loc = worldMap[key] || {};
    loc.items = loc.items || [];
    loc.items.push({ ...item, owner: c.name });
    worldMap[key] = loc;
    saveMap();
    logs.push('你掉落了一件道具');
  }
  const respawn = c.bindPoint || { x: 0, y: 0, z: 0 };
  c.position = { ...respawn };
  c.hp = c.maxHp * 0.05;
  c.lastHpUpdate = Date.now();
  logs.push(`${c.name}死亡並在(${c.position.x},${c.position.y},${c.position.z})復活`);
  pickupItems(c);
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

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!userRegex.test(username) || !passRegex.test(password)) {
    return res.status(400).json({ error: 'invalid input' });
  }
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'user exists' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  users.push({ username, passwordHash });
  saveUsers();
  res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  res.json({ success: true });
});

app.get('/api/character', (req, res) => {
  const { username } = req.query;
  const user = users.find(u => u.username === username);
  if (!user || !user.character) {
    return res.status(404).json({ error: 'not found' });
  }
  const c = user.character;
  updateStats(c);
  regen(c);
  saveUsers();
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

app.post('/api/character', (req, res) => {
  const { username, name } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(400).json({ error: 'user not found' });
  if (!nameRegex.test(name)) {
    return res.status(400).json({ error: 'invalid name' });
  }
  if (name === username) {
    return res.status(400).json({ error: 'name cannot equal username' });
  }
  if (bcrypt.compareSync(name, user.passwordHash)) {
    return res.status(400).json({ error: 'name cannot equal password' });
  }
  if (user.character) {
    return res.status(400).json({ error: 'character exists' });
  }
  const maxHp = hpAtLevel(1);
  const maxAction = actionAtLevel(1);
  const character = {
    name,
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
    inventory: [],
    bindPoint: null,
    lastHpUpdate: Date.now()
  };
  user.character = character;
  saveUsers();
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
  return `名稱：${ch.name}\n日齡：${fmt(ch.dayAge)}\n等級：${fmt(ch.level)}\n身份：${ch.identity}\n道德：${fmt(ch.morality)}\n行動值：${fmt(ch.action)}\n攻擊力：${fmt(ch.attack)}\n血量：${fmt(ch.hp)}\n經驗值：${fmt(ch.exp.current)}/${fmt(ch.exp.max)}\n位置：(${ch.position.x},${ch.position.y},${ch.position.z})\n簡介：${ch.bio || ''}`;
}

app.post('/api/command', (req, res) => {
  const { username, command } = req.body;
  const user = users.find(u => u.username === username);
  if (!user || !user.character) {
    return res.status(400).json({ error: 'character not found' });
  }
  const c = user.character;
  updateStats(c);
  regen(c);
  pickupItems(c);
  const cmd = command.trim();
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
    areaNameRegex
  };

  const dispatch = require('./commands');
  dispatch(cmd, context, logs);
  saveUsers();
  res.json({ logs });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
