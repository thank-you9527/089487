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
});
