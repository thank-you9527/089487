/**
 * db.js — Postgres access layer for your MUD (players + events)
 */

const { Pool } = require('pg');
const { randomUUID, createHash } = require('crypto');
const { canonicalize } = require('./lib/names');

const DEFAULT_SESSION_TTL_HOURS = 24 * 7; // 7 days
const SESSION_TTL_HOURS = Math.max(1, Number(process.env.SESSION_TTL_HOURS ?? DEFAULT_SESSION_TTL_HOURS));
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;

const DEFAULT_IDLE_TIMEOUT_SEC = 30 * 60; // 30 minutes
const SESSION_IDLE_TIMEOUT_SEC = Math.max(0, Number(process.env.SESSION_IDLE_TIMEOUT_SEC ?? DEFAULT_IDLE_TIMEOUT_SEC));
const SESSION_IDLE_TIMEOUT_MS = SESSION_IDLE_TIMEOUT_SEC * 1000;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

const IS_PG_MEM = connectionString.startsWith('pg-mem://');

let pool;
if (IS_PG_MEM) {
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

const itemFieldMap = {
  base_name: 'baseName',
  base_name_norm: 'baseNameNorm',
  maker_id: 'makerId',
  owner_id: 'ownerId',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  deleted_at: 'deletedAt'
};

function toCamelItem(row) {
  if (!row) return null;
  const result = { id: row.id, prefix: row.prefix, level: row.level, name: row.base_name };
  for (const key in row) {
    if (key in itemFieldMap) {
      result[itemFieldMap[key]] = row[key];
    }
  }
  if (row.effects && typeof row.effects === 'object') {
    result.effects = row.effects;
  } else if (typeof row.effects === 'string') {
    try {
      result.effects = JSON.parse(row.effects);
    } catch {
      result.effects = {};
    }
  } else {
    result.effects = {};
  }
  return result;
}

const exec = client => client || pool;

async function init() {
  if (!IS_PG_MEM) {
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    } catch (err) {
      if (err && err.code !== '42501' && err.code !== '42704') {
        console.warn('Failed to ensure pgcrypto extension', err.message);
      }
    }
  }
  const itemIdDefault = IS_PG_MEM ? '' : ' DEFAULT gen_random_uuid()';
  const ddl = `
  CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    username_norm TEXT NOT NULL,
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
  CREATE TABLE IF NOT EXISTS items (
    id             UUID PRIMARY KEY${itemIdDefault},
    base_name      TEXT NOT NULL,
    base_name_norm TEXT NOT NULL,
    prefix         TEXT NOT NULL,
    level          INT  NOT NULL,
    maker_id       TEXT NOT NULL REFERENCES accounts(id),
    owner_id       TEXT REFERENCES accounts(id),
    effects        JSONB NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at     TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);
  CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
  CREATE INDEX IF NOT EXISTS idx_players_pos ON players(x, y, z);
  CREATE INDEX IF NOT EXISTS idx_events_player ON events(player_id, is_read, id DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_items_base_name_active
    ON items(base_name_norm)
    WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_items_owner ON items(owner_id) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_items_maker ON items(maker_id);
  `;
  await pool.query(ddl);
  await pool.query(
    `ALTER TABLE accounts
       ADD COLUMN IF NOT EXISTS username_norm TEXT`
  );
  const { rows: accountRows } = await pool.query(
    'SELECT id, username, username_norm FROM accounts'
  );
  const seenCanonical = new Map();
  const duplicateCanonicals = new Set();
  for (const row of accountRows) {
    const norm = canonicalize(row.username) || '';
    if (row.username_norm !== norm) {
      await pool.query('UPDATE accounts SET username_norm=$1 WHERE id=$2', [norm, row.id]);
    }
    if (seenCanonical.has(norm) && seenCanonical.get(norm) !== row.id) {
      duplicateCanonicals.add(norm);
    } else {
      seenCanonical.set(norm, row.id);
    }
  }
  await pool.query('CREATE INDEX IF NOT EXISTS idx_accounts_username_norm ON accounts(username_norm)');
  if (duplicateCanonicals.size === 0) {
    try {
      await pool.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uniq_accounts_username_norm ON accounts(username_norm)'
      );
    } catch (err) {
      console.warn('Failed to ensure unique username_norm index', err.message);
    }
  } else {
    console.warn(
      'Duplicate canonical usernames detected (resolve manually before unique index):',
      Array.from(duplicateCanonicals).join(', ')
    );
  }
  const alterSessions = `
    ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
      ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS user_agent TEXT,
      ADD COLUMN IF NOT EXISTS ip TEXT;
  `;
  await pool.query(alterSessions);
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
  if (IS_PG_MEM) {
    return withTx(fn);
  }
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
    usernameNorm: row.username_norm,
    passwordHash: row.password_hash,
    createdAt: row.created_at
  };
}

