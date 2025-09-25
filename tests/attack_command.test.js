const attack = require('../commands/attack');
const dispatch = require('../commands');

describe('attack command module', () => {
  test('matches parses both untargeted and targeted forms', () => {
    expect(attack.matches('歐拉')).toEqual({ target: null });
    expect(attack.matches('歐拉/ Slime ')).toEqual({ target: 'Slime' });
    expect(attack.matches('其他指令')).toBe(false);
  });

  test('friendly event heals hp with deterministic seed', () => {
    const res = attack.runAttack({
      player: {
        level: 50,
        morality: 100,
        atk: 80,
        hp: 100,
        hp_max: 200,
        sp: 20,
        sp_max: 50
      },
      target: { level: 50 },
      rng_seed: 17
    });

    expect(res.event).toBe('friendly');
    expect(res.sub_event).toBe('heal_hp');
    expect(res.delta_hp).toBe(67);
    expect(res.delta_sp).toBe(0);
    expect(res.messages[0]).toContain('雲');
    expect(res.probs).toEqual({ p_friendly: 0.12, p_mistake: 0.04, p_attack: 0.84 });
  });

  test('mistake event can inflict hp loss when levels differ greatly', () => {
    const res = attack.runAttack({
      player: {
        level: 40,
        morality: 0,
        atk: 82,
        hp: 180,
        hp_max: 200,
        sp: 30,
        sp_max: 40
      },
      target: { level: 120 },
      rng_seed: 17
    });

    expect(res.event).toBe('mistake');
    expect(res.sub_event).toBe('lose_hp');
    expect(res.delta_hp).toBeLessThan(0);
    expect(res.delta_sp).toBe(0);
    expect(res.messages[0]).toMatch(/你/);
    expect(res.probs.p_mistake).toBeCloseTo(0.1, 5);
  });

  test('attack event succeeds when roll exceeds other probabilities', () => {
    const res = attack.runAttack({
      player: {
        level: 30,
        morality: 0,
        atk: 60,
        hp: 150,
        hp_max: 200,
        sp: 18,
        sp_max: 25
      },
      target: { level: 30 },
      rng_seed: 1
    });

    expect(res.event).toBe('attack');
    expect(res.sub_event).toBe('hit');
    expect(res.delta_hp).toBe(0);
    expect(res.delta_sp).toBe(0);
    expect(res.messages).toEqual(['你順利出招！']);
  });

  test('command module is registered for external routers', () => {
    const registered = dispatch.commandModules || [];
    expect(registered.find((c) => c && c.name === 'attack')).toBeDefined();
  });
});
