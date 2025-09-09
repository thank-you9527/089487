const attack = async (cmd, targeted, cost, ctx, logs) => {
  const { c, users, worldMap, handleDeath, fmt, saveMap, monsterDrop } = ctx;
  if (c.action < cost) {
    logs.push('行動值不足');
    return;
  }
  c.action = Math.max(0, c.action - cost);
  c.lastActionUpdate = Date.now();
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
    logs.push(`${c.name}攻擊了${tgt.name}，造成${fmt(damage)}傷害`);
    if (tgt.hp <= 0) {
      logs.push(`${tgt.name}被擊敗了`);
      if (tgtType === 'player') {
        await handleDeath(tgt, logs);
      } else {
        await monsterDrop(tgt, c, loc, logs);
        if (tgt.guardian && loc.owner) {
          const prev = loc.name;
          loc.name = '廢墟';
          delete loc.owner;
          loc.description = `本來是${prev}被${c.name}給一拳打成了廢墟`;
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
      await resolveAttack(target, pick.type);
      if (pick.type === 'monster' && loc.monsters) loc.monsters = loc.monsters.filter(m => m.hp > 0);
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
