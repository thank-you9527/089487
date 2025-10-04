const { addItemToInventory, INVENTORY_CAP } = require('../lib/inventory');

describe('inventory capacity enforcement', () => {
  test('adding past capacity drops lowest level item and emits event', () => {
    const owner = {
      accountId: 'player-1',
      inventory: Array.from({ length: INVENTORY_CAP }, (_, i) => ({
        name: `Item${i + 1}`,
        level: i + 1
      }))
    };
    const events = [];
    const originalRandom = Math.random;
    Math.random = jest.fn(() => 0); // deterministically drop the first candidate

    try {
      const result = addItemToInventory(
        owner,
        { name: 'NewItem', level: 1 },
        { queueEvent: entry => events.push(entry) }
      );
      expect(owner.inventory).toHaveLength(INVENTORY_CAP);
      expect(result.dropped).not.toBeNull();
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('auto_drop');
      expect(events[0].payload.dropped.level).toBe(1);
    } finally {
      Math.random = originalRandom;
    }
  });
});
