const crypto = require('crypto');
const rules = require('../data/combat_rules.json');

// ---- Helpers ----
const toSeed = (seed) => {
  if (seed === undefined || seed === null) return null;
  if (typeof seed === 'number') return seed >>> 0;
  const hash = crypto.createHash('sha256').update(String(seed)).digest();
  return hash.readUInt32BE(0);
};

const rnd = (seed) => {
  const base = toSeed(seed);
  if (base === null) return Math.random;
  let x = Math.imul(2654435761, base || 123456789);
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rint = (n) => Math.round(n);
const choiceWeighted = (rand, arr) => {
  const total = arr.reduce((s, x) => s + (x.weight || 1), 0);
  let t = rand() * total;
  for (const item of arr) {
    t -= (item.weight || 1);
    if (t <= 0) return item;
  }
  return arr[arr.length - 1];
};
const uniformInt = (rand, a, b) => {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return rint(lo + (hi - lo) * rand());
};

// ---- Probabilities ----
function pFriendly(morality) {
  const f = rules.probability.friendly;
  const ratio = clamp(
    (morality - f.morality_min) / (f.morality_max - f.morality_min),
    0,
    1
  );
  return f.p_min + ratio * (f.p_max - f.p_min);
}
function pMistake(playerLv, targetLv) {
  const m = rules.probability.mistake;
  const gap = targetLv == null ? 0 : Math.abs(playerLv - targetLv);
  return m.base + (gap >= m.level_gap_boost.threshold_abs_gap ? m.level_gap_boost.add : 0);
}

// ---- Core runner ----
function runAttack({ player, target = { level: null }, rng_seed }) {
  const rand = rnd(rng_seed);
  const pF = pFriendly(player.morality);
  const pM = pMistake(player.level, target.level);
  const pA = Math.max(0, 1 - pF - pM);

  // roll event
  const roll = rand();
  let event = 'attack';
  if (roll < pF) event = 'friendly';
  else if (roll < pF + pM) event = 'mistake';

  let sub = null;
  let dHP = 0;
  let dSP = 0;
  const msg = [];
  if (event === 'friendly') {
    const pool = rules.friendly_event.distribution;
    const pick = choiceWeighted(rand, pool);
    const baseLine = rules.friendly_event.messages_pool[
      Math.floor(rand() * rules.friendly_event.messages_pool.length)
    ];
    msg.push(baseLine);

    if (pick.type === 'flavor_only') {
      sub = 'flavor';
    } else if (pick.type === 'heal_hp_fraction_of_max') {
      sub = 'heal_hp';
      const amt = rint(player.hp_max * pick.fraction);
      const newHP = clamp(player.hp + amt, 0, player.hp_max);
      dHP = newHP - player.hp;
      msg.push(`你恢復了 ${dHP} 點生命。`);
    } else if (pick.type === 'heal_sp_fixed_with_rares') {
      sub = 'heal_sp';
      const rares = pick.rares || [];
      let sp = pick.base_sp;
      const hitFull = rares.find((r) => r.sp === 'full' && rand() < r.p);
      if (hitFull) {
        sp = player.sp_max - player.sp;
      } else {
        const hit50 = rares.find((r) => r.sp === 50 && rand() < r.p);
        if (hit50) sp = 50;
      }
      sp = rint(sp);
      const newSP = clamp(player.sp + sp, 0, player.sp_max);
      dSP = newSP - player.sp;
      msg.push(dSP > 0 ? `你恢復了 ${dSP} 點體力。` : '你感到平靜。');
    }
  } else if (event === 'mistake') {
    const pool = rules.mistake_event.distribution;
    const pick = choiceWeighted(rand, pool);
    const baseLine = rules.mistake_event.messages_pool[
      Math.floor(rand() * rules.mistake_event.messages_pool.length)
    ];
    msg.push(baseLine);

    if (pick.type === 'flavor_only') {
      sub = 'flavor';
    } else if (pick.type === 'lose_sp_fixed') {
      sub = 'lose_sp';
      const amt = rint(pick.sp);
      const newSP = clamp(player.sp - amt, 0, player.sp_max);
      dSP = newSP - player.sp;
      msg.push(`你消耗了 ${Math.abs(dSP)} 點體力。`);
    } else if (pick.type === 'lose_hp_from_atk') {
      sub = 'lose_hp';
      const rare30 = pick.rare_overrides?.find((r) => r.multiplier_of_atk === 30);
      const rare10 = pick.rare_overrides?.find((r) => r.multiplier_of_atk === 10);
      let loss;
      if (rare30 && rand() < rare30.p) {
        loss = player.atk * rare30.multiplier_of_atk;
      } else if (rare10 && rand() < rare10.p) {
        loss = player.atk * rare10.multiplier_of_atk;
      } else {
        const a = player.atk - 10;
        const b = player.atk + 10;
        const minFloor = pick.random_range?.min_floor ?? 1;
        loss = clamp(uniformInt(rand, a, b), minFloor, Number.MAX_SAFE_INTEGER);
      }
      loss = rint(loss);
      const newHP = clamp(player.hp - loss, 0, player.hp_max);
      dHP = newHP - player.hp;
      msg.push(`你受到了 ${Math.abs(dHP)} 點反噬傷害。`);
    }
  } else {
    sub = 'hit';
    msg.push('你順利出招！');
  }

  dHP = rint(dHP);
  dSP = rint(dSP);

  return {
    event,
    sub_event: sub,
    delta_hp: dHP,
    delta_sp: dSP,
    messages: msg,
    probs: {
      p_friendly: +pF.toFixed(4),
      p_mistake: +pM.toFixed(4),
      p_attack: +pA.toFixed(4)
    }
  };
}

function runFriendlyOnly({ player, rng_seed }) {
  const rand = rnd(rng_seed);
  const pool = rules.friendly_event.distribution;
  const pick = choiceWeighted(rand, pool);
  const baseLine = rules.friendly_event.messages_pool[
    Math.floor(rand() * rules.friendly_event.messages_pool.length)
  ];
  const msg = [baseLine];
  let sub = 'flavor';
  let dHP = 0;
  let dSP = 0;

  if (pick.type === 'heal_hp_fraction_of_max') {
    sub = 'heal_hp';
    const amt = rint(player.hp_max * pick.fraction);
    const newHP = clamp(player.hp + amt, 0, player.hp_max);
    dHP = newHP - player.hp;
    msg.push(`你恢復了 ${dHP} 點生命。`);
  } else if (pick.type === 'heal_sp_fixed_with_rares') {
    sub = 'heal_sp';
    const rares = pick.rares || [];
    let sp = pick.base_sp;
    const hitFull = rares.find(r => r.sp === 'full' && rand() < r.p);
    if (hitFull) {
      sp = player.sp_max - player.sp;
    } else {
      const hit50 = rares.find(r => r.sp === 50 && rand() < r.p);
      if (hit50) sp = 50;
    }
    sp = rint(sp);
    const newSP = clamp(player.sp + sp, 0, player.sp_max);
    dSP = newSP - player.sp;
    msg.push(dSP > 0 ? `你恢復了 ${dSP} 點體力。` : '你感到平靜。');
  }

  return {
    event: 'friendly',
    sub_event: sub,
    delta_hp: rint(dHP),
    delta_sp: rint(dSP),
    messages: msg,
    probs: {
      p_friendly: 1,
      p_mistake: 0,
      p_attack: 0
    }
  };
}

function matches(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed === '歐拉') return { target: null };
  if (trimmed.startsWith('歐拉/')) {
    const target = trimmed.slice(3).trim();
    return { target: target || null };
  }
  return false;
}

module.exports = {
  name: 'attack',
  aliases: rules.commands.attack.aliases,
  matches,
  runAttack,
  runFriendlyOnly
};
