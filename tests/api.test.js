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
  test('registers a new user', async () => {
    const username = `user${Date.now()}`;
    const res = await request(app)
      .post('/api/register')
      .send({ username, password: 'Password!1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});
