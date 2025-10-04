const MAX_LEVEL = 500;

function normalizeLevel(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (n > MAX_LEVEL) return MAX_LEVEL;
  return Math.max(1, Math.floor(n));
}

function scalePercent(level, base, cap, pow = 0.8) {
  const lv = normalizeLevel(level);
  const safeBase = Number(base) || 0;
  const safeCap = Number(cap) || 0;
  if (safeBase === safeCap) return safeBase;
  const exponent = Number(pow);
  const power = Number.isFinite(exponent) ? exponent : 0.8;
  const ratio = Math.pow(lv / MAX_LEVEL, power);
  return safeBase + (safeCap - safeBase) * ratio;
}

const PREFIX_HANDLERS = {
  brave: (level) => ({ atk_pct: scalePercent(level, 0.05, 0.2) }),
  leech: (level) => ({ lifesteal_pct: scalePercent(level, 0.05, 0.2) }),
  dodge: (level) => ({ dodge_pct: scalePercent(level, 0.002, 0.08) }),
  blink: () => ({ can_blink: true }),
  sacrifice: () => ({ is_sacrifice: true }),
  tiger: (level) => ({ crit_pct: scalePercent(level, 0.0005, 0.15) })
};

function getItemEffects(item) {
  if (!item || typeof item !== 'object') return {};
  if (item.deleted_at != null && item.deleted_at !== false) return {};
  if (item.deletedAt != null && item.deletedAt !== false) return {};
  const prefixRaw = typeof item.prefix === 'string' ? item.prefix : null;
  if (!prefixRaw) return {};
  const handler = PREFIX_HANDLERS[prefixRaw.toLowerCase()];
  if (!handler) return {};
  const level = normalizeLevel(item.level);
  return handler(level) || {};
}

function aggregateItemEffects(items) {
  const result = {
    atk_pct_total: 0,
    lifesteal_pct_total: 0,
    dodge_bonus_total: 0,
    crit_pct_total: 0,
    can_blink: false,
    is_sacrifice: false
  };

  if (!Array.isArray(items)) return result;

  let critNoProc = 1;

  for (const item of items) {
    const effects = getItemEffects(item);
    if (!effects || typeof effects !== 'object') continue;

    if (effects.atk_pct) {
      result.atk_pct_total += Math.max(0, effects.atk_pct);
    }
    if (effects.lifesteal_pct) {
      result.lifesteal_pct_total += Math.max(0, effects.lifesteal_pct);
    }
    if (effects.dodge_pct) {
      result.dodge_bonus_total += Math.max(0, effects.dodge_pct) * 100;
    }
    if (effects.crit_pct) {
      const pct = Math.max(0, Math.min(1, effects.crit_pct));
      critNoProc *= 1 - pct;
    }
    if (effects.can_blink) {
      result.can_blink = true;
    }
    if (effects.is_sacrifice) {
      result.is_sacrifice = true;
    }
  }

  result.atk_pct_total = Math.min(0.5, result.atk_pct_total);
  result.lifesteal_pct_total = Math.min(0.3, result.lifesteal_pct_total);
  result.dodge_bonus_total = Math.min(20, result.dodge_bonus_total);
  result.crit_pct_total = Math.min(0.3, 1 - critNoProc);

  return result;
}

module.exports = {
  scalePercent,
  aggregateItemEffects,
  _internal: {
    normalizeLevel,
    getItemEffects,
    PREFIX_HANDLERS
  }
};
