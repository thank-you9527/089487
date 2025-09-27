/**
 * db.js — Postgres access layer for your MUD (players + events)
 */

const { Pool } = require('pg');
const { randomUUID, createHash } = require('crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

let pool;
if (connectionString.startsWith('pg-mem://')) {
  const { newDb } = require('pg-mem');
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  pool = new adapter.Pool();
} else {
  pool = new Pool({
    connectionString,
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
  });
}

function sanitizeSql(text = '') {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function slowThresholdFor(text = '') {
  if (/from\s+events/i.test(text) && /order\s+by\s+id\s+asc/i.test(text)) {
    return 500;
  }
  return 200;
}

function instrumentQuery(fn) {
  if (fn.__instrumented) return fn;
  const wrapped = async function instrumentedQuery(...args) {
    const start = Date.now();
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    try {
      return await fn.apply(this, args);
    } finally {
      const ms = Date.now() - start;
      const threshold = slowThresholdFor(text || '');
      if (ms > threshold) {
        console.warn('[slow-sql]', ms, sanitizeSql(text || ''));
      }
    }
  };
  wrapped.__instrumented = true;
  return wrapped;
}

pool.query = instrumentQuery(pool.query);
if (typeof pool.on === 'function') {
  pool.on('connect', client => {
    client.query = instrumentQuery(client.query);
  });
}

const toCamel = row => {
  if (!row) return row;
  const map = {
    day_age: 'dayAge',
    hp_max: 'hpMax',
    action_max: 'actionMax',
    exp_current: 'expCurrent',
    exp_max: 'expMax',
    bind_x: 'bindX',
    bind_y: 'bindY',
    bind_z: 'bindZ',
    last_hp_update: 'lastHpUpdate',
    last_action_update: 'lastActionUpdate'
  };
  const o = {};
  for (const k in row) o[map[k] || k] = row[k];
  return o;
};

const toSnake = obj => {
  const map = {
    dayAge: 'day_age',
    hpMax: 'hp_max',
    actionMax: 'action_max',
    expCurrent: 'exp_current',
    expMax: 'exp_max',
    bindX: 'bind_x',
    bindY: 'bind_y',
    bindZ: 'bind_z',
    lastHpUpdate: 'last_hp_update',
    lastActionUpdate: 'last_action_update'
  };
  const o = {};
  for (const k in obj) o[map[k] || k] = obj[k];
  return o;
};

const exec = client => client || pool;

async function init() {
  const ddl = `
  CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS players (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT '醒著',
    identity           TEXT NOT NULL DEFAULT '探求者',
    day_age            INT  NOT NULL DEFAULT 0,
    morality           INT  NOT NULL DEFAULT 50 CHECK (morality BETWEEN 0 AND 100),
    level              INT  NOT NULL DEFAULT 1,
    attack             INT  NOT NULL DEFAULT 10,
    hp                 INT  NOT NULL CHECK (hp >= 0),
    hp_max             INT  NOT NULL CHECK (hp_max > 0),
    action             INT  NOT NULL CHECK (action >= 0),
    action_max         INT  NOT NULL CHECK (action_max >= 0),
    exp_current        INT  NOT NULL DEFAULT 0,
    exp_max            INT  NOT NULL DEFAULT 100,
    x                  INT  NOT NULL,
    y                  INT  NOT NULL,
    z                  INT  NOT NULL,
    bind_x             INT,
    bind_y             INT,
    bind_z             INT,
    gold               INT  NOT NULL DEFAULT 0,
    dodge              INT  NOT NULL DEFAULT 3,
    inventory          JSONB NOT NULL DEFAULT '[]',
    last_hp_update     BIGINT NOT NULL,
    last_action_update BIGINT NOT NULL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT players_hp_range CHECK (hp <= hp_max),
    CONSTRAINT players_action_range CHECK (action <= action_max)
  );
  CREATE TABLE IF NOT EXISTS events (
    id         BIGSERIAL PRIMARY KEY,
    player_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_read    BOOLEAN NOT NULL DEFAULT FALSE
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id  TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_agent  TEXT,
    ip          TEXT,
    CONSTRAINT one_active_session UNIQUE (account_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);
  CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
  CREATE INDEX IF NOT EXISTS idx_players_pos ON players(x, y, z);
  CREATE INDEX IF NOT EXISTS idx_events_player ON events(player_id, is_read, id DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
  `;
  await pool.query(ddl);
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Failed to rollback transaction', rollbackErr);
    }
    throw e;
  } finally {
    client.release();
  }
}

