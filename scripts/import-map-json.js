#!/usr/bin/env node

const path = require('path');
const fs = require('fs/promises');

if (!process.env.DATABASE_URL) {
  console.error('[import-map] DATABASE_URL environment variable is required');
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'import-map-script-secret';
}

const db = require('../db');
const { canonicalize } = require('../lib/names');
const { hpAtLevel, attackAtLevel } = require('../server');

const MAP_PATH = path.join(__dirname, '..', 'data', 'map.json');

function parseCoords(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split(',').map(part => Number(part.trim()));
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return null;
  }
  return parts;
}

function resolveName(raw, fallback) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  }
  return fallback;
}

function safeLevel(value) {
  const lvl = Number.isFinite(Number(value)) ? Number(value) : 1;
  if (!Number.isFinite(lvl)) return 1;
  return Math.max(1, Math.round(lvl));
}

function safeTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function findOwnerAccountId(name, client) {
  if (!name) return null;
  const { rows } = await client.query(
    'SELECT id FROM players WHERE LOWER(name) = LOWER($1) LIMIT 1',
    [name]
  );
  if (rows.length === 0) return null;
  return rows[0].id;
}

async function main() {
  await db.init();
  let raw;
  try {
    raw = await fs.readFile(MAP_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.log(`[import-map] ${MAP_PATH} not found; skipping import.`);
      if (typeof db._pool?.end === 'function') {
        await db._pool.end();
      }
      return;
    }
    throw err;
  }
  const mapData = JSON.parse(raw);

  const stats = {
    regions: 0,
    mobs: 0,
    guardians: 0,
    ownersMatched: 0,
    ownersUnmatched: 0
  };

  const client = await db._pool.connect();
  try {
    await client.query('BEGIN');

    for (const [key, region] of Object.entries(mapData || {})) {
      if (!region || typeof region !== 'object') {
        console.warn(`[import-map] Skipping region ${key}: invalid payload`);
        continue;
      }
      const coords = parseCoords(key);
      if (!coords) {
        console.warn(`[import-map] Skipping region ${key}: invalid coordinates`);
        continue;
      }
      const [x, y, z] = coords;
      const fallbackName = `region(${x},${y},${z})`;
      const name = resolveName(region.name, fallbackName);
      let nameNorm = canonicalize(name);
      if (!nameNorm) {
        nameNorm = fallbackName.toLowerCase();
      }
      const level = safeLevel(region.level);
      const ownerName = typeof region.owner === 'string' ? region.owner.trim() : '';
      let ownerAccountId = null;
      if (ownerName) {
        ownerAccountId = await findOwnerAccountId(ownerName, client);
        if (ownerAccountId) {
          stats.ownersMatched += 1;
        } else {
          stats.ownersUnmatched += 1;
        }
      }

      const { rows } = await client.query(
        `INSERT INTO world_regions(x, y, z, name, name_norm, level, owner_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (x, y, z)
         DO UPDATE SET
           name = EXCLUDED.name,
           name_norm = EXCLUDED.name_norm,
           level = EXCLUDED.level,
           owner_account_id = EXCLUDED.owner_account_id,
           updated_at = now()
         RETURNING id`,
        [x, y, z, name, nameNorm, level, ownerAccountId]
      );
      const regionId = rows[0].id;
      stats.regions += 1;

      await client.query('DELETE FROM region_mobs WHERE region_id = $1', [regionId]);

      const monsters = Array.isArray(region.monsters) ? region.monsters : [];
      for (const monster of monsters) {
        if (!monster || typeof monster !== 'object') continue;
        const monsterName = resolveName(monster.name, '未知怪物');
        const lvl = safeLevel(monster.level);
        const hpMax = hpAtLevel(lvl);
        const atk = attackAtLevel(lvl);
        const isGuardian = monster.guardian === true || monster.isGuardian === true;
        const alive = monster.alive === false ? false : true;
        const respawnAt = safeTimestamp(monster.respawnAt || monster.respawn_at);

        await client.query(
          `INSERT INTO region_mobs(region_id, name, is_guardian, level, hp_max, atk, alive, respawn_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [regionId, monsterName, isGuardian, lvl, hpMax, atk, alive, respawnAt]
        );
        stats.mobs += 1;
        if (isGuardian) stats.guardians += 1;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[import-map] Failed to import map.json', err);
    throw err;
  } finally {
    client.release();
  }

  console.log(`[import-map] Regions processed: ${stats.regions}`);
  console.log(`[import-map] Mobs processed: ${stats.mobs}`);
  console.log(`[import-map] Guardians processed: ${stats.guardians}`);
  if (stats.ownersMatched > 0 || stats.ownersUnmatched > 0) {
    console.log(
      `[import-map] Owners linked: ${stats.ownersMatched}, unresolved: ${stats.ownersUnmatched}`
    );
  }

  if (typeof db._pool.end === 'function') {
    await db._pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
