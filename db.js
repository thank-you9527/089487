/**
 * db.js — Postgres access layer for your MUD (players + events)
 * Usage:
 *   const db = require('./db');
 *   await db.init(); // optional if you run schema.sql separately
 *   const p = await db.getPlayer('alice');
 *   await db.upsertPlayer({...});
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } // Render/Neon-friendly
});

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

// -------- migrations (optional) --------
async function init() {
  // Lightweight init: create tables if not exists (idempotent)
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
  const { rows } = await client.query('SELECT * FROM players WHERE id = $1', [id]);
  return toCamel(rows[0] || null);
}

async function upsertPlayer(p, client = pool) {
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
  const { rows } = await client.query(
    'INSERT INTO events(player_id, kind, payload) VALUES($1,$2,$3) RETURNING *',
    [playerId, kind, payload]
  );
  return rows[0];
}

async function getUnreadEvents(playerId, limit = 50, client = pool) {
  const { rows } = await client.query(
    'SELECT * FROM events WHERE player_id=$1 AND is_read=false ORDER BY id ASC LIMIT $2',
    [playerId, limit]
  );
  return rows;
}

async function markEventsRead(playerId, upToId, client = pool) {
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
  _pool: pool
};
