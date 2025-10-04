const inventory = require('../commands/inventory');

describe('inventory command outputs', () => {
  test('lists items with prefix and level and handles empty bag', () => {
    const emptyLogs = [];
    const emptyCtx = { c: { name: 'Hero', inventory: [] }, fmt: n => n };
    inventory.handlers['查看家當'](emptyCtx, emptyLogs);
    expect(emptyLogs[0]).toContain('背包空空如也');

    const logs = [];
    const ctx = {
      c: {
        name: 'Hero',
        inventory: [
          { prefix: 'brave', name: '木刀', level: 12 },
          { name: '石盾', level: 5 }
        ]
      },
      fmt: n => n
    };
    inventory.handlers['查看家當'](ctx, logs);
    expect(logs[0]).toContain('Hero的所有家當！');
    expect(logs[0]).toContain('1.brave 木刀 Lv.12');
    expect(logs[0]).toContain('2.石盾 Lv.5');
  });

  test('legacy detail command guides players to new usage', () => {
    const logs = [];
    inventory.prefixHandlers[0].handler('查看家當/木刀', { c: { inventory: [] } }, logs);
    expect(logs[0]).toContain('讓我看看/前綴+名稱');
  });
});
