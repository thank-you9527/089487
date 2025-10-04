process.env.JWT_SECRET = 'test-secret';
process.env.DATABASE_URL = 'pg-mem://tests';
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { app, init } = require('../server');

beforeAll(async () => {
  await init();
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
    expect(login.status).toBe(204);
    const setCookie = login.headers['set-cookie'][0];
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    const cookie = setCookie.split(';')[0];
    const create = await request(app)
      .post('/api/character')
      .set('Cookie', cookie)
      .send({ name: 'Hero' });
    expect(create.status).toBe(200);
    const get = await request(app)
      .get('/api/character')
      .set('Cookie', cookie);
    expect(get.status).toBe(200);
    const unauthorized = await request(app).get('/api/character');
    expect(unauthorized.status).toBe(401);
  });

  test('action regenerates over time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2020-01-01'));
    const username = `user${Date.now()}`;
    const password = 'Password!1';
    const cap = await request(app).get('/api/captcha');
    const { id, text } = cap.body;
    await request(app)
      .post('/api/register')
      .send({ username, password, captchaId: id, captcha: text });
    const login = await request(app).post('/api/login').send({ username, password });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    await request(app)
      .post('/api/character')
      .set('Cookie', cookie)
      .send({ name: 'Hero' });

    await request(app)
      .post('/api/command')
      .set('Cookie', cookie)
      .send({ command: '前進' });

    jest.setSystemTime(new Date(Date.now() + 60 * 1000));
    const get = await request(app)
      .get('/api/character')
      .set('Cookie', cookie);
    expect(get.body.action).toBe(100);
    jest.useRealTimers();
  });
});

test('enforces single session and expires missing sessions', async () => {
  const username = `solo${Date.now()}`;
  const password = 'Password!1';
  const cap = await request(app).get('/api/captcha');
  const { id, text } = cap.body;
  await request(app)
    .post('/api/register')
    .send({ username, password, captchaId: id, captcha: text });

  const login1 = await request(app).post('/api/login').send({ username, password });
  expect(login1.status).toBe(204);
  const cookie1Header = login1.headers['set-cookie'][0];
  const cookie1 = cookie1Header.split(';')[0];

  const login2 = await request(app).post('/api/login').send({ username, password });
  expect(login2.status).toBe(409);
  expect(login2.body).toEqual({ error: 'already-logged-in' });

  const logout = await request(app).post('/api/logout').set('Cookie', cookie1);
  expect(logout.status).toBe(200);

  const login3 = await request(app).post('/api/login').send({ username, password });
  expect(login3.status).toBe(204);
  const cookie2Header = login3.headers['set-cookie'][0];
  const cookie2 = cookie2Header.split(';')[0];

  await request(app)
    .post('/api/character')
    .set('Cookie', cookie2)
    .send({ name: 'Hero' });

  const token = cookie2.split('=')[1];
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  await db.deleteSession(payload.jti);

  const command = await request(app)
    .post('/api/command')
    .set('Cookie', cookie2)
    .send({ command: '前進' });
  expect(command.status).toBe(401);
  expect(command.body).toEqual({ error: 'unauthorized' });
});
