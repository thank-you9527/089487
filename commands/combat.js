const { runAttack } = require('./attack');

const triggerFriendlyInteraction = (ctx, target, logs) => {
  const { c, markPlayerDirty } = ctx;
  const hpMax = typeof c.maxHp === 'number'
    ? c.maxHp
    : typeof c.hpMax === 'number'
    ? c.hpMax
    : typeof c.hp_max === 'number'
    ? c.hp_max
    : typeof c.hp === 'number'
    ? c.hp
    : 0;
  const spMax = typeof c.maxAction === 'number'
    ? c.maxAction
    : typeof c.action === 'number'
    ? c.action
    : 0;
  const targetLevel = target && typeof target.level === 'number' ? target.level : null;
  const result = runAttack({
    player: {
      level: typeof c.level === 'number' ? c.level : 1,
      morality: typeof c.morality === 'number' ? c.morality : 0,
      atk: typeof c.attack === 'number' ? c.attack : typeof c.atk === 'number' ? c.atk : 0,
      hp: typeof c.hp === 'number' ? c.hp : 0,
      hp_max: hpMax,
      // 把 action 視為體力傳入 runAttack
      sp: typeof c.action === 'number' ? c.action : 0,
      sp_max: spMax
    },
    target: { level: targetLevel }
  });

  for (const message of result.messages) {
    logs.push(message);
  }

  if (result.delta_hp) {
    const max = hpMax || 0;
    const current = typeof c.hp === 'number' ? c.hp : 0;
    const upper = max > 0 ? max : Infinity;
    const next = Math.max(0, Math.min(upper, current + result.delta_hp));
    c.hp = next;
    markPlayerDirty?.(c.accountId);
  }

  if (result.delta_sp) {
    const max = typeof c.maxAction === 'number' ? c.maxAction : typeof c.action === 'number' ? c.action : 0;
    const current = typeof c.action === 'number' ? c.action : 0;
    const upper = max > 0 ? max : Infinity;
    c.action = Math.max(0, Math.min(upper, current + result.delta_sp));
    c.lastActionUpdate = Date.now();
    markPlayerDirty?.(c.accountId);
  }

  return result;
};

const attack = async (cmd, targeted, cost, ctx, logs) => {
  const { c, users, worldMap, handleDeath, fmt, saveMap, monsterDrop, markPlayerDirty } = ctx;
  if (c.action < cost) {
    logs.push('行動值不足');
    return;
  }
  c.action = Math.max(0, c.action - cost);
  c.lastActionUpdate = Date.now();
  markPlayerDirty?.(c.accountId);
  const key = `${c.position.x},${c.position.y},${c.position.z}`;
  const loc = worldMap[key] || {};

  async function resolveAttack(tgt, tgtType) {
    const successChance = Math.max(0, Math.min(100, c.morality + 10));
    if (Math.random() * 100 > successChance) {
      logs.push('攻擊失敗');
      return;
    }
    let dodge = 0;
    if (tgtType === 'player') dodge = tgt.dodge || 3;
    if (Math.random() * 100 < dodge) {
      logs.push(`啊！${tgt.name}抖了兩下，閃過了${c.name}的一擊！`);
      return;
    }
    const damage = c.attack;
    tgt.hp = Math.max(0, (tgt.hp || 0) - damage);
    if (tgtType === 'player') markPlayerDirty?.(tgt.accountId);
    logs.push(`${c.name}攻擊了${tgt.name}，造成${fmt(damage)}傷害`);
    if (tgt.hp <= 0) {
      logs.push(`${tgt.name}被擊敗了`);
      if (tgtType === 'player') {
        await handleDeath(tgt, logs);
      } else {
        await monsterDrop(tgt, c, loc, logs);
        if (tgt.guardian && loc.owner) {
          const prev = loc.name;
          const preservedLevel =
            loc.initialLevel != null ? loc.initialLevel : loc.level || 1;
          loc.initialLevel = preservedLevel;
          loc.level = preservedLevel;
          loc.name = '廢墟';
          delete loc.owner;
          loc.description = `守護神殞落後，${prev}再度化為廢墟。`;
          loc.monsters = [];
          delete loc.returnMark;
        }
      }
    }
  }

  if (targeted) {
    const name = cmd.split('/')[1];
    if (!loc.monsters) loc.monsters = [];
    const target = loc.monsters.find(m => m.name === name);
    if (!target) {
      logs.push('你找誰？');
    } else if (loc.owner === c.name) {
      triggerFriendlyInteraction(ctx, target, logs);
    } else {
      await resolveAttack(target, 'monster');
      if (loc.monsters) loc.monsters = loc.monsters.filter(m => m.hp > 0);
    }
  } else {
    const candidates = [];
    if (Array.isArray(loc.monsters)) {
      for (const m of loc.monsters) candidates.push({ type: 'monster', obj: m });
    }
    for (const u of users) {
      const ch = u.character;
      if (ch && ch !== c && ch.position.x === c.position.x && ch.position.y === c.position.y && ch.position.z === c.position.z) {
        candidates.push({ type: 'player', obj: ch });
      }
    }
    if (candidates.length === 0) {
      logs.push('沒有可以攻擊的目標');
    } else {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      const target = pick.obj;
      if (pick.type === 'monster' && loc.owner === c.name) {
        triggerFriendlyInteraction(ctx, target, logs);
      } else {
        await resolveAttack(target, pick.type);
        if (pick.type === 'monster' && loc.monsters) {
          loc.monsters = loc.monsters.filter(m => m.hp > 0);
        }
      }
    }
  }
  await saveMap();
};

module.exports = {
  handlers: {
    '歐拉': (ctx, logs) => attack('歐拉', false, 1, ctx, logs)
  },
  prefixHandlers: [
    {
      prefix: '歐拉/',
      handler: (cmd, ctx, logs) => attack(cmd, true, 10, ctx, logs)
    }
  ]
};
