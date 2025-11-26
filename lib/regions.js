function round(value, fallback = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.round(num));
}

function computeAttack(level, ctx) {
  if (typeof ctx?.attackAtLevel === 'function') {
    const atk = ctx.attackAtLevel(level);
    if (Number.isFinite(atk)) return Math.max(0, Math.round(atk));
  }
  return level;
}

function computeHp(level, ctx) {
  if (typeof ctx?.hpAtLevel === 'function') {
    const hp = ctx.hpAtLevel(level);
    if (Number.isFinite(hp)) return Math.max(1, Math.round(hp));
  }
  return Math.max(1, level * 10);
}

function expForLevel(level, ctx) {
  if (typeof ctx?.expGainForLevel === 'function') {
    const exp = ctx.expGainForLevel(level);
    if (Number.isFinite(exp)) return Math.max(0, Math.round(exp));
  }
  return null;
}

function convertDbMobToMonster(mob, ctx) {
  if (!mob) return null;
  const level = round(mob.level, 1);
  const hpMax = Number.isFinite(mob.hpMax) ? Math.max(1, Math.round(mob.hpMax)) : computeHp(level, ctx);
  const attack = Number.isFinite(mob.atk) ? Math.max(0, Math.round(mob.atk)) : computeAttack(level, ctx);
  const isGuardian = !!mob.isGuardian;
  const converted = {
    id: mob.id || null,
    name: mob.name,
    level,
    attack,
    hp: hpMax,
    maxHp: hpMax,
    guardian: isGuardian,
    isGuardian
  };
  const exp = expForLevel(level, ctx);
  if (exp != null) converted.exp = exp;
  if (mob.respawnAt) converted.respawnAt = mob.respawnAt;
  return converted;
}

function ensureMonsterContainer(location) {
  if (!location.monsters || !Array.isArray(location.monsters)) {
    location.monsters = [];
  }
  return location.monsters;
}

function mergeDbMonstersIntoLocation(location, dbMobs, ctx) {
  if (!location || !Array.isArray(dbMobs)) return [];
  const living = dbMobs.filter(mob => mob && mob.alive !== false);
  if (living.length === 0) return [];
  const converted = living
    .map(mob => convertDbMobToMonster(mob, ctx))
    .filter(Boolean);
  if (converted.length === 0) return [];
  location.monsters = converted;
  return converted;
}

function applyRespawnedMobs(location, respawned, ctx) {
  if (!location || !Array.isArray(respawned) || respawned.length === 0) return [];
  const monsters = ensureMonsterContainer(location);
  const updates = [];
  for (const mob of respawned) {
    if (!mob) continue;
    const converted = convertDbMobToMonster(mob, ctx);
    if (!converted) continue;
    const idx = converted.id
      ? monsters.findIndex(entry => entry && entry.id === converted.id)
      : -1;
    if (idx >= 0) {
      monsters[idx] = { ...monsters[idx], ...converted };
    } else {
      monsters.push(converted);
    }
    updates.push(converted);
  }
  return updates;
}

module.exports = {
  convertDbMobToMonster,
  mergeDbMonstersIntoLocation,
  applyRespawnedMobs
};
