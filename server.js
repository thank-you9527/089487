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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
