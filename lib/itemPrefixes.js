const { buildEffects } = require('./itemEffects');

const PREFIX_DEFS = {
  brave: { key: 'brave', label: '驍勇', weight: 45, description: '攻擊提升' },
  leech: { key: 'leech', label: '蝠翼', weight: 30, description: '吸血效果' },
  dodge: { key: 'dodge', label: '閃雷', weight: 19, description: '閃避提升' },
  tiger: { key: 'tiger', label: '猛虎', weight: 5, description: '爆擊提升' },
  sacrifice: { key: 'sacrifice', label: '祭品', weight: 1, description: '特殊效果' },
  blink: { key: 'blink', label: '星流', weight: 0.1, description: '瞬移能力' }
};

const LABEL_TO_KEY = Object.values(PREFIX_DEFS).reduce((acc, def) => {
  acc[def.label] = def.key;
  acc[def.key] = def.key;
  return acc;
}, {});

function resolvePrefix(input) {
  if (!input) return null;
  const key = LABEL_TO_KEY[String(input).trim().toLowerCase()] || LABEL_TO_KEY[input.trim()];
  if (key) return PREFIX_DEFS[key];
  const lower = String(input).trim().toLowerCase();
  return PREFIX_DEFS[lower] || null;
}

function pickRandomPrefix(random = Math.random) {
  const totalWeight = Object.values(PREFIX_DEFS).reduce((sum, def) => sum + def.weight, 0);
  let roll = random() * totalWeight;
  for (const def of Object.values(PREFIX_DEFS)) {
    roll -= def.weight;
    if (roll <= 0) return def;
  }
  return PREFIX_DEFS.brave;
}

function formatEffectsSummary(prefixKey, level, effects, fmt = v => v) {
  const parts = [];
  if (!effects || typeof effects !== 'object') return parts;
  if (effects.atk_pct) parts.push(`攻擊 +${fmt(Math.round(effects.atk_pct * 100))}%`);
  if (effects.lifesteal_pct) parts.push(`吸血 +${fmt(Math.round(effects.lifesteal_pct * 100))}%`);
  if (effects.dodge_pct) parts.push(`閃避 +${fmt(Math.round(effects.dodge_pct * 100))}%`);
  if (effects.crit_pct) parts.push(`爆擊 +${fmt(Math.round(effects.crit_pct * 100))}%`);
  if (effects.can_blink) parts.push('可瞬移');
  if (effects.is_sacrifice) parts.push('祭品效果');
  if (parts.length === 0) {
    const def = PREFIX_DEFS[prefixKey] || {};
    if (def.description) parts.push(def.description);
  }
  parts.unshift(`等級 ${fmt(level)}`);
  return parts;
}

function buildItem(prefixKey, level) {
  const def = PREFIX_DEFS[prefixKey];
  if (!def) return { prefix: prefixKey, effects: {}, level };
  return { prefix: def.key, effects: buildEffects(def.key, level), level };
}

function getPrefixLabel(prefixKey) {
  const def = PREFIX_DEFS[prefixKey];
  return def ? def.label : prefixKey;
}

module.exports = {
  PREFIX_DEFS,
  pickRandomPrefix,
  resolvePrefix,
  formatEffectsSummary,
  buildItem,
  getPrefixLabel
};