function lockKeysFor(id) {
  const hash = createHash('sha1').update(String(id)).digest();
  const key1 = hash.readInt32BE(0);
  const key2 = hash.readInt32BE(4);
  return [key1, key2];
}

async function withPlayersTx(ids, fn) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('withPlayersTx requires at least one player id');
  }
  const uniqueIds = Array.from(new Set(ids.filter(Boolean))).sort();
  const client = await pool.connect();
  const locks = [];
  try {
    await client.query('BEGIN');
    for (const id of uniqueIds) {
      const [k1, k2] = lockKeysFor(id);
      await client.query('SELECT pg_advisory_lock($1,$2)', [k1, k2]);
      locks.push([k1, k2]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Failed to rollback player transaction', rollbackErr);
    }
    throw err;
  } finally {
    for (let i = locks.length - 1; i >= 0; i -= 1) {
      const [k1, k2] = locks[i];
      try {
        await client.query('SELECT pg_advisory_unlock($1,$2)', [k1, k2]);
      } catch (unlockErr) {
        console.error('Failed to unlock player transaction', unlockErr);
      }
    }
    client.release();
  }
}

async function withPlayerTx(playerId, fn) {
  if (!playerId) throw new Error('playerId is required for withPlayerTx');
  return withPlayersTx([playerId], fn);
}

function normalizeAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: row.created_at
  };
}

async function createAccount(username, passwordHash) {
  if (!username || !passwordHash) {
    throw new Error('username and passwordHash are required');
  }
  const id = randomUUID();
  try {
    const { rows } = await pool.query(
      'INSERT INTO accounts(id, username, password_hash) VALUES($1,$2,$3) RETURNING id, username, password_hash, created_at',
      [id, username, passwordHash]
    );
    return normalizeAccount(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('duplicate account');
      dup.code = '23505';
      throw dup;
    }
    throw err;
  }
}

async function findAccountByUsername(username) {
  if (!username) return null;
  const { rows } = await pool.query(
    'SELECT id, username, password_hash, created_at FROM accounts WHERE username=$1',
    [username]
  );
  if (rows.length === 0) return null;
  return normalizeAccount(rows[0]);
}

async function deleteAccount(id) {
  if (!id) return;
  await pool.query('DELETE FROM accounts WHERE id=$1', [id]);
}

async function getPlayer(id, client) {
  if (!id) return null;
  const { rows } = await exec(client).query('SELECT * FROM players WHERE id = $1', [id]);
  if (rows.length === 0) return null;
  return toCamel(rows[0]);
}

async function findPlayerByName(name, client) {
  if (!name) return null;
  const { rows } = await exec(client).query('SELECT * FROM players WHERE name=$1', [name]);
  if (rows.length === 0) return null;
  return toCamel(rows[0]);
}

async function findPlayersByNameInsensitive(name, client) {
  if (!name) return [];
  const { rows } = await exec(client).query(
    'SELECT * FROM players WHERE LOWER(name)=LOWER($1)',
    [name]
  );
  return rows.map(toCamel);
}

async function listPlayers(client) {
  const { rows } = await exec(client).query('SELECT * FROM players');
  return rows.map(toCamel);
}

