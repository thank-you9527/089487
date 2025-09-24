const area = require('../commands/area');

describe('area command', () => {
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
});
