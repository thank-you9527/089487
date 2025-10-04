const INVENTORY_CAP = 10;

function sanitizeItem(item) {
  if (!item || typeof item !== 'object') return { id: null, name: null, level: 0 };
  return {
    id: item.id ?? null,
    name: item.name ?? null,
    level: typeof item.level === 'number' ? item.level : 0,
    prefix: typeof item.prefix === 'string' ? item.prefix : null
  };
}

function addItemToInventory(owner, item, options = {}) {
  if (!owner) return { added: null, dropped: null };
  const inventory = Array.isArray(owner.inventory) ? owner.inventory : (owner.inventory = []);
  inventory.push(item);
  if (typeof options.onAdd === 'function') {
    try {
      options.onAdd(item);
    } catch (err) {
      // ignore callback errors
    }
  }
  if (inventory.length <= INVENTORY_CAP) {
    return { added: item, dropped: null };
  }

  const levels = inventory.map(it => (typeof it?.level === 'number' ? it.level : 0));
  const minLv = levels.length > 0 ? Math.min(...levels) : 0;
  const lowest = inventory.filter(it => (typeof it?.level === 'number' ? it.level : 0) === minLv);
  const discard = lowest[Math.floor(Math.random() * lowest.length)] || null;
  if (discard) {
    const idx = inventory.indexOf(discard);
    if (idx >= 0) inventory.splice(idx, 1);
    if (typeof options.queueEvent === 'function' && owner.accountId) {
      options.queueEvent({
        playerId: owner.accountId,
        kind: 'auto_drop',
        payload: {
          dropped: sanitizeItem(discard)
        }
      });
    }
    if (typeof options.onDrop === 'function') {
      try {
        options.onDrop(discard);
      } catch (err) {
        // ignore callback errors
      }
    }
  }
  return { added: item, dropped: discard };
}

module.exports = {
  INVENTORY_CAP,
  addItemToInventory,
  sanitizeItem
};
