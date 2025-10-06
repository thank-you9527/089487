jest.mock('../db', () => ({
  claimRegionByCoord: jest.fn(),
  spawnMob: jest.fn()
}));

const db = require('../db');
const area = require('../commands/area');

describe('area command', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test('孵化同地區最多五隻怪物', async () => {
    const handler = area.prefixHandlers.find(h => h.prefix === '孵化/').handler;
    const key = '0,0,0';
    const ctx = {
      c: {
        name: 'Trainer',
        accountId: 'acct-1',
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
      queueEvent: jest.fn()
    };
    ctx.listPlayersByName = () => [];
    ctx.isMonsterNameTaken = name =>
      Object.values(ctx.worldMap).some(loc =>
        Array.isArray(loc?.monsters) &&
        loc.monsters.some(mon => mon.name && mon.name.toLowerCase() === name.toLowerCase())
      );
    ctx.getRegionFromDb = jest.fn().mockResolvedValue({ id: 'region-1', ownerAccountId: 'acct-1' });

    db.spawnMob.mockImplementation(async (regionId, payload) => {
      if (payload.name === '超額怪') {
        return { ok: false, reason: 'mob-limit' };
      }
      return {
        ok: true,
        mob: {
          id: `${payload.name}-id`,
          regionId,
          name: payload.name,
          level: payload.level,
          hpMax: payload.hpMax,
          atk: payload.atk,
          isGuardian: false
        }
      };
    });

    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const successLogs = [];
      for (let i = 0; i < 5; i += 1) {
        await handler(`孵化/怪物${i}`, ctx, successLogs);
      }
      expect(ctx.worldMap[key].monsters).toHaveLength(5);
      expect(db.spawnMob).toHaveBeenCalledTimes(5);
      expect(ctx.queueEvent).toHaveBeenCalledTimes(5);

      const failLogs = [];
      await handler('孵化/超額怪', ctx, failLogs);
      expect(failLogs).toContain('孵化上限');
      expect(ctx.worldMap[key].monsters).toHaveLength(5);
      expect(db.spawnMob).toHaveBeenCalledTimes(6);
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
        accountId: 'acct-1',
        level: 10,
        action: 5,
        lastActionUpdate: 0,
        position: { x: 1, y: 2, z: 3 }
      },
      worldMap: {},
      areaNameRegex: /^[A-Za-z0-9\u4E00-\u9FFF]{2,12}$/,
      getLocationInfo: jest.fn(() => defaultInfo),
      formatLocationInfo: () => 'info',
      attackAtLevel: lvl => lvl * 2,
      hpAtLevel: lvl => lvl * 10,
      expGainForLevel: lvl => lvl * 3,
      queueEvent: jest.fn()
    };
    ctx.listPlayersByName = () => [];
    ctx.isMonsterNameTaken = () => false;
    ctx.getRegionFromDb = jest.fn().mockResolvedValue(null);

    const randomValues = [0, 0, 1, 0.5];
    jest.spyOn(Math, 'random').mockImplementation(() => {
      return randomValues.length ? randomValues.shift() : 0;
    });

    db.claimRegionByCoord.mockResolvedValue({
      ok: true,
      region: { id: 'region-1', name: '傑尼的家', level: 1, ownerAccountId: 'acct-1' }
    });
    db.spawnMob.mockImplementation(async (regionId, payload) => ({
      ok: true,
      mob: {
        id: 'guardian-1',
        regionId,
        name: payload.name,
        level: payload.level,
        isGuardian: true
      }
    }));

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
    expect(db.claimRegionByCoord).toHaveBeenCalledWith(1, 2, 3, 'acct-1', { name: '傑尼的家', level: 1 }, undefined);
    expect(ctx.queueEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'region_claimed' })
    );
    expect(ctx.queueEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mob_spawned' })
    );
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
        accountId: 'acct-2',
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
      getLocationInfo: jest.fn(() => defaultInfo),
      formatLocationInfo: () => 'info',
      attackAtLevel: lvl => lvl + 1,
      hpAtLevel: lvl => lvl + 2,
      expGainForLevel: lvl => lvl + 3,
      queueEvent: jest.fn()
    };
    ctx.listPlayersByName = () => [];
    ctx.isMonsterNameTaken = () => false;
    ctx.getRegionFromDb = jest.fn().mockResolvedValue({ id: 'region-2', ownerAccountId: null });

    const randomValues = [0, 0.3, 1, 0.25];
    jest.spyOn(Math, 'random').mockImplementation(() => {
      return randomValues.length ? randomValues.shift() : 0;
    });

    db.claimRegionByCoord.mockResolvedValue({
      ok: true,
      region: { id: 'region-2', name: '重建之地', level: 7, ownerAccountId: 'acct-2' }
    });
    db.spawnMob.mockImplementation(async (regionId, payload) => ({
      ok: true,
      mob: {
        id: 'guardian-2',
        regionId,
        name: payload.name,
        level: payload.level,
        isGuardian: true
      }
    }));

    await handler('佔領/重建之地', ctx, logs);

    const loc = ctx.worldMap[key];
    expect(loc.initialLevel).toBe(7);
    expect(loc.level).toBe(7);
    expect(loc.monsters).toContain(regularMonster);
    const guardian = loc.monsters.find(m => m.guardian);
    expect(guardian).toBeDefined();
    expect(guardian.name).toBe('重建之地_守護神');
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
        accountId: 'acct-3',
        level: 5,
        action: 5,
        lastActionUpdate: 0,
        position: { x: 7, y: 8, z: 9 }
      },
      worldMap: {},
      areaNameRegex: /^[A-Za-z0-9\u4E00-\u9FFF]{2,12}$/,
      getLocationInfo: jest.fn(() => defaultInfo),
      formatLocationInfo: () => 'info',
      attackAtLevel: lvl => lvl,
      hpAtLevel: lvl => lvl,
      expGainForLevel: lvl => lvl,
      queueEvent: jest.fn()
    };
    ctx.getRegionFromDb = jest.fn().mockResolvedValue(null);
    db.claimRegionByCoord.mockResolvedValue({
      ok: true,
      region: { id: 'region-3', name: '廢墟', level: 1, ownerAccountId: 'acct-3' }
    });
    db.spawnMob.mockResolvedValue({ ok: true, mob: null });

    const randomValues = [0, 0, 1];
    jest.spyOn(Math, 'random').mockImplementation(() => {
      return randomValues.length ? randomValues.shift() : 0;
    });

    await handler('佔領/廢墟', ctx, logs);

    const loc = ctx.worldMap[key];
    expect(loc.initialLevel).toBe(1);
    expect(loc.monsters).toEqual([]);
    expect(db.spawnMob).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ isGuardian: true }));
  });
});
