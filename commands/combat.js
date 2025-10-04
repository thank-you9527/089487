const { runAttack, runFriendlyOnly } = require('./attack');
const { aggregateItemEffects } = require('../lib/itemEffects');

const roundInt = value => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

const clampInt = (value, min, max) => {
  const n = roundInt(value);
  if (typeof max === 'number') {
    return Math.max(min, Math.min(max, n));
  }
  return Math.max(min, n);
};

const roll100 = () => Math.floor(Math.random() * 100) + 1;

const SAFE_DODGE_MAX = 100;

function getMaxAction(entity) {
  if (!entity) return 0;
  if (typeof entity.maxAction === 'number') return roundInt(entity.maxAction);
  if (typeof entity.actionMax === 'number') return roundInt(entity.actionMax);
  if (typeof entity.maxSp === 'number') return roundInt(entity.maxSp);
  if (typeof entity.spMax === 'number') return roundInt(entity.spMax);
  if (typeof entity.sp_max === 'number') return roundInt(entity.sp_max);
  if (typeof entity.action === 'number') return Math.max(0, roundInt(entity.action));
  return 0;
}

function getMaxHp(entity, ctx) {
  if (!entity) return 0;
  if (typeof entity.maxHp === 'number') return Math.max(1, roundInt(entity.maxHp));
  if (typeof entity.hpMax === 'number') return Math.max(1, roundInt(entity.hpMax));
  if (typeof entity.hp_max === 'number') return Math.max(1, roundInt(entity.hp_max));
  if (typeof entity.level === 'number' && ctx?.hpAtLevel) {
    const computed = ctx.hpAtLevel(entity.level);
    if (Number.isFinite(computed)) return Math.max(1, roundInt(computed));
  }
  if (typeof entity.hp === 'number') return Math.max(1, roundInt(entity.hp));
  return 1;
}

function ensureMonsterStats(monster, ctx) {
  if (!monster) return;
  const level = typeof monster.level === 'number' ? monster.level : 1;
  if (typeof monster.maxHp !== 'number') {
    monster.maxHp = getMaxHp({ hp: monster.hp, level }, ctx);
  }
  if (typeof monster.hp !== 'number') {
    monster.hp = monster.maxHp;
  }
  if (typeof monster.attack !== 'number' && typeof ctx?.attackAtLevel === 'function') {
    monster.attack = roundInt(ctx.attackAtLevel(level));
  }
  if (typeof monster.attack !== 'number') monster.attack = 0;
}

function applyHpChange(entity, delta, ctx, { isPlayer, markPlayerDirty }) {
  if (!entity) return 0;
  const maxHp = getMaxHp(entity, ctx);
  const current = typeof entity.hp === 'number' ? roundInt(entity.hp) : 0;
  const next = clampInt(current + roundInt(delta), 0, maxHp);
  entity.hp = next;
  if (isPlayer) {
    entity.lastHpUpdate = Date.now();
    if (typeof markPlayerDirty === 'function' && entity.accountId) {
      markPlayerDirty(entity.accountId);
    }
  }
  return next - current;
}

function applyActionChange(entity, delta, markPlayerDirty) {
  if (!entity) return 0;
  const maxAction = getMaxAction(entity);
  const current = typeof entity.action === 'number' ? roundInt(entity.action) : 0;
  const next = clampInt(current + roundInt(delta), 0, maxAction);
  entity.action = next;
  entity.lastActionUpdate = Date.now();
  if (typeof markPlayerDirty === 'function' && entity.accountId) {
    markPlayerDirty(entity.accountId);
  }
  return next - current;
}

function buildPlayerStatsForRunAttack(player, ctx) {
  return {
    level: typeof player.level === 'number' ? player.level : 1,
    morality: typeof player.morality === 'number' ? player.morality : 0,
    atk: typeof player.attack === 'number' ? player.attack : 0,
    hp: typeof player.hp === 'number' ? player.hp : 0,
    hp_max: getMaxHp(player, ctx),
    sp: typeof player.action === 'number' ? player.action : 0,
    sp_max: getMaxAction(player)
  };
}

function queueEvent(ctx, entry) {
  if (!ctx || typeof ctx.queueEvent !== 'function') return;
  if (!entry || !entry.playerId || !entry.kind) return;
  ctx.queueEvent(entry);
}

