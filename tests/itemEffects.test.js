const { aggregateItemEffects, scalePercent } = require('../lib/itemEffects');

describe('item effect aggregation', () => {
  test('brave stacking clamps at fifty percent', () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ prefix: 'brave', level: 500 - i * 50 }));
    const result = aggregateItemEffects(items);
    expect(result.atk_pct_total).toBeCloseTo(0.5, 5);
  });

  test('crit chance uses complementary probability and clamps at thirty percent', () => {
    const levelA = 400;
    const levelB = 200;
    const items = [
      { prefix: 'tiger', level: levelA },
      { prefix: 'tiger', level: levelB }
    ];
    const result = aggregateItemEffects(items);
    const pA = scalePercent(levelA, 0.0005, 0.15);
    const pB = scalePercent(levelB, 0.0005, 0.15);
    const expected = Math.min(0.3, 1 - (1 - pA) * (1 - pB));
    expect(result.crit_pct_total).toBeCloseTo(expected, 5);
  });

  test('lifesteal and dodge stack independently with caps', () => {
    const items = [
      { prefix: 'leech', level: 300 },
      { prefix: 'leech', level: 200 },
      { prefix: 'dodge', level: 500 }
    ];
    const result = aggregateItemEffects(items);
    expect(result.lifesteal_pct_total).toBeLessThanOrEqual(0.3);
    expect(result.dodge_bonus_total).toBeLessThanOrEqual(20);
    expect(result.can_blink).toBe(false);
  });
});
