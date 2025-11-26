
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 玩家權威狀態
CREATE TABLE IF NOT EXISTS players (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT,
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

CREATE TABLE IF NOT EXISTS items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE TABLE IF NOT EXISTS world_regions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  x                  INT  NOT NULL,
  y                  INT  NOT NULL,
  z                  INT  NOT NULL,
  name               TEXT NOT NULL,
  name_norm          TEXT NOT NULL,
  level              INT  NOT NULL,
  owner_account_id   TEXT REFERENCES accounts(id),
  owner_display      TEXT,
  is_system          BOOLEAN NOT NULL DEFAULT FALSE,
  is_claimable       BOOLEAN NOT NULL DEFAULT TRUE,
  is_destructible    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT world_regions_system_guardrails
    CHECK (NOT is_system OR (owner_account_id IS NULL AND is_claimable = FALSE AND is_destructible = FALSE)),
  CONSTRAINT world_regions_name_norm_lower CHECK (name_norm = lower(name_norm))
);

CREATE TABLE IF NOT EXISTS region_mobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id     UUID NOT NULL REFERENCES world_regions(id),
  name          TEXT NOT NULL,
  is_guardian   BOOLEAN NOT NULL DEFAULT FALSE,
  level         INT NOT NULL,
  hp_max        INT NOT NULL,
  atk           INT NOT NULL,
  alive         BOOLEAN NOT NULL DEFAULT TRUE,
  respawn_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE world_regions
  ADD COLUMN IF NOT EXISTS owner_display TEXT;

-- 帳號表
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  username_norm TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);
CREATE INDEX IF NOT EXISTS idx_accounts_username_norm ON accounts(username_norm);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_accounts_username_norm ON accounts(username_norm);
CREATE INDEX IF NOT EXISTS idx_players_account ON players(account_id);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
CREATE INDEX IF NOT EXISTS idx_players_pos  ON players(x,y,z);
CREATE INDEX IF NOT EXISTS idx_events_player ON events(player_id, is_read, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_base_name_active
  ON items(base_name_norm)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_owner ON items(owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_maker ON items(maker_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_world_regions_coords ON world_regions(x, y, z);
CREATE UNIQUE INDEX IF NOT EXISTS idx_world_regions_name_norm ON world_regions(name_norm);
CREATE INDEX IF NOT EXISTS idx_region_mobs_region ON region_mobs(region_id);
CREATE INDEX IF NOT EXISTS idx_region_mobs_region_guardian ON region_mobs(region_id, is_guardian);

-- Align player/account ownership columns to avoid join type mismatches
DO $$
DECLARE
  account_type text;
BEGIN
  SELECT data_type INTO account_type
  FROM information_schema.columns
  WHERE table_name = 'accounts'
    AND column_name = 'id'
  LIMIT 1;

  -- Backfill and align players.account_id to accounts.id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'players' AND column_name = 'account_id'
  ) THEN
    EXECUTE format('ALTER TABLE players ADD COLUMN account_id %s', account_type);
  END IF;

  BEGIN
    EXECUTE 'UPDATE players SET account_id = id WHERE account_id IS NULL';
    EXECUTE 'ALTER TABLE players DROP CONSTRAINT IF EXISTS players_account_id_fkey';
    EXECUTE format('ALTER TABLE players ALTER COLUMN account_id TYPE %s USING account_id::%s', account_type, account_type);
    EXECUTE 'ALTER TABLE players ADD CONSTRAINT players_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id)';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'skipped players.account_id alignment: %', SQLERRM;
  END;

  -- Align world_regions.owner_account_id to accounts.id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'world_regions' AND column_name = 'owner_account_id'
  ) THEN
    BEGIN
      EXECUTE 'ALTER TABLE world_regions DROP CONSTRAINT IF EXISTS world_regions_owner_account_id_fkey';
      EXECUTE format(
        'ALTER TABLE world_regions ALTER COLUMN owner_account_id TYPE %s USING owner_account_id::%s',
        account_type,
        account_type
      );
      EXECUTE 'ALTER TABLE world_regions ADD CONSTRAINT world_regions_owner_account_id_fkey FOREIGN KEY (owner_account_id) REFERENCES accounts(id)';
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'skipped owner_account_id type alignment: %', SQLERRM;
    END;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION trg_world_regions_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_region_mobs_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_world_regions_protect_system()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_system THEN
    IF NEW.is_system IS DISTINCT FROM OLD.is_system THEN
      RAISE EXCEPTION 'system regions cannot toggle is_system flag';
    END IF;
    IF NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id
       OR NEW.is_claimable IS DISTINCT FROM OLD.is_claimable
       OR NEW.is_destructible IS DISTINCT FROM OLD.is_destructible
       OR NEW.x IS DISTINCT FROM OLD.x
       OR NEW.y IS DISTINCT FROM OLD.y
       OR NEW.z IS DISTINCT FROM OLD.z
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.name_norm IS DISTINCT FROM OLD.name_norm
       OR NEW.level IS DISTINCT FROM OLD.level THEN
      RAISE EXCEPTION 'system regions have protected fields';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_world_regions_touch_row') THEN
    CREATE TRIGGER trg_world_regions_touch_row
      BEFORE UPDATE ON world_regions
      FOR EACH ROW EXECUTE FUNCTION trg_world_regions_touch();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_world_regions_protect_system_row') THEN
    CREATE TRIGGER trg_world_regions_protect_system_row
      BEFORE UPDATE ON world_regions
      FOR EACH ROW EXECUTE FUNCTION trg_world_regions_protect_system();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_region_mobs_touch_row') THEN
    CREATE TRIGGER trg_region_mobs_touch_row
      BEFORE UPDATE ON region_mobs
      FOR EACH ROW EXECUTE FUNCTION trg_region_mobs_touch();
  END IF;
END;
$$;