function computeHitChance(combatant) {
  if (combatant.type === 'player') {
    return clampInt((typeof combatant.morality === 'number' ? combatant.morality : 0) + 10, 0, 100);
  }
  return 50;
}

function computeDodgeChance(defender) {
  const base = typeof defender.dodge === 'number' ? defender.dodge : 0;
  const bonus = defender.effects?.dodge_bonus_total || 0;
  return clampInt(base + bonus, 0, SAFE_DODGE_MAX);
}

function createCombatantFromPlayer(player, ctx) {
  const effects = aggregateItemEffects(player?.inventory);
  return {
    type: 'player',
    entity: player,
    name: player.name,
    accountId: player.accountId,
    attack: roundInt(player.attack),
    morality: typeof player.morality === 'number' ? player.morality : 0,
    dodge: typeof player.dodge === 'number' ? player.dodge : 0,
    level: typeof player.level === 'number' ? player.level : 1,
    maxHp: getMaxHp(player, ctx),
    effects
  };
}

function createCombatantFromMonster(monster, ctx, locationKey) {
  ensureMonsterStats(monster, ctx);
  return {
    type: 'monster',
    entity: monster,
    name: monster.name,
    accountId: null,
    attack: roundInt(monster.attack),
    morality: 50,
    dodge: typeof monster.dodge === 'number' ? monster.dodge : 0,
    level: typeof monster.level === 'number' ? monster.level : 1,
    maxHp: getMaxHp(monster, ctx),
    effects: null,
    locationKey
  };
}

async function executeStrike(attacker, defender, ctx) {
  const attackerRoll = roll100();
  const hitChance = computeHitChance(attacker);
  if (attackerRoll > hitChance) {
    return {
      hit: false,
      dodged: false,
      attackerRoll,
      defenderRoll: null,
      damage: 0,
      inflicted: 0,
      defenderDefeated: false,
      crit: false,
      lifesteal: 0
    };
  }
  const dodgeChance = computeDodgeChance(defender);
  const defenderRoll = roll100();
  if (defenderRoll <= dodgeChance) {
    return {
      hit: false,
      dodged: true,
      attackerRoll,
      defenderRoll,
      damage: 0,
      inflicted: 0,
      defenderDefeated: false,
      crit: false,
      lifesteal: 0
    };
  }
  const effects = attacker.effects || {};
  const lifestealEffects = effects.lifesteal_pct_total || 0;
  const critChance = effects.crit_pct_total || 0;
  const attackBonus = effects.atk_pct_total || 0;

  let attemptedDamage = Math.max(0, roundInt(attacker.attack));
  if (attackBonus > 0) {
    attemptedDamage = roundInt(attemptedDamage * (1 + attackBonus));
  }

  let crit = false;
  if (critChance > 0 && Math.random() < Math.min(0.3, Math.max(0, critChance))) {
    crit = true;
    attemptedDamage = roundInt(attemptedDamage * 3.5);
  }

  const inflicted = Math.max(0, attemptedDamage);
  const delta = applyHpChange(defender.entity, -inflicted, ctx, {
    isPlayer: defender.type === 'player',
    markPlayerDirty: ctx.markPlayerDirty
  });
  const damageDone = Math.abs(delta);
  const defenderDefeated = defender.entity.hp <= 0;
  let lifestealApplied = 0;
  if (damageDone > 0 && lifestealEffects > 0) {
    const healAmount = roundInt(damageDone * Math.min(0.3, Math.max(0, lifestealEffects)));
    if (healAmount > 0) {
      const healed = applyHpChange(attacker.entity, healAmount, ctx, {
        isPlayer: attacker.type === 'player',
        markPlayerDirty: ctx.markPlayerDirty
      });
      lifestealApplied = Math.max(0, healed);
    }
  }
  return {
    hit: true,
    dodged: false,
    attackerRoll,
    defenderRoll,
    damage: damageDone,
    inflicted: damageDone,
    defenderDefeated,
    crit,
    lifesteal: lifestealApplied
  };
}

