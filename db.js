/**
 * db.js — Postgres access layer for your MUD (players + events)
 * Usage:
 *   const db = require('./db');
 *   await db.init(); // optional if you run schema.sql separately
 *   const p = await db.getPlayer('alice');
 *   await db.upsertPlayer({...});
 */

const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const connectionString = process.env.DATABASE_URL;
const useMemorySessions = !connectionString;

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } // Render/Neon-friendly
    })
  : null;

const memorySessions = new Map();
const accountSessionIndex = new Map();

// -------- helpers: snake_case <-> camelCase --------
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

function sessionExpiration(meta = {}) {
  if (meta.expiresAt) return new Date(meta.expiresAt);
  return new Date(Date.now() + SESSION_TTL_MS);
}

function buildSessionRecord(sessionId, accountId, meta = {}) {
  const expiresAt = sessionExpiration(meta);
  const now = new Date();
  return {
    session_id: sessionId,
    account_id: accountId,
    issued_at: now,
    expires_at: expiresAt,
    last_seen: now,
    user_agent: meta.userAgent || null,
    ip: meta.ip || null
  };
}

// -------- migrations (optional) --------
async function init() {
  // Lightweight init: create tables if not exists (idempotent)
  if (!pool) return;
  const ddl = `
  CREATE TABLE IF NOT EXISTS players (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT '醒著',
    identity           TEXT NOT NULL DEFAULT '探求者',
    day_age            INT  NOT NULL DEFAULT 0,
    morality           INT  NOT NULL DEFAULT 50 CHECK (morality BETWEEN 0 AND 100),
    level              INT  NOT NULL DEFAULT 1,
    attack             INT  NOT NULL DEFAULT 10,
    hp                 INT  NOT NULL,
    hp_max             INT  NOT NULL,
    action             INT  NOT NULL,
    action_max         INT  NOT NULL,
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
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
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
  CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
  CREATE INDEX IF NOT EXISTS idx_events_player ON events(player_id, is_read, id DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
  `;
  await pool.query(ddl);
}

// -------- transactions --------
async function withTx(fn) {
  if (!pool) throw new Error('Database connection not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// -------- players --------
async function getPlayer(id, client = pool) {
  if (!client) throw new Error('Database connection not configured');
  const { rows } = await client.query('SELECT * FROM players WHERE id = $1', [id]);
  return toCamel(rows[0] || null);
}

async function upsertPlayer(p, client = pool) {
  if (!client) throw new Error('Database connection not configured');
  const s = toSnake(p);
  const cols = [
    'id','name','status','identity','day_age','morality','level','attack',
    'hp','hp_max','action','action_max','exp_current','exp_max',
    'x','y','z','bind_x','bind_y','bind_z','gold','dodge',
    'inventory','last_hp_update','last_action_update'
  ];
  const vals = cols.map(c => s[c]);
  const placeholders = cols.map((_,i)=>`$${i+1}`).join(',');
  const updates = cols.filter(c => c!=='id').map((c,i)=>`${c}=EXCLUDED.${c}`).join(', ');
  const sql = `INSERT INTO players (${cols.join(',')}) VALUES (${placeholders})
               ON CONFLICT (id) DO UPDATE SET ${updates}
               RETURNING *`;
  const { rows } = await client.query(sql, vals);
  return toCamel(rows[0]);
}

async function patchPlayer(id, patch, client = pool) {
  if (!client) throw new Error('Database connection not configured');
  const s = toSnake(patch);
  const entries = Object.entries(s);
  if (!entries.length) return getPlayer(id, client);
  const sets = entries.map(([k],i)=>`${k}=$${i+1}`).join(', ');
  const args = entries.map(([,v])=>v);
  args.push(id);
  const sql = `UPDATE players SET ${sets}, updated_at=now() WHERE id=$${args.length} RETURNING *`;
  const { rows } = await client.query(sql, args);
  return toCamel(rows[0]);
}

// -------- events --------
async function appendEvent(playerId, kind, payload, client = pool) {
  if (!client) throw new Error('Database connection not configured');
  const { rows } = await client.query(
    'INSERT INTO events(player_id, kind, payload) VALUES($1,$2,$3) RETURNING *',
    [playerId, kind, payload]
  );
  return rows[0];
}

// -------- sessions --------
async function createSession(accountId, meta = {}) {
  if (!accountId) throw new Error('accountId required');
  if (useMemorySessions) {
    if (accountSessionIndex.has(accountId)) {
      const err = new Error('already logged in');
      err.code = 'ALREADY_LOGGED_IN';
      throw err;
    }
    const sessionId = randomUUID();
    const record = buildSessionRecord(sessionId, accountId, meta);
    memorySessions.set(sessionId, record);
    accountSessionIndex.set(accountId, sessionId);
    return { sessionId, expiresAt: record.expires_at };
  }
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
  if (useMemorySessions) {
    const existingId = accountSessionIndex.get(accountId);
    if (existingId) {
      memorySessions.delete(existingId);
      accountSessionIndex.delete(accountId);
    }
    return createSession(accountId, meta);
  }
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
  if (useMemorySessions) {
    const record = memorySessions.get(sessionId);
    if (!record) return null;
    if (record.expires_at && record.expires_at <= new Date()) {
      memorySessions.delete(sessionId);
      if (record.account_id) accountSessionIndex.delete(record.account_id);
      return null;
    }
    return { ...record };
  }
  const { rows } = await pool.query('SELECT * FROM sessions WHERE session_id=$1', [sessionId]);
  if (rows.length === 0) return null;
  return rows[0];
}

async function deleteSession(sessionId) {
  if (!sessionId) return;
  if (useMemorySessions) {
    const record = memorySessions.get(sessionId);
    if (record) {
      memorySessions.delete(sessionId);
      if (record.account_id) accountSessionIndex.delete(record.account_id);
    }
    return;
  }
  await pool.query('DELETE FROM sessions WHERE session_id=$1', [sessionId]);
}

async function touchSession(sessionId) {
  if (!sessionId) return;
  if (useMemorySessions) {
    const record = memorySessions.get(sessionId);
    if (record) {
      record.last_seen = new Date();
      record.expires_at = new Date(Date.now() + SESSION_TTL_MS);
      memorySessions.set(sessionId, record);
    }
    return;
  }
  await pool.query(
    "UPDATE sessions SET last_seen=now(), expires_at=now() + interval '7 days' WHERE session_id=$1",
    [sessionId]
  );
}

async function getUnreadEvents(playerId, limit = 50, client = pool) {
  if (!client) throw new Error('Database connection not configured');
  const { rows } = await client.query(
    'SELECT * FROM events WHERE player_id=$1 AND is_read=false ORDER BY id ASC LIMIT $2',
    [playerId, limit]
  );
  return rows;
}

async function markEventsRead(playerId, upToId, client = pool) {
  if (!client) throw new Error('Database connection not configured');
  await client.query(
    'UPDATE events SET is_read=true WHERE player_id=$1 AND id <= $2 AND is_read=false',
    [playerId, upToId]
  );
  return true;
}

module.exports = {
  init, withTx,
  getPlayer, upsertPlayer, patchPlayer,
  appendEvent, getUnreadEvents, markEventsRead,
  createSession,
  replaceSession,
  getSession,
  deleteSession,
  touchSession,
  _pool: pool,
  _memory: { memorySessions, accountSessionIndex, useMemorySessions }
};
