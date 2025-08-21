const request = require('supertest');
const path = require('path');
const fs = require('fs').promises;
const { app, init } = require('../server');

beforeAll(async () => {
  await init();
});

afterAll(async () => {
  const dataPath = path.join(__dirname, '..', 'data', 'users.json');
  await fs.writeFile(dataPath, '[]');
});

describe('API routes', () => {
  test('register, login, and access protected routes', async () => {
    const username = `user${Date.now()}`;
    const password = 'Password!1';
    const cap = await request(app).get('/api/captcha');
    const { id, text } = cap.body;
    const reg = await request(app)
      .post('/api/register')
      .send({ username, password, captchaId: id, captcha: text });
    expect(reg.status).toBe(200);
    const login = await request(app).post('/api/login').send({ username, password });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeDefined();
    const token = login.body.token;
    const create = await request(app)
      .post('/api/character')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hero' });
    expect(create.status).toBe(200);
    const get = await request(app)
      .get('/api/character')
      .set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(200);
    const unauthorized = await request(app).get('/api/character');
    expect(unauthorized.status).toBe(401);
  });
});
