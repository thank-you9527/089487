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

  function move(dx, dy, dz, cost, verb) {
    const newPos = { x: c.position.x + dx, y: c.position.y + dy, z: c.position.z + dz };
    if (newPos.x < -90 || newPos.x > 90 || newPos.y < -180 || newPos.y > 180 || newPos.z < -100 || newPos.z > 100) {
      logs.push('無法移動，已達邊界');
      return;
    }
    c.position = newPos;
    pickupItems(c);
    if (cost) c.action = Math.max(0, c.action - cost);
    const info = getLocationInfo(newPos);
    logs.push(`${c.name}${verb}移動，抵達了${info.name}`);
    logs.push('');
    logs.push(formatLocationInfo(info));
  }

  if (cmd.startsWith('佔領/')) {
    const areaName = cmd.split('/')[1];
    c.action = Math.max(0, c.action - 1);
    const info = getLocationInfo(c.position);
    if (!areaName || !areaNameRegex.test(areaName) || info.owner !== '無所屬' || (info.name !== '未開拓之地' && info.name !== '荒山野嶺')) {
      logs.push('無法佔領');
    } else {
      let chance = 1;
      if (c.level >= 11 && c.level <= 50) chance = 0.9;
      else if (c.level <= 200) chance = 0.8;
      else if (c.level <= 450) chance = 0.7;
      else if (c.level >= 451) chance = 0.65;
      if (Math.random() < chance) {
        const key = `${c.position.x},${c.position.y},${c.position.z}`;
        const maxLv = Math.max(1, Math.floor(c.level / 10));
        const newLevel = Math.floor(Math.random() * maxLv) + 1;
        const existing = worldMap[key] || {};
        worldMap[key] = {
          name: areaName,
          owner: c.name,
          level: newLevel,
          description: existing.description || '',
          monsters: existing.monsters || [],
          npcs: existing.npcs || []
        };
        if (Math.random() < 0.05) worldMap[key].returnMark = true;
        saveMap();
        logs.push(formatLocationInfo(getLocationInfo(c.position)));
      } else {
        logs.push('啪，沒了');
      }
    }
  } else if (cmd.startsWith('看看/')) {
    const targetName = cmd.split('/')[1];
    if (!targetName) {
      logs.push('沒有欸你要不要再確認看看');
    } else {
      const targetChar = findCharacterByName(targetName);
      if (targetChar) {
        logs.push(formatCharacterInfo(targetChar));
      } else {
        const foundMonster = findMonsterByName(targetName);
        if (foundMonster) {
          const m = foundMonster.monster;
          const pos = foundMonster.location.split(',').map(Number);
          logs.push(
            `名稱：${m.name}\n等級：${fmt(m.level)}\n攻擊力：${fmt(m.attack)}\n血量：${fmt(m.hp)}\n位置：(${pos[0]},${pos[1]},${pos[2]})`
          );
        } else {
          logs.push('沒有欸你要不要再確認看看');
        }
      }
    }
  } else if (cmd.startsWith('孵化/')) {
    const mName = cmd.split('/')[1];
    c.action = Math.max(0, c.action - 1);
    const key = `${c.position.x},${c.position.y},${c.position.z}`;
    const loc = worldMap[key];
    if (!mName || !loc || loc.owner !== c.name) {
      logs.push('你要不要看看你現在在哪裡？');
    } else {
      const rl = loc.level || 1;
      const base = rl * 10;
      let delta;
      if (rl <= 10) delta = 5;
      else if (rl <= 50) delta = 10;
      else if (rl <= 150) delta = 150;
      else if (rl <= 300) delta = 430;
      else delta = 500;
      let min = base - delta;
      let max = base + delta;
      min = Math.max(1, min);
      max = Math.min(5000, max);
      const lvl = Math.floor(Math.random() * (max - min + 1)) + min;
      const monster = {
        name: mName,
        level: lvl,
        attack: attackAtLevel(lvl),
        hp: hpAtLevel(lvl),
        exp: expGainForLevel(lvl)
      };
      loc.monsters = loc.monsters || [];
      loc.monsters.push(monster);
      saveMap();
      logs.push(`在${loc.name}孵化出${mName}（等級${fmt(lvl)}）`);
    }
  } else if (cmd === '歐歐睏') {
    const info = getLocationInfo(c.position);
    if (info.returnMark) {
      c.bindPoint = { ...c.position };
      logs.push('靈魂綁定完成');
    } else {
      logs.push('你要確定欸');
    }
  } else if (cmd === '查看家當') {
    const items = c.inventory || [];
    if (items.length === 0) {
      logs.push(`${c.name}的所有家當！\n這裡什麼都沒有`);
    } else {
      const lines = [`${c.name}的所有家當！`];
      items.forEach((it, i) => lines.push(`${i + 1}.${it.name}`));
      logs.push(lines.join('\n'));
    }
  } else if (cmd.startsWith('查看家當/')) {
    const name = cmd.split('/')[1];
    const items = c.inventory || [];
    const item = items.find(it => it.name === name);
    if (item) {
      logs.push(`${item.name}（等級${fmt(item.level)}）`);
    } else {
      logs.push('醒？');
    }
  } else if (cmd === '歐拉' || cmd.startsWith('歐拉/')) {
    const targeted = cmd.startsWith('歐拉/');
    const cost = targeted ? 10 : 1;
    c.action = Math.max(0, c.action - cost);
    const key = `${c.position.x},${c.position.y},${c.position.z}`;
    const loc = worldMap[key] || {};
    let target;
    function resolveAttack(tgt, tgtType) {
      const successChance = Math.min(100, c.morality + 10);
      if (Math.random() * 100 >= successChance) {
        logs.push('攻擊失敗');
        return;
      }
      let dodge = 0;
      if (tgtType === 'player') dodge = tgt.dodge || 3;
      if (Math.random() * 100 < dodge) {
        logs.push(`啊！${tgt.name}抖了兩下，閃過了${c.name}的一擊！`);
        return;
      }
      const damage = c.attack;
      tgt.hp = Math.max(0, (tgt.hp || 0) - damage);
      logs.push(`${c.name}攻擊了${tgt.name}，造成${fmt(damage)}傷害`);
      if (tgt.hp <= 0) {
        logs.push(`${tgt.name}被擊敗了`);
        if (tgtType === 'player') handleDeath(tgt, logs);
      }
    }
    if (targeted) {
      const name = cmd.split('/')[1];
      if (!loc.monsters) loc.monsters = [];
      target = loc.monsters.find(m => m.name === name);
      if (!target) {
        logs.push('你找誰？');
      } else {
        resolveAttack(target, 'monster');
        if (loc.monsters) loc.monsters = loc.monsters.filter(m => m.hp > 0);
      }
    } else {
      const candidates = [];
      if (Array.isArray(loc.monsters)) {
        for (const m of loc.monsters) candidates.push({ type: 'monster', obj: m });
      }
      for (const u of users) {
        const ch = u.character;
        if (ch && ch !== c && ch.position.x === c.position.x && ch.position.y === c.position.y && ch.position.z === c.position.z) {
          candidates.push({ type: 'player', obj: ch });
        }
      }
      if (candidates.length === 0) {
        logs.push('沒有可以攻擊的目標');
      } else {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        target = pick.obj;
        resolveAttack(target, pick.type);
        if (pick.type === 'monster' && loc.monsters) loc.monsters = loc.monsters.filter(m => m.hp > 0);
      }
    }
    saveMap();
  } else {
    switch (cmd) {
      case 'help':
        logs.push(
          '指令列表：\n看看 - 查看玩家資訊\n看看/名稱 - 查詢其他單位\n佔領/地名 - 命名並佔領地區\n孵化/怪物名稱 - 在己方地區創建怪物\n歐歐睏 - 在有回歸標記的地區綁定復活點\n查看家當 - 顯示背包\n查看家當/道具名稱 - 查詢道具資訊\n歐拉 - 隨機攻擊當前單位\n歐拉/怪物名稱 - 指定攻擊怪物\nhelp - 顯示所有指令\n看路 - 檢視當前位置資訊\n前進 - y座標+1\n後退 - y座標-1\n左轉 - x座標-1\n右轉 - x座標+1\n打老鷹 - z座標+1\n挖地瓜 - z座標-1'
        );
        break;
      case '看看':
        logs.push(formatCharacterInfo(c));
        break;
      case '看路':
        logs.push(formatLocationInfo(getLocationInfo(c.position)));
        break;
      case '前進':
        move(0, 1, 0, 1, '往前');
        break;
      case '後退':
        move(0, -1, 0, 1, '往後');
        break;
      case '左轉':
        move(-1, 0, 0, 1, '往左');
        break;
      case '左轉打方向燈':
        move(-1, 0, 0, 0, '往左');
        break;
      case '右轉':
        move(1, 0, 0, 1, '往右');
        break;
      case '右轉打方向燈':
        move(1, 0, 0, 0, '往右');
        break;
      case '打老鷹':
        move(0, 0, 1, 1, '往上');
        break;
      case '挖地瓜':
        move(0, 0, -1, 1, '往下');
        break;
      default:
        logs.push(cmd);
    }
  }
  saveUsers();
  res.json({ logs });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
