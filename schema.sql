-- schema.sql (建議版)

-- 帳號
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 玩家權威狀態
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

-- 事件日誌（給未讀/SSE）
CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,
  player_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_read    BOOLEAN NOT NULL DEFAULT FALSE
);

-- 單一登入的 session 表
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

-- 索引
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
CREATE INDEX IF NOT EXISTS idx_players_pos  ON players(x,y,z);
CREATE INDEX IF NOT EXISTS idx_events_player ON events(player_id, is_read, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
