const combat = require('../commands/combat');

describe('combat command', () => {
  test('low morality still allows attack success', async () => {
    const logs = [];
    const originalRandom = Math.random;
    Math.random = () => 0; // guarantee lowest roll
    const ctx = {
      c: { name: 'Hero', action: 100, position: { x: 0, y: 0, z: 0 }, morality: -20, attack: 5 },
      users: [],
      worldMap: { '0,0,0': { monsters: [{ name: 'Slime', hp: 10 }] } },
      handleDeath: async () => {},
      fmt: v => v,
      saveMap: async () => {},
      monsterDrop: async () => {}
    };
    await combat.prefixHandlers[0].handler('歐拉/Slime', ctx, logs);
    Math.random = originalRandom;
    expect(logs).not.toContain('攻擊失敗');
    expect(ctx.worldMap['0,0,0'].monsters[0].hp).toBe(5);
  });

  test('defeating guardian reverts area to 荒山野嶺 and preserves level', async () => {
    const logs = [];
    const originalRandom = Math.random;
    Math.random = () => 0;
    const saveMap = jest.fn().mockResolvedValue();
    const ctx = {
      c: {
        name: 'Hero',
        action: 100,
        position: { x: 0, y: 0, z: 0 },
        morality: 50,
        attack: 999
      },
      users: [],
      worldMap: {
        '0,0,0': {
          name: '奇幻森林',
          owner: 'Hero',
          level: 7,
          initialLevel: 7,
          description: '翠綠的森林',
          monsters: [
            {
              name: '奇幻森林_守護神',
              guardian: true,
              hp: 5,
              maxHp: 5,
              level: 7,
              attack: 10,
              exp: 20
            }
          ],
          returnMark: true
        }
      },
      handleDeath: jest.fn(),
      fmt: v => v,
      saveMap,
      monsterDrop: jest.fn()
    };

    try {
      await combat.prefixHandlers[0].handler('歐拉/奇幻森林_守護神', ctx, logs);
    } finally {
      Math.random = originalRandom;
    }

    const loc = ctx.worldMap['0,0,0'];
    expect(loc.name).toBe('荒山野嶺');
    expect(loc.owner).toBeUndefined();
    expect(loc.level).toBe(7);
    expect(loc.initialLevel).toBe(7);
    expect(loc.description).toBe('守護神殞落後，奇幻森林再度化為荒山野嶺。');
    expect(loc.monsters).toEqual([]);
    expect(loc.returnMark).toBeUndefined();
    expect(saveMap).toHaveBeenCalled();
  });
});