async function upsertPlayer(p, client) {
  const s = toSnake(p);
  const cols = [
    'id','name','status','identity','day_age','morality','level','attack',
    'hp','hp_max','action','action_max','exp_current','exp_max',
    'x','y','z','bind_x','bind_y','bind_z','gold','dodge',
    'inventory','last_hp_update','last_action_update'
  ];
  const vals = cols.map(c => s[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
  const updates = cols
    .filter(c => c !== 'id')
    .map(c => `${c}=EXCLUDED.${c}`)
    .join(', ');
  const sql = `INSERT INTO players (${cols.join(',')}) VALUES (${placeholders})
               ON CONFLICT (id) DO UPDATE SET ${updates}
               RETURNING *`;
  const { rows } = await exec(client).query(sql, vals);
  return toCamel(rows[0]);
}

async function patchPlayer(id, patch, client) {
  const s = toSnake(patch);
  const entries = Object.entries(s);
  if (entries.length === 0) return getPlayer(id, client);
  const sets = entries.map(([k], i) => `${k}=$${i + 1}`).join(', ');
  const args = entries.map(([, v]) => v);
  args.push(id);
  const sql = `UPDATE players SET ${sets}, updated_at=now() WHERE id=$${args.length} RETURNING *`;
  const { rows } = await exec(client).query(sql, args);
  if (rows.length === 0) return null;
  return toCamel(rows[0]);
}

async function appendEvent(playerId, kind, payload, client) {
  const { rows } = await exec(client).query(
    'INSERT INTO events(player_id, kind, payload) VALUES($1,$2,$3) RETURNING *',
    [playerId, kind, payload]
  );
  return rows[0];
}

async function listEventsSince(playerId, sinceId = 0, limit = 200, client) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 0, 1), 200);
  const safeSince = Number.isFinite(Number(sinceId)) ? Number(sinceId) : 0;
  const { rows } = await exec(client).query(
    'SELECT * FROM events WHERE player_id=$1 AND id > $2 ORDER BY id ASC LIMIT $3',
    [playerId, safeSince, cappedLimit]
  );
  return rows;
}

async function getUnreadEvents(playerId, limit = 50, client) {
  const { rows } = await exec(client).query(
    'SELECT * FROM events WHERE player_id=$1 AND is_read=false ORDER BY id ASC LIMIT $2',
    [playerId, limit]
  );
  return rows;
}

async function markEventsRead(playerId, upToId, client) {
  await exec(client).query(
    'UPDATE events SET is_read=true WHERE player_id=$1 AND id <= $2 AND is_read=false',
    [playerId, upToId]
  );
  return true;
}

function sessionExpiration(meta = {}) {
  if (meta.expiresAt) return new Date(meta.expiresAt);
  return new Date(Date.now() + SESSION_TTL_MS);
}

async function createSession(accountId, meta = {}) {
  if (!accountId) throw new Error('accountId required');
  const sessionId = randomUUID();
  const expiresAt = sessionExpiration(meta);
  try {
    await pool.query(
      'INSERT INTO sessions(session_id, account_id, expires_at, user_agent, ip) VALUES($1,$2,$3,$4,$5)',
      [sessionId, accountId, expiresAt, meta.userAgent || null, meta.ip || null]
    );
    return { sessionId, expiresAt };
  } catch (err) {
    if (err.code === '23505') {
      const e = new Error('already logged in');
      e.code = 'ALREADY_LOGGED_IN';
      throw e;
    }
    throw err;
  }
}

async function replaceSession(accountId, meta = {}) {
  return withTx(async client => {
    await client.query('DELETE FROM sessions WHERE account_id=$1', [accountId]);
    const sessionId = randomUUID();
    const expiresAt = sessionExpiration(meta);
    await client.query(
      'INSERT INTO sessions(session_id, account_id, expires_at, user_agent, ip) VALUES($1,$2,$3,$4,$5)',
      [sessionId, accountId, expiresAt, meta.userAgent || null, meta.ip || null]
    );
    return { sessionId, expiresAt };
  });
}

async function getSession(sessionId) {
  if (!sessionId) return null;
  const { rows } = await pool.query('SELECT * FROM sessions WHERE session_id=$1', [sessionId]);
  if (rows.length === 0) return null;
  return rows[0];
}

async function deleteSession(sessionId) {
  if (!sessionId) return;
  await pool.query('DELETE FROM sessions WHERE session_id=$1', [sessionId]);
}

async function touchSession(sessionId) {
  if (!sessionId) return;
  await pool.query(
    "UPDATE sessions SET last_seen=now(), expires_at=now() + interval '7 days' WHERE session_id=$1",
    [sessionId]
  );
}

module.exports = {
  init,
  withTx,
  withPlayerTx,
  withPlayersTx,
  createAccount,
  findAccountByUsername,
  deleteAccount,
  getPlayer,
  findPlayerByName,
  findPlayersByNameInsensitive,
  listPlayers,
  upsertPlayer,
  patchPlayer,
  appendEvent,
  listEventsSince,
  getUnreadEvents,
  markEventsRead,
  createSession,
  replaceSession,
  getSession,
  deleteSession,
  touchSession,
  _pool: pool
};
