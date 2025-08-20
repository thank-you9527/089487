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
  res.json({
    name: c.name,
    dayAge: c.dayAge,
    level: c.level,
    identity: c.identity,
    morality: c.morality,
    action: c.action,
    attack: c.attack,
    hp: c.hp,
    exp: c.exp,
    position: c.position,
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
  const character = {
    name,
    dayAge: 0,
    level: 1,
    identity: '探求者',
    morality: Math.floor(Math.random() * 41) + 30,
    action: 100,
    attack: 10,
    hp: 100,
    exp: { current: 0, max: 10 },
    position: { x: 0, y: 0, z: 0 },
    bio: ''
  };
  user.character = character;
  saveUsers();
  res.json(character);
});

function getLocationInfo(pos) {
  const key = `${pos.x},${pos.y},${pos.z}`;
  const loc = worldMap[key];
  if (loc) {
    return {
      name: loc.name,
      level: loc.level || '',
      owner: loc.owner || '無所屬',
      population: (loc.population || 0) + 1,
      description: loc.description || '這個人很懶，什麼都沒寫。',
      address: pos
    };
  }
  return {
    name: '未開拓之地',
    level: '',
    owner: '無所屬',
    population: 1,
    description: '嗚啦呀哈呀哈嗚啦',
    address: pos
  };
}

function formatLocationInfo(info) {
  return `地區名稱：${info.name}\n等級：${info.level}\n擁有者：${info.owner}\n地區人數：${info.population}\n簡介：${info.description}\n地址：(${info.address.x},${info.address.y},${info.address.z})`;
}

app.post('/api/command', (req, res) => {
  const { username, command } = req.body;
  const user = users.find(u => u.username === username);
  if (!user || !user.character) {
    return res.status(400).json({ error: 'character not found' });
  }
  const c = user.character;
  const cmd = command.trim();
  const logs = [];

  function move(dx, dy, dz, cost, verb) {
    const newPos = { x: c.position.x + dx, y: c.position.y + dy, z: c.position.z + dz };
    if (newPos.x < -90 || newPos.x > 90 || newPos.y < -180 || newPos.y > 180 || newPos.z < -100 || newPos.z > 100) {
      logs.push('無法移動，已達邊界');
      return;
    }
    c.position = newPos;
    if (cost) c.action = Math.max(0, c.action - cost);
    const info = getLocationInfo(newPos);
    logs.push(`${c.name}${verb}移動，抵達了${info.name}`);
    logs.push('');
    logs.push(formatLocationInfo(info));
  }

  switch (cmd) {
    case 'help':
      logs.push(
        '指令列表：\n看看 - 查看玩家資訊\nhelp - 顯示所有指令\n看路 - 檢視當前位置資訊\n前進 - y座標+1\n後退 - y座標-1\n左轉 - x座標-1\n右轉 - x座標+1\n打老鷹 - z座標+1\n挖地瓜 - z座標-1'
      );
      break;
    case '看看':
      logs.push(
        `名稱：${c.name}\n日齡：${c.dayAge}\n等級：${c.level}\n身份：${c.identity}\n道德：${c.morality}\n行動值：${c.action}\n攻擊力：${c.attack}\n血量：${c.hp}\n經驗值：${c.exp.current}/${c.exp.max}\n位置：(${c.position.x},${c.position.y},${c.position.z})\n簡介：${c.bio || ''}`
      );
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
  saveUsers();
  res.json({ logs });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
