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
});
