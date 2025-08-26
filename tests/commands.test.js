const dispatch = require('../commands');

describe('command dispatcher', () => {
  test('help lists commands', async () => {
    const logs = [];
    await dispatch('help', {}, logs);
    expect(logs[0]).toMatch(/指令列表/);
  });

  test('unknown command echoes back', async () => {
    const logs = [];
    await dispatch('foobar', {}, logs);
    expect(logs[0]).toBe('foobar');
  });

  test('rest binds point and sets status', async () => {
    const ctx = {
      c: { position: { x: 1, y: 2, z: 3 }, bindPoint: null, status: '醒著' },
      getLocationInfo: () => ({ returnMark: true })
    };
    const logs = [];
    await dispatch('歐歐睏', ctx, logs);
    expect(ctx.c.bindPoint).toEqual({ x: 1, y: 2, z: 3 });
    expect(ctx.c.status).toBe('眼睛閉著');
    expect(logs[0]).toBe('歐歐睏，一暝大一寸。');
  });
});