async function handleMonsterDefeat(monster, loc, ctx, logs) {
  await ctx.monsterDrop(monster, ctx.c, loc, logs);
  if (monster.guardian && loc.owner) {
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

function buildFriendlyMessages(playerName, narrative, deltaHp, deltaSp, fmt) {
  const messages = [];
  if (narrative) messages.push(narrative);
  const hpChange = roundInt(deltaHp);
  const spChange = roundInt(deltaSp);
  if (hpChange !== 0) {
    const text = hpChange > 0
      ? `${playerName}回復了${fmt(Math.abs(hpChange))}點血量！`
      : `${playerName}失去了${fmt(Math.abs(hpChange))}點血量！`;
    messages.push(text);
  } else if (spChange !== 0) {
    const text = spChange > 0
      ? `${playerName}回復了${fmt(Math.abs(spChange))}點體力！`
      : `${playerName}失去了${fmt(Math.abs(spChange))}點體力！`;
    messages.push(text);
  }
  return messages;
}

function debugCandidates(attackerName, candidates, picked) {
  if (process.env.NODE_ENV === 'production') return;
  const payload = {
    attacker: attackerName,
    candidates: candidates.map(entry => ({
      type: entry.type,
      name: entry.entity.name
    })),
    picked: picked ? { type: picked.type, name: picked.entity.name } : null
  };
  try {
    console.debug('[combat-debug]', payload);
  } catch (err) {
    // ignore
  }
}

function buildCombatEventPayload({
  kind,
  attackerId,
  defenderId,
  attackerRoll,
  defenderRoll,
  hit,
  damage,
  deltaHp,
  deltaSp,
  crit,
  lifesteal,
  view,
  messages
}) {
  return {
    kind,
    attackerId: attackerId || null,
    defenderId: defenderId || null,
    attackerRoll: attackerRoll == null ? null : roundInt(attackerRoll),
    defenderRoll: defenderRoll == null ? null : roundInt(defenderRoll),
    hit: !!hit,
    damage: roundInt(damage || 0),
    delta_hp: roundInt(deltaHp || 0),
    delta_sp: roundInt(deltaSp || 0),
    crit: !!crit,
    lifesteal: roundInt(lifesteal || 0),
    view,
    messages
  };
}

function selectMonsterByName(loc, locationKey, name) {
  if (!loc || !Array.isArray(loc.monsters)) return null;
  const target = name.toLowerCase();
  for (const monster of loc.monsters) {
    if (!monster || typeof monster.name !== 'string') continue;
    if (monster.name.toLowerCase() === target) {
      return { type: 'monster', entity: monster, locationKey };
    }
  }
  return null;
}

function selectPlayerByName(ctx, name) {
  const matches = ctx.listPlayersByName(name).filter(player => {
    if (!player || player.accountId === ctx.c.accountId) return false;
    if (!player.position) return false;
    if (player.position.x !== ctx.c.position.x) return false;
    if (player.position.y !== ctx.c.position.y) return false;
    if (player.position.z !== ctx.c.position.z) return false;
    if (typeof player.hp === 'number' && player.hp <= 0) return false;
    return true;
  });
  return matches.length > 0 ? { type: 'player', entity: matches[0] } : null;
}

function buildRandomCandidates(ctx, loc, locationKey) {
  const candidates = [];
  if (Array.isArray(loc?.monsters)) {
    const living = loc.monsters.filter(m => m && roundInt(m.hp) > 0);
    const nonGuardian = living.filter(m => !m.guardian);
    const pool = nonGuardian.length > 0 ? nonGuardian : living;
    for (const monster of pool) {
      candidates.push({ type: 'monster', entity: monster, locationKey });
    }
  }
  for (const user of ctx.users) {
    const player = user?.character;
    if (!player || player === ctx.c) continue;
    if (!player.position) continue;
    if (player.position.x !== ctx.c.position.x) continue;
    if (player.position.y !== ctx.c.position.y) continue;
    if (player.position.z !== ctx.c.position.z) continue;
    if (typeof player.hp === 'number' && player.hp <= 0) continue;
    candidates.push({ type: 'player', entity: player });
  }
  return candidates;
}

async function attack(cmd, targeted, cost, ctx, logs) {
  const { c, worldMap, fmt } = ctx;
  const currentAction = roundInt(c.action);
  if (currentAction < cost) {
    logs.push('行動值不足');
    return;
  }

  const maxAction = getMaxAction(c);
  const remainingAction = clampInt(currentAction - cost, 0, maxAction);
  c.action = remainingAction;
  c.lastActionUpdate = Date.now();
  ctx.markPlayerDirty?.(c.accountId);

  const locationKey = `${c.position.x},${c.position.y},${c.position.z}`;
  const loc = worldMap[locationKey] || {};
  if (!loc.monsters) loc.monsters = [];

  let selection = null;
  if (targeted) {
    const [, targetNameRaw] = cmd.split('/');
    const targetName = (targetNameRaw || '').trim();
    if (!targetName) {
      logs.push('你找誰？');
      return;
    }
    selection = selectMonsterByName(loc, locationKey, targetName) || selectPlayerByName(ctx, targetName);
    if (!selection) {
      logs.push('你找誰？');
      return;
    }
  } else {
    const candidates = buildRandomCandidates(ctx, loc, locationKey);
    if (candidates.length === 0) {
      logs.push('沒有可以攻擊的目標');
      return;
    }
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    debugCandidates(c.name, candidates, chosen);
    selection = chosen;
  }

  const attackerCombatant = createCombatantFromPlayer(c, ctx);
  const attackerInitialHp = roundInt(c.hp);
  const attackerInitialAction = roundInt(c.action);

  const defenderEntity = selection.entity;
  let defenderCombatant;
  if (selection.type === 'player') {
    defenderCombatant = createCombatantFromPlayer(defenderEntity, ctx);
  } else {
    defenderCombatant = createCombatantFromMonster(defenderEntity, ctx, selection.locationKey || locationKey);
  }
  const defenderInitialHp = roundInt(defenderCombatant.entity.hp);

  const ownedMonsterFriendly =
    selection.type === 'monster' && loc.owner && loc.owner === c.name;

  const playerStats = buildPlayerStatsForRunAttack(c, ctx);
  const targetLevel = defenderCombatant.level;

  if (ownedMonsterFriendly) {
    const friendlyResult = runFriendlyOnly({ player: playerStats });
    const deltaHp = applyHpChange(c, friendlyResult.delta_hp, ctx, {
      isPlayer: true,
      markPlayerDirty: ctx.markPlayerDirty
    });
    const deltaSp = applyActionChange(c, friendlyResult.delta_sp, ctx.markPlayerDirty);
    const messages = buildFriendlyMessages(c.name, friendlyResult.messages[0], deltaHp, deltaSp, fmt);
    for (const message of messages) logs.push(message);
    queueEvent(ctx, {
      playerId: c.accountId,
      kind: 'friendly',
      payload: buildCombatEventPayload({
        kind: 'friendly',
        attackerId: c.accountId,
        defenderId: null,
        attackerRoll: null,
        defenderRoll: null,
        hit: false,
        damage: 0,
        deltaHp,
        deltaSp,
        view: 'attacker',
        messages
      })
    });
    await ctx.saveMap();
    return;
  }

  const attackOutcome = runAttack({
    player: playerStats,
    target: { level: targetLevel }
  });

  if (attackOutcome.event === 'friendly' || attackOutcome.event === 'mistake') {
    const deltaHp = applyHpChange(c, attackOutcome.delta_hp, ctx, {
      isPlayer: true,
      markPlayerDirty: ctx.markPlayerDirty
    });
    const deltaSp = applyActionChange(c, attackOutcome.delta_sp, ctx.markPlayerDirty);
    const kind = attackOutcome.event === 'friendly' ? 'friendly' : 'fumble';
    const messages = buildFriendlyMessages(c.name, attackOutcome.messages[0], deltaHp, deltaSp, fmt);
    for (const message of messages) logs.push(message);
    queueEvent(ctx, {
      playerId: c.accountId,
      kind,
      payload: buildCombatEventPayload({
        kind,
        attackerId: c.accountId,
        defenderId: selection.type === 'player' ? defenderCombatant.accountId : null,
        attackerRoll: null,
        defenderRoll: null,
        hit: false,
        damage: 0,
        deltaHp,
        deltaSp,
        view: 'attacker',
        messages
      })
    });
    await ctx.saveMap();
    return;
  }

  const attackerMessages = [];
  const defenderMessages = [];

  const initiativeRoll = {
    attacker: roll100(),
    defender: roll100()
  };
  const attackerFirst = initiativeRoll.attacker >= initiativeRoll.defender;

  const first = attackerFirst
    ? { actor: attackerCombatant, opponent: defenderCombatant, actorIsPlayer: true }
    : { actor: defenderCombatant, opponent: attackerCombatant, actorIsPlayer: selection.type === 'player' };
  const second = attackerFirst
    ? { actor: defenderCombatant, opponent: attackerCombatant, actorIsPlayer: selection.type === 'player' }
    : { actor: attackerCombatant, opponent: defenderCombatant, actorIsPlayer: true };

  const performStrike = async ({ actor, opponent }, isCounter) => {
    const strike = await executeStrike(actor, opponent, ctx);
    const actorName = actor.name;
    const opponentName = opponent.name;

    if (strike.hit) {
      let msg = `${actorName}成功對${opponentName}進行攻擊，造成${fmt(strike.damage)}點傷害！`;
      if (strike.crit) msg += '（爆擊！）';
      logs.push(msg);
      attackerMessages.push(msg);
      defenderMessages.push(msg);
      if (strike.lifesteal > 0 && actor.type === 'player') {
        const healMsg = `${actorName}回復了${fmt(strike.lifesteal)}點血量！`;
        logs.push(healMsg);
        attackerMessages.push(healMsg);
        defenderMessages.push(healMsg);
      }
    } else {
      const missMsg = `${actorName}出招落空！`;
      logs.push(missMsg);
      attackerMessages.push(missMsg);
      defenderMessages.push(missMsg);
    }

    if (strike.defenderDefeated) {
      const defeatMsg = `${opponentName}被擊敗了！`;
      logs.push(defeatMsg);
      attackerMessages.push(defeatMsg);
      defenderMessages.push(defeatMsg);
      if (opponent.type === 'player') {
        await ctx.handleDeath(opponent.entity, logs);
      } else {
        await handleMonsterDefeat(opponent.entity, loc, ctx, logs);
      }
    }

    return strike;
  };

  const firstStrike = await performStrike(first, false);

  let secondStrike = null;
  if (!firstStrike.defenderDefeated) {
    secondStrike = await performStrike(second, true);
  }

  if (selection.type === 'monster') {
    loc.monsters = loc.monsters.filter(monster => roundInt(monster.hp) > 0);
  }

  const attackerDeltaHp = roundInt(c.hp) - attackerInitialHp;
  const defenderDeltaHp = roundInt(defenderCombatant.entity.hp) - defenderInitialHp;
  const attackerDeltaSp = roundInt(c.action) - attackerInitialAction;

  const attackerStrike = attackerFirst ? firstStrike : secondStrike;
  const defenderStrike = attackerFirst ? secondStrike : firstStrike;

  queueEvent(ctx, {
    playerId: c.accountId,
    kind: 'combat',
    payload: buildCombatEventPayload({
      kind: 'combat',
      attackerId: c.accountId,
      defenderId: selection.type === 'player' ? defenderCombatant.accountId : null,
      attackerRoll: attackerStrike?.attackerRoll || null,
      defenderRoll: attackerStrike?.defenderRoll || null,
      hit: !!attackerStrike?.hit,
      damage: attackerStrike?.damage || 0,
      deltaHp: attackerDeltaHp,
      deltaSp: attackerDeltaSp,
      crit: !!attackerStrike?.crit,
      lifesteal: attackerStrike?.lifesteal || 0,
      view: 'attacker',
      messages: attackerMessages
    })
  });

  if (selection.type === 'player') {
    queueEvent(ctx, {
      playerId: defenderCombatant.accountId,
      kind: 'combat',
      payload: buildCombatEventPayload({
        kind: 'combat',
        attackerId: c.accountId,
        defenderId: defenderCombatant.accountId,
        attackerRoll: defenderStrike?.attackerRoll || null,
        defenderRoll: defenderStrike?.defenderRoll || null,
        hit: !!defenderStrike?.hit,
        damage: defenderStrike?.damage || 0,
        deltaHp: defenderDeltaHp,
        deltaSp: 0,
        crit: !!defenderStrike?.crit,
        lifesteal: defenderStrike?.lifesteal || 0,
        view: 'defender',
        messages: defenderMessages
      })
    });
  }

  await ctx.saveMap();
}

module.exports = {
  handlers: {
    歐拉: (ctx, logs) => attack('歐拉', false, 1, ctx, logs)
  },
  prefixHandlers: [
    {
      prefix: '歐拉/',
      handler: (cmd, ctx, logs) => attack(cmd, true, 10, ctx, logs)
    }
  ]
};
