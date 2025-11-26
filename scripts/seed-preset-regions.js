#!/usr/bin/env node

const path = require('path');
const fs = require('fs/promises');

if (!process.env.DATABASE_URL) {
  console.error('[seed-regions] DATABASE_URL environment variable is required');
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'seed-preset-regions-script-secret';
}

const db = require('../db');
const { canonicalize } = require('../lib/names');
const { hpAtLevel, attackAtLevel } = require('../server');

const PRESET_PATH = path.join(__dirname, '..', 'seeds', 'preset_regions.json');

function parseCoordinates(entry) {
  if (!entry) return null;
  if (Array.isArray(entry)) {
    const coords = entry.map(value => Number(value));
    if (coords.length === 3 && coords.every(Number.isFinite)) {
      return coords;
    }
  }
  if (typeof entry === 'object') {
    const coords = ['x', 'y', 'z'].map(key => Number(entry[key]));
    if (coords.every(Number.isFinite)) {
      return coords;
    }
  }
  return null;
}

function boolFrom(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (!lowered) return fallback;
    if (['true', '1', 'yes', 'y'].includes(lowered)) return true;
    if (['false', '0', 'no', 'n'].includes(lowered)) return false;
  }
  return fallback;
}

function safeLevel(value, fallback = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.round(num));
}

function normalizeName(name, fallback) {
  if (typeof name === 'string') {
    const trimmed = name.trim();
    if (trimmed) {
      return { display: trimmed, norm: canonicalize(trimmed) || trimmed.toLowerCase() };
    }
  }
  const fb = typeof fallback === 'string' ? fallback : 'unknown';
  return { display: fb, norm: canonicalize(fb) || fb.toLowerCase() };
}

function mobKey(name, isGuardian) {
  return `${canonicalize(name)}|${isGuardian ? 'g' : 'm'}`;
}

async function ensurePresetRegions(client, presets) {
  const stats = {
    regions: 0,
    mobsInserted: 0,
    mobsUpdated: 0,
    mobsRemoved: 0
  };

  for (const preset of presets) {
    if (!preset || typeof preset !== 'object') {
      console.warn('[seed-regions] Skipping invalid preset entry', preset);
      continue;
    }

    const coords = parseCoordinates(preset.coordinates || preset.coord || preset.position);
    if (!coords) {
      console.warn('[seed-regions] Skipping preset without valid coordinates', preset);
      continue;
    }
    const [x, y, z] = coords;
    const fallbackName = `region(${x},${y},${z})`;
    const { display: name, norm: nameNorm } = normalizeName(preset.name, fallbackName);
    const level = safeLevel(preset.level, 1);
    const isSystem = boolFrom(preset.is_system, true);
    const isClaimable = isSystem ? false : boolFrom(preset.is_claimable, true);
    const isDestructible = isSystem ? false : boolFrom(preset.is_destructible, true);
    const ownerDisplayRaw = typeof preset.owner_display === 'string' ? preset.owner_display.trim() : '';
    const ownerDisplay = ownerDisplayRaw || null;

    const upsert = await client.query(
      `INSERT INTO world_regions (x, y, z, name, name_norm, level, is_system, is_claimable, is_destructible, owner_display, owner_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (x, y, z)
       DO UPDATE SET
         name = EXCLUDED.name,
         name_norm = EXCLUDED.name_norm,
         level = EXCLUDED.level,
         is_system = EXCLUDED.is_system,
         is_claimable = EXCLUDED.is_claimable,
         is_destructible = EXCLUDED.is_destructible,
         owner_display = EXCLUDED.owner_display,
         owner_account_id = CASE WHEN EXCLUDED.is_system THEN NULL ELSE world_regions.owner_account_id END,
         updated_at = now()
       RETURNING id`,
      [
        x,
        y,
        z,
        name,
        nameNorm,
        level,
        isSystem,
        isClaimable,
        isDestructible,
        ownerDisplay,
        null
      ]
    );

    const regionId = upsert.rows[0]?.id;
    if (!regionId) {
      console.warn('[seed-regions] Failed to persist region at', coords);
      continue;
    }
    stats.regions += 1;

    const monsters = Array.isArray(preset.monsters) ? preset.monsters : [];
    if (monsters.length === 0) {
      continue;
    }

    const existing = await client.query('SELECT * FROM region_mobs WHERE region_id = $1', [regionId]);
    const existingMap = new Map();
    for (const row of existing.rows) {
      if (!row || !row.name) continue;
      existingMap.set(mobKey(row.name, row.is_guardian), row);
    }
    const seenKeys = new Set();

    for (const monster of monsters) {
      if (!monster || typeof monster !== 'object') continue;
      const { display: monsterName } = normalizeName(monster.name, '未知怪物');
      const isGuardian = boolFrom(monster.is_guardian ?? monster.guardian, false);
      const levelValue = safeLevel(monster.level, level);
      const hpMax = hpAtLevel(levelValue);
      const atk = attackAtLevel(levelValue);
      const key = mobKey(monsterName, isGuardian);
      seenKeys.add(key);
      const existingRow = existingMap.get(key);
      if (existingRow) {
        await client.query(
          `UPDATE region_mobs
              SET name = $2,
                  is_guardian = $3,
                  level = $4,
                  hp_max = $5,
                  atk = $6,
                  alive = TRUE,
                  respawn_at = NULL
            WHERE id = $1`,
          [existingRow.id, monsterName, isGuardian, levelValue, hpMax, atk]
        );
        stats.mobsUpdated += 1;
      } else {
        await client.query(
          `INSERT INTO region_mobs(region_id, name, is_guardian, level, hp_max, atk, alive, respawn_at)
           VALUES ($1,$2,$3,$4,$5,$6,TRUE,NULL)`,
          [regionId, monsterName, isGuardian, levelValue, hpMax, atk]
        );
        stats.mobsInserted += 1;
      }
    }

    for (const [key, row] of existingMap.entries()) {
      if (!seenKeys.has(key)) {
        await client.query('DELETE FROM region_mobs WHERE id = $1', [row.id]);
        stats.mobsRemoved += 1;
      }
    }
  }

  return stats;
}

async function main() {
  await db.init();
  let raw;
  try {
    raw = await fs.readFile(PRESET_PATH, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      console.warn(`[seed-regions] Preset file not found at ${PRESET_PATH}. Nothing to do.`);
      return;
    }
    throw err;
  }

  let presets;
  try {
    presets = JSON.parse(raw);
  } catch (err) {
    console.error('[seed-regions] Failed to parse preset_regions.json:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(presets)) {
    console.error('[seed-regions] Preset file must contain an array of regions');
    process.exit(1);
  }

  const client = await db._pool.connect();
  let stats;
  try {
    await client.query('BEGIN');
    stats = await ensurePresetRegions(client, presets);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed-regions] Failed to seed preset regions', err);
    process.exitCode = 1;
    throw err;
  } finally {
    client.release();
  }

  console.log(`[seed-regions] Regions upserted: ${stats?.regions ?? 0}`);
  console.log(
    `[seed-regions] Mobs inserted: ${stats?.mobsInserted ?? 0}, updated: ${stats?.mobsUpdated ?? 0}, removed: ${stats?.mobsRemoved ?? 0}`
  );

  if (typeof db._pool?.end === 'function') {
    await db._pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
