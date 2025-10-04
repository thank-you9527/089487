const db = require('../db');
const { validateItemBaseName, canonicalize } = require('../lib/names');
const {
  pickRandomPrefix,
  resolvePrefix,
  formatEffectsSummary,
  buildItem,
  getPrefixLabel
} = require('../lib/itemPrefixes');

function fmt(ctx, value) {
  return typeof ctx?.fmt === 'function' ? ctx.fmt(value) : Math.round(value);
}

function formatCraftMessage(name, prefixKey, level, effects, ctx) {
  const prefixLabel = getPrefixLabel(prefixKey);
  const summary = formatEffectsSummary(prefixKey, level, effects, v => fmt(ctx, v));
  const lines = [];
  lines.push(`${ctx.c.name}製作了${prefixLabel}${name}（等級${fmt(ctx, level)}）`);
  if (summary.length > 0) {
    lines.push(`效果：${summary.join('，')}`);
  }
  return lines;
}

function findCharacterByAccount(users, accountId) {
  if (!Array.isArray(users)) return null;
  for (const entry of users) {
    if (entry?.character?.accountId === accountId) return entry.character;
  }
  return null;
}

async function handleCraft(cmd, ctx, logs) {
  const [, rawName] = cmd.split('/');
  const baseName = rawName ? rawName.trim() : '';
  if (!baseName) {
    logs.push('請提供道具名稱');
    return;
  }

  if (Math.round(ctx.c.action || 0) < 1) {
    logs.push('行動值不足');
    return;
  }

  const { ok, value, canonical, error } = validateItemBaseName(baseName);
  if (!ok) {
    logs.push(error === 'too-long' ? '名稱太長' : '名稱格式不合法');
    return;
  }

  ctx.c.action = Math.max(0, Math.round(ctx.c.action) - 1);
  ctx.c.lastActionUpdate = Date.now();
  ctx.markPlayerDirty?.(ctx.c.accountId);

  await db.withItemNameLock(canonical, async () => {
    const existing = await db.findActiveItemByNameNorm(canonical, ctx.dbClient);
    if (!existing) {
      const playerConflicts = ctx.listPlayersByName(value) || [];
      const monsterConflicts = ctx.listMonstersByName(value) || [];
      if (playerConflicts.length > 0 || monsterConflicts.length > 0) {
        logs.push('名稱已被使用');
        return;
      }
    } else if (existing.makerId !== ctx.c.accountId) {
      logs.push('此名稱已被另一位玩家使用');
      return;
    }

    const tier = Math.min(50, Math.max(1, Math.ceil((ctx.c.level || 1) / 10)));
    let itemLevel = tier === 1 ? 1 : tier;
    if (tier >= 2 && Math.random() >= 0.7) {
      itemLevel = Math.max(1, tier - 1);
    }

    const prefixDef = pickRandomPrefix();
    const built = buildItem(prefixDef.key, itemLevel);
    let saved;
    if (existing) {
      saved = await db.updateItem(
        existing.id,
        {
          prefix: built.prefix,
          level: built.level,
          effects: built.effects
        },
        ctx.dbClient
      );
    } else {
      saved = await db.createItem(
        {
          baseName: value,
          baseNameNorm: canonical,
          prefix: built.prefix,
          level: built.level,
          makerId: ctx.c.accountId,
          ownerId: null,
          effects: built.effects
        },
        ctx.dbClient
      );
    }

    if (!saved) {
      logs.push('製作失敗，請稍後再試');
      return;
    }

    for (const entry of ctx.users || []) {
      const character = entry.character;
      if (!character || !Array.isArray(character.inventory)) continue;
      const slot = character.inventory.find(item => item.id === saved.id);
      if (slot) {
        slot.prefix = saved.prefix;
        slot.level = saved.level;
        slot.effects = saved.effects;
        slot.name = saved.baseName;
        slot.baseName = saved.baseName;
        slot.baseNameNorm = saved.baseNameNorm;
      }
    }

    const lines = formatCraftMessage(value, saved.prefix, saved.level, saved.effects, ctx);
    lines.forEach(line => logs.push(line));
    ctx.queueEvent?.({
      playerId: ctx.c.accountId,
      kind: 'craft',
      payload: {
        id: saved.id,
        base_name: saved.baseName,
        prefix: saved.prefix,
        level: saved.level,
        makerId: saved.makerId,
        ownerId: saved.ownerId || null,
        effects: saved.effects
      }
    });
  }, ctx.dbClient);
}

