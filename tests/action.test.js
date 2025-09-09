const movement = require('../commands/movement');
const combat = require('../commands/combat');

describe('action point checks', () => {
  test('cannot move with insufficient action points', async () => {
    const ctx = {
      c: { name: 'Hero', action: 0, position: { x: 0, y: 0, z: 0 } },
      pickupItems: async () => {},
      getLocationInfo: () => ({ name: '原地' }),
      formatLocationInfo: () => ''
    };
    const logs = [];
    await movement.handlers['前進'](ctx, logs);
    expect(logs[0]).toBe('行動值不足');
    expect(ctx.c.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(ctx.c.action).toBe(0);
  });

  test('cannot attack with insufficient action points', async () => {
    const ctx = {
      c: {
        name: 'Hero',
        action: 0,
        position: { x: 0, y: 0, z: 0 },
        morality: 0,
        attack: 5
      },
      users: [],
      worldMap: { '0,0,0': { monsters: [{ name: 'Slime', hp: 10 }] } },
      handleDeath: async () => {},
      fmt: v => v,
      saveMap: async () => {},
      monsterDrop: async () => {}
    };
    const logs = [];
    await combat.handlers['歐拉'](ctx, logs);
    expect(logs[0]).toBe('行動值不足');
    expect(ctx.worldMap['0,0,0'].monsters[0].hp).toBe(10);
    expect(ctx.c.action).toBe(0);
  });
});
