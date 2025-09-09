process.env.JWT_SECRET = 'test-secret';
const {
  hpAtLevel,
  attackAtLevel,
  expMaxAtLevel,
  expGainForLevel,
  actionAtLevel
} = require('../server');

const MAX_HP = 9487000;
const MAX_ATK = 8700000;
const MAX_EXP = 9487000;
const MAX_GAIN = 870000;

describe('attribute growth', () => {
  test('level 1 matches targets', () => {
    expect(hpAtLevel(1)).toBe(100);
    expect(attackAtLevel(1)).toBe(10);
    expect(expMaxAtLevel(1)).toBe(100);
    expect(expGainForLevel(1)).toBe(15);
    expect(actionAtLevel(1)).toBe(100);
  });

  test('level 5000 approaches caps', () => {
    expect(Math.abs(hpAtLevel(5000) - MAX_HP)).toBeLessThanOrEqual(1);
    expect(Math.abs(attackAtLevel(5000) - MAX_ATK)).toBeLessThanOrEqual(1);
    expect(Math.abs(expMaxAtLevel(5000) - MAX_EXP)).toBeLessThanOrEqual(1);
    expect(Math.abs(expGainForLevel(5000) - MAX_GAIN)).toBeLessThanOrEqual(1);
    expect(actionAtLevel(300)).toBe(300);
    expect(actionAtLevel(301)).toBe(300);
  });
});