async function handleScrap(cmd, ctx, logs) {
  const [, rawName] = cmd.split('/');
  const baseName = rawName ? rawName.trim() : '';
  if (!baseName) {
    logs.push('你要蛋雕什麼？');
    return;
  }
  const { ok, canonical } = validateItemBaseName(baseName);
  if (!ok) {
    logs.push('名稱格式不合法');
    return;
  }

  const inventory = Array.isArray(ctx.c.inventory) ? ctx.c.inventory : [];
  const index = inventory.findIndex(item => canonicalize(item.baseNameNorm || item.name) === canonical);
  if (index === -1) {
    logs.push('不在你的背包');
    return;
  }
  const [item] = inventory.splice(index, 1);
  await db.softDeleteItem(item.id, ctx.dbClient);
  ctx.queueEvent?.({
    playerId: ctx.c.accountId,
    kind: 'item_delete',
    payload: {
      id: item.id,
      base_name: item.name || item.baseName,
      prefix: item.prefix
    }
  });
  logs.push(`已蛋雕${item.name || item.baseName}`);
  ctx.markPlayerDirty?.(ctx.c.accountId);
}

function parseInspectTarget(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const plusIdx = trimmed.indexOf('+');
  if (plusIdx !== -1) {
    return {
      prefix: trimmed.slice(0, plusIdx).trim(),
      name: trimmed.slice(plusIdx + 1).trim()
    };
  }
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx !== -1) {
    return {
      prefix: trimmed.slice(0, spaceIdx).trim(),
      name: trimmed.slice(spaceIdx + 1).trim()
    };
  }
  return null;
}

async function handleInspect(cmd, ctx, logs) {
  const [, raw] = cmd.split('/');
  const parsed = parseInspectTarget(raw || '');
  if (!parsed || !parsed.prefix || !parsed.name) {
    logs.push('找不到，請確認前綴與名稱');
    return;
  }
  const prefixDef = resolvePrefix(parsed.prefix);
  if (!prefixDef) {
    logs.push('找不到，請確認前綴與名稱');
    return;
  }
  const { ok, canonical, value } = validateItemBaseName(parsed.name);
  if (!ok) {
    logs.push('找不到，請確認前綴與名稱');
    return;
  }

  const item = await db.findActiveItemByPrefixAndName(prefixDef.key, canonical, ctx.dbClient);
  if (!item) {
    logs.push('找不到，請確認前綴與名稱');
    return;
  }

  const makerCharacter = findCharacterByAccount(ctx.users, item.makerId);
  const ownerCharacter = findCharacterByAccount(ctx.users, item.ownerId);
  const makerName = makerCharacter ? makerCharacter.name : item.makerId;
  const ownerName = item.ownerId ? (ownerCharacter ? ownerCharacter.name : item.ownerId) : '無';
  const summary = formatEffectsSummary(item.prefix, item.level, item.effects, v => fmt(ctx, v));
  const prefixLabel = getPrefixLabel(item.prefix);
  const lines = [
    `${prefixLabel}${value}（等級${fmt(ctx, item.level)}）`,
    `製作者：${makerName}`,
    `持有者：${ownerName}`
  ];
  if (summary.length > 0) {
    lines.push(`效果：${summary.join('，')}`);
  }
  logs.push(lines.join('\n'));
}

module.exports = {
  prefixHandlers: [
    {
      prefix: '捏捏/',
      handler: (cmd, ctx, logs) => handleCraft(cmd, ctx, logs)
    },
    {
      prefix: '蛋雕/',
      handler: (cmd, ctx, logs) => handleScrap(cmd, ctx, logs)
    },
    {
      prefix: '讓我看看/',
      handler: (cmd, ctx, logs) => handleInspect(cmd, ctx, logs)
    }
  ]
};