async function createAccount(username, passwordHash) {
  if (!username || !passwordHash) {
    throw new Error('username and passwordHash are required');
  }
  const canonical = canonicalize(username);
  if (!canonical) {
    const err = new Error('invalid username');
    err.code = 'INVALID_USERNAME';
    throw err;
  }
  const id = randomUUID();
  try {
    const { rows } = await pool.query(
      'INSERT INTO accounts(id, username, username_norm, password_hash) VALUES($1,$2,$3,$4) RETURNING id, username, username_norm, password_hash, created_at',
      [id, username, canonical, passwordHash]
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
  const canonical = canonicalize(username);
  if (!canonical) return null;
  const { rows } = await pool.query(
    `SELECT id, username, username_norm, password_hash, created_at
       FROM accounts
      WHERE username_norm = $1 OR lower(username) = $1`,
    [canonical]
  );
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    return normalizeAccount(rows[0]);
  }
  const exact = rows.find(row => row.username === username);
  if (exact) {
    return normalizeAccount(exact);
  }
  const err = new Error('canonical username collision');
  err.code = 'CANONICAL_COLLISION';
  err.usernames = rows.map(row => row.username);
  throw err;
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

async function createSession(accountId, meta = {}) {
  if (!accountId) throw new Error('accountId required');
  return withTx(async client => {
    const runner = exec(client);
    await runner.query('DELETE FROM sessions WHERE account_id=$1', [accountId]);
    const sessionId = randomUUID();
    try {
      await runner.query(
        `INSERT INTO sessions(session_id, account_id, issued_at, last_seen, expires_at, user_agent, ip)
         VALUES($1,$2,now(),now(), now() + $3 * interval '1 millisecond', $4,$5)`,
        [sessionId, accountId, Math.max(1, Math.floor(SESSION_TTL_MS)), meta.userAgent || null, meta.ip || null]
      );
    } catch (err) {
      throw err;
    }
    const expiresAt = new Date(Date.now() + Math.max(1, Math.floor(SESSION_TTL_MS)));
    return { sessionId, expiresAt };
  });
}

async function replaceSession(accountId, meta = {}) {
  return withTx(async client => {
    const runner = exec(client);
    await runner.query('DELETE FROM sessions WHERE account_id=$1', [accountId]);
    const sessionId = randomUUID();
    await runner.query(
      `INSERT INTO sessions(session_id, account_id, issued_at, last_seen, expires_at, user_agent, ip)
       VALUES($1,$2,now(),now(), now() + $3 * interval '1 millisecond', $4,$5)`,
      [sessionId, accountId, Math.max(1, Math.floor(SESSION_TTL_MS)), meta.userAgent || null, meta.ip || null]
    );
    const expiresAt = new Date(Date.now() + Math.max(1, Math.floor(SESSION_TTL_MS)));
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
  if (!sessionId) return false;
  let extensionMs = Math.max(0, Math.floor(SESSION_IDLE_TIMEOUT_MS));
  if (extensionMs <= 0) extensionMs = 30 * 60 * 1000;
  const { rowCount } = await pool.query(
    `UPDATE sessions
     SET last_seen=now(), expires_at=now() + $2 * interval '1 millisecond'
     WHERE session_id=$1 AND expires_at > now()`,
    [sessionId, extensionMs]
  );
  return rowCount > 0;
}

async function cleanupStaleSessions(client) {
  const runner = exec(client);
  let sql = 'DELETE FROM sessions WHERE expires_at < now()';
  const params = [];
  if (SESSION_IDLE_TIMEOUT_MS > 0) {
    sql += ' OR last_seen < $1';
    params.push(new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS * 3));
  }
  const { rowCount } = await runner.query(sql, params);
  return rowCount;
}

async function createItem(record, client) {
  const runner = exec(client);
  const id = record.id || randomUUID();
  const { rows } = await runner.query(
    `INSERT INTO items(id, base_name, base_name_norm, prefix, level, maker_id, owner_id, effects)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      id,
      record.baseName,
      record.baseNameNorm,
      record.prefix,
      record.level,
      record.makerId,
      record.ownerId || null,
      record.effects || {}
    ]
  );
  return toCamelItem(rows[0]);
}

async function updateItem(id, patch, client) {
  const runner = exec(client);
  const entries = Object.entries(patch).filter(([key, value]) => value !== undefined);
  if (entries.length === 0) {
    const { rows } = await runner.query('SELECT * FROM items WHERE id=$1', [id]);
    return rows.length ? toCamelItem(rows[0]) : null;
  }
  const sets = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of entries) {
    let column = key;
    if (key === 'baseName') column = 'base_name';
    else if (key === 'baseNameNorm') column = 'base_name_norm';
    else if (key === 'makerId') column = 'maker_id';
    else if (key === 'ownerId') column = 'owner_id';
    sets.push(`${column}=$${idx}`);
    values.push(value);
    idx += 1;
  }
  sets.push(`updated_at=now()`);
  values.push(id);
  const sql = `UPDATE items SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`;
  const { rows } = await runner.query(sql, values);
  return rows.length ? toCamelItem(rows[0]) : null;
}

async function softDeleteItem(id, client) {
  const runner = exec(client);
  const { rows } = await runner.query(
    'UPDATE items SET deleted_at=now(), owner_id=NULL, updated_at=now() WHERE id=$1 RETURNING *',
    [id]
  );
  return rows.length ? toCamelItem(rows[0]) : null;
}

async function findActiveItemByNameNorm(nameNorm, client) {
  if (!nameNorm) return null;
  const runner = exec(client);
  const { rows } = await runner.query(
    'SELECT * FROM items WHERE base_name_norm=$1 AND deleted_at IS NULL LIMIT 1',
    [nameNorm]
  );
  return rows.length ? toCamelItem(rows[0]) : null;
}

async function findActiveItemByPrefixAndName(prefix, nameNorm, client) {
  if (!prefix || !nameNorm) return null;
  const runner = exec(client);
  const { rows } = await runner.query(
    'SELECT * FROM items WHERE prefix=$1 AND base_name_norm=$2 AND deleted_at IS NULL LIMIT 1',
    [prefix, nameNorm]
  );
  return rows.length ? toCamelItem(rows[0]) : null;
}

async function listActiveItemsByOwner(ownerId, client) {
  if (!ownerId) return [];
  const runner = exec(client);
  const { rows } = await runner.query(
    'SELECT * FROM items WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC',
    [ownerId]
  );
  return rows.map(toCamelItem);
}

async function listActiveItemsByOwners(ownerIds, client) {
  if (!Array.isArray(ownerIds) || ownerIds.length === 0) return new Map();
  const runner = exec(client);
  const uniqueIds = Array.from(new Set(ownerIds.filter(Boolean)));
  if (uniqueIds.length === 0) return new Map();
  const { rows } = await runner.query(
    'SELECT * FROM items WHERE owner_id = ANY($1::text[]) AND deleted_at IS NULL',
    [uniqueIds]
  );
  const map = new Map();
  for (const row of rows) {
    const camel = toCamelItem(row);
    if (!map.has(camel.ownerId)) map.set(camel.ownerId, []);
    map.get(camel.ownerId).push(camel);
  }
  return map;
}

async function setItemOwner(id, ownerId, client) {
  const runner = exec(client);
  const { rows } = await runner.query(
    'UPDATE items SET owner_id=$2, updated_at=now() WHERE id=$1 RETURNING *',
    [id, ownerId]
  );
  return rows.length ? toCamelItem(rows[0]) : null;
}

async function withItemNameLock(nameNorm, fn, client) {
  if (!nameNorm) return fn();
  if (IS_PG_MEM) {
    return fn();
  }
  const runner = exec(client);
  const [k1, k2] = lockKeysFor(`item:${nameNorm}`);
  await runner.query('SELECT pg_advisory_lock($1,$2)', [k1, k2]);
  try {
    return await fn();
  } finally {
    await runner.query('SELECT pg_advisory_unlock($1,$2)', [k1, k2]);
  }
}

module.exports = {
  init,
  withTx,
  withPlayerTx,
  withPlayersTx,
  SESSION_TTL_HOURS,
  SESSION_TTL_MS,
  SESSION_IDLE_TIMEOUT_SEC,
  SESSION_IDLE_TIMEOUT_MS,
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
  cleanupStaleSessions,
  createItem,
  updateItem,
  softDeleteItem,
  findActiveItemByNameNorm,
  findActiveItemByPrefixAndName,
  listActiveItemsByOwner,
  listActiveItemsByOwners,
  setItemOwner,
  withItemNameLock,
  _pool: pool
};
