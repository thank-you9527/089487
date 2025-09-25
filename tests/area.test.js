const area = require('../commands/area');

describe('area command', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('孵化同地區最多五隻怪物', async () => {
    const handler = area.prefixHandlers.find(h => h.prefix === '孵化/').handler;
    const key = '0,0,0';
    const ctx = {
      c: {
        name: 'Trainer',
        action: 10,
        lastActionUpdate: 0,
        position: { x: 0, y: 0, z: 0 }
      },
      worldMap: {
        [key]: {
          name: '巢穴',
          owner: 'Trainer',
          level: 1,
          monsters: []
        }
      },
      monsterNameRegex: /^[A-Za-z0-9\u4E00-\u9FFF]{3,11}$/,
      attackAtLevel: () => 10,
      hpAtLevel: () => 100,
      expGainForLevel: () => 20,
      fmt: v => v,
      saveMap: jest.fn(async () => {})
    };

    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const successLogs = [];
      for (let i = 0; i < 5; i++) {
        await handler(`孵化/怪物${i}`, ctx, successLogs);
      }
      expect(ctx.worldMap[key].monsters).toHaveLength(5);
      expect(ctx.saveMap).toHaveBeenCalledTimes(5);

      const failLogs = [];
      await handler('孵化/超額怪', ctx, failLogs);
      expect(failLogs).toContain('孵化上限');
      expect(ctx.worldMap[key].monsters).toHaveLength(5);
      expect(ctx.saveMap).toHaveBeenCalledTimes(5);
    } finally {
      Math.random = originalRandom;
    }
  });

  test('首次佔領會寫入 initialLevel 並生出守護神', async () => {
    const handler = area.prefixHandlers.find(h => h.prefix === '佔領/').handler;
    const key = '1,2,3';
    const logs = [];
    const defaultInfo = { owner: '無所屬', name: '未開拓之地' };
    const ctx = {
      c: {
        name: 'Alice',
        level: 10,
        action: 5,
        lastActionUpdate: 0,
        position: { x: 1, y: 2, z: 3 }
      },
      worldMap: {},
      areaNameRegex: /^[A-Za-z0-9\u4E00-\u9FFF]{2,12}$/,
      getLocationInfo: () => defaultInfo,
      formatLocationInfo: () => 'info',
      attackAtLevel: lvl => lvl * 2,
      hpAtLevel: lvl => lvl * 10,
      expGainForLevel: lvl => lvl * 3,
      saveMap: jest.fn(async () => {})
    };
    ctx.getLocationInfo = jest.fn(() => ctx.worldMap[key] || defaultInfo);

    const randomValues = [0, 0, 1, 0.5];
    jest.spyOn(Math, 'random').mockImplementation(() => {
      return randomValues.length ? randomValues.shift() : 0;
    });

    await handler('佔領/傑尼的家', ctx, logs);

    const loc = ctx.worldMap[key];
    expect(loc.initialLevel).toBe(1);
    expect(loc.level).toBe(1);
    expect(loc.monsters).toHaveLength(1);
    const guardian = loc.monsters[0];
    expect(guardian.name).toBe('傑尼的家_守護神');
    expect(guardian.guardian).toBe(true);
    expect(guardian.attack).toBe(guardian.level * 2);
    expect(guardian.hp).toBe(guardian.level * 10);
    expect(guardian.maxHp).toBe(guardian.level * 10);
    expect(guardian.exp).toBe(guardian.level * 3);
    const base = loc.level * 10;
    const min = Math.max(1, base - 5);
    const max = Math.min(5000, base + 5);
    expect(guardian.level).toBeGreaterThanOrEqual(min);
    expect(guardian.level).toBeLessThanOrEqual(max);
  });

  test('再次佔領沿用首次 initialLevel 並替換守護神', async () => {
    const handler = area.prefixHandlers.find(h => h.prefix === '佔領/').handler;
    const key = '4,5,6';
    const logs = [];
    const defaultInfo = { owner: '無所屬', name: '廢墟' };
    const regularMonster = { name: '普通怪', level: 3 };
    const ctx = {
      c: {
        name: 'Bob',
        level: 80,
        action: 5,
        lastActionUpdate: 0,
        position: { x: 4, y: 5, z: 6 }
      },
      worldMap: {
        [key]: {
          name: '廢墟',
          owner: '無所屬',
          level: 1,
          initialLevel: 7,
          monsters: [regularMonster, { name: '舊守護神', guardian: true, level: 9 }],
          description: '風很大'
        }
      },
      areaNameRegex: /^[A-Za-z0-9\u4E00-\u9FFF]{2,12}$/,
      getLocationInfo: () => defaultInfo,
      formatLocationInfo: () => 'info',
      attackAtLevel: lvl => lvl + 1,
      hpAtLevel: lvl => lvl + 2,
      expGainForLevel: lvl => lvl + 3,
      saveMap: jest.fn(async () => {})
    };
    ctx.getLocationInfo = jest.fn(() => ctx.worldMap[key] || defaultInfo);

    const randomValues = [0, 0.3, 1, 0.25];
    jest.spyOn(Math, 'random').mockImplementation(() => {
      return randomValues.length ? randomValues.shift() : 0;
    });

    await handler('佔領/重建之地', ctx, logs);

    const loc = ctx.worldMap[key];
    expect(loc.initialLevel).toBe(7);
    expect(loc.level).toBe(7);
    expect(loc.monsters).toContain(regularMonster);
    const guardian = loc.monsters.find(m => m.guardian);
    expect(guardian).toBeDefined();
    expect(guardian.name).toBe('重建之地_守護神');
    expect(guardian.level).toBeGreaterThanOrEqual(1);
    expect(guardian.attack).toBe(guardian.level + 1);
    expect(guardian.hp).toBe(guardian.level + 2);
    expect(guardian.exp).toBe(guardian.level + 3);
  });

  test('特殊地名不會生成守護神', async () => {
    const handler = area.prefixHandlers.find(h => h.prefix === '佔領/').handler;
    const key = '7,8,9';
    const logs = [];
    const defaultInfo = { owner: '無所屬', name: '未開拓之地' };
    const ctx = {
      c: {
        name: 'Cathy',
        level: 5,
        action: 5,
        lastActionUpdate: 0,
        position: { x: 7, y: 8, z: 9 }
      },
      worldMap: {},
      areaNameRegex: /^[A-Za-z0-9\u4E00-\u9FFF]{2,12}$/,
      getLocationInfo: () => defaultInfo,
      formatLocationInfo: () => 'info',
      attackAtLevel: lvl => lvl,
      hpAtLevel: lvl => lvl,
      expGainForLevel: lvl => lvl,
      saveMap: jest.fn(async () => {})
    };
    ctx.getLocationInfo = jest.fn(() => ctx.worldMap[key] || defaultInfo);

    const randomValues = [0, 0, 1];
    jest.spyOn(Math, 'random').mockImplementation(() => {
      return randomValues.length ? randomValues.shift() : 0;
    });

    await handler('佔領/廢墟', ctx, logs);

    const loc = ctx.worldMap[key];
    expect(loc.initialLevel).toBe(1);
    expect(loc.monsters).toEqual([]);
  });
});
