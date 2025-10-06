const combat = require('../commands/combat');
const { aggregateItemEffects } = require('../lib/itemEffects');

function stubRandom(sequence) {
  const values = Array.from(sequence);
  const original = Math.random;
  let index = 0;
  Math.random = jest.fn(() => {
    const value = values[index] != null ? values[index] : values[values.length - 1] || 0;
    index += 1;
    return value;
  });
  return () => {
    Math.random = original;
  };
}

describe('combat command', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('owned monster attack triggers friendly event and heals player', async () => {
    const restoreRandom = stubRandom([0.75, 0]);
    const events = [];
    const ctx = {
      c: {
        accountId: 'attacker',
        name: 'Hero',
        action: 50,
        maxAction: 60,
        position: { x: 0, y: 0, z: 0 },
        morality: 40,
        level: 10,
        attack: 12,
        hp: 15,
        maxHp: 30
      },
      users: [],
      worldMap: {
        '0,0,0': {
          owner: 'Hero',
          monsters: [
            { name: 'Slime', level: 5, hp: 40, maxHp: 40 }
          ]
        }
      },
      handleDeath: jest.fn(),
      fmt: n => n,
      saveMap: jest.fn().mockResolvedValue(),
      monsterDrop: jest.fn(),
      markPlayerDirty: jest.fn(),
      queueEvent: entry => events.push(entry)
    };
    ctx.listPlayersByName = () => [];

    try {
      await combat.prefixHandlers[0].handler('歐拉/Slime', ctx, []);
    } finally {
      restoreRandom();
    }

    expect(ctx.c.hp).toBe(25);
    expect(ctx.c.action).toBe(40);
    expect(ctx.worldMap['0,0,0'].monsters[0].hp).toBe(40);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('friendly');
    expect(events[0].payload.delta_hp).toBe(10);
  });

  test('targeted attack against another player resolves with counter strike', async () => {
    const restoreRandom = stubRandom([0.95, 0.3, 0.2, 0.1, 0.9, 0.05, 0.9]);
    const defender = {
      accountId: 'defender',
      name: 'Visitor',
      action: 50,
      maxAction: 50,
      position: { x: 0, y: 0, z: 0 },
      morality: 30,
      level: 8,
      attack: 4,
      hp: 20,
      maxHp: 20,
      dodge: 5
    };
    const logs = [];
    const events = [];
    const ctx = {
      c: {
        accountId: 'attacker',
        name: 'Hero',
        action: 20,
        maxAction: 30,
        position: { x: 0, y: 0, z: 0 },
        morality: 40,
        level: 12,
        attack: 10,
        hp: 30,
        maxHp: 30,
        dodge: 3
      },
      users: [{ character: defender }],
      worldMap: { '0,0,0': { owner: 'Hero', monsters: [] } },
      handleDeath: jest.fn(),
      fmt: n => n,
      saveMap: jest.fn().mockResolvedValue(),
      monsterDrop: jest.fn(),
      markPlayerDirty: jest.fn(),
      queueEvent: entry => events.push(entry)
    };
    ctx.listPlayersByName = name =>
      name.toLowerCase() === 'visitor' ? [defender] : [];

    try {
      await combat.prefixHandlers[0].handler('歐拉/Visitor', ctx, logs);
    } finally {
      restoreRandom();
    }

    expect(defender.hp).toBe(10);
    expect(ctx.c.hp).toBe(26);
    expect(events.filter(e => e.kind === 'combat')).toHaveLength(2);
    expect(logs.some(line => line.includes('Hero成功對Visitor進行攻擊'))).toBe(true);
    expect(logs.some(line => line.includes('Visitor成功對Hero進行攻擊'))).toBe(true);
  });

  test('random attack can select owned monster for friendly then other player', async () => {
    const restoreRandom = stubRandom([
      0, // first attack -> choose monster
      0.8, 0, // friendly distribution + message
      0.6, // second attack -> choose player candidate
      0.95, // runAttack event -> attack branch
      0.4, 0.3, // initiative rolls
      0.1, 0.9 // accuracy and dodge for player strike
    ]);
    const otherPlayer = {
      accountId: 'visitor',
      name: 'Visitor',
      action: 20,
      maxAction: 20,
      position: { x: 0, y: 0, z: 0 },
      morality: 30,
      level: 5,
      attack: 3,
      hp: 18,
      maxHp: 18
    };
    const logs = [];
    const events = [];
    const ctx = {
      c: {
        accountId: 'attacker',
        name: 'Hero',
        action: 30,
        maxAction: 30,
        position: { x: 0, y: 0, z: 0 },
        morality: 40,
        level: 10,
        attack: 8,
        hp: 25,
        maxHp: 30
      },
      users: [{ character: otherPlayer }],
      worldMap: {
        '0,0,0': {
          owner: 'Hero',
          monsters: [{ name: 'Pet', level: 3, hp: 15, maxHp: 15 }]
        }
      },
      handleDeath: jest.fn(),
      fmt: n => n,
      saveMap: jest.fn().mockResolvedValue(),
      monsterDrop: jest.fn(),
      markPlayerDirty: jest.fn(),
      queueEvent: entry => events.push(entry)
    };
    ctx.listPlayersByName = name =>
      name.toLowerCase() === 'visitor' ? [otherPlayer] : [];

    try {
      await combat.handlers['歐拉'](ctx, logs);
      await combat.handlers['歐拉'](ctx, logs);
    } finally {
      restoreRandom();
    }

    expect(ctx.worldMap['0,0,0'].monsters[0].hp).toBe(15);
    expect(otherPlayer.hp).toBe(10);
    expect(events.filter(e => e.kind === 'friendly')).toHaveLength(1);
    expect(events.filter(e => e.kind === 'combat')).toHaveLength(2);
  });

  test('killing a monster records DB kill and queues events', async () => {
    const restoreRandom = stubRandom([0.5, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]);
    const logs = [];
    const events = [];
    const defeated = [];
    const ctx = {
      c: {
        accountId: 'attacker',
        name: 'Hero',
        action: 10,
        maxAction: 10,
        position: { x: 0, y: 0, z: 0 },
        morality: 40,
        level: 20,
        attack: 50,
        hp: 100,
        maxHp: 100
      },
      users: [],
      worldMap: {
        '0,0,0': {
          owner: 'Rival',
          level: 5,
          monsters: [{ id: 'mob-1', name: 'Slime', level: 5, hp: 10, maxHp: 10 }]
        }
      },
      handleDeath: jest.fn(),
      fmt: n => n,
      monsterDrop: jest.fn().mockImplementation(async monster => {
        defeated.push({ ...monster });
      }),
      markPlayerDirty: jest.fn(),
      queueEvent: entry => events.push(entry),
      getRegionFromDb: jest.fn().mockResolvedValue({ id: 'region-1', name: 'Test' }),
      maybeRespawnMobs: jest.fn().mockResolvedValue({ ok: true, mobs: [] }),
      listRegionMobsFromDb: jest.fn().mockResolvedValue([
        {
          id: 'mob-1',
          name: 'Slime',
          level: 5,
          atk: 12,
          hpMax: 30,
          alive: true,
          isGuardian: false
        }
      ]),
      killMobInDb: jest.fn().mockResolvedValue({
        ok: true,
        mob: { id: 'mob-1', name: 'Slime', level: 5, isGuardian: false, respawnAt: '2024-01-01T00:00:00.000Z' },
        region: { id: 'region-1', isSystem: false }
      })
    };
    ctx.listPlayersByName = () => [];

    try {
      await combat.prefixHandlers[0].handler('歐拉/Slime', ctx, logs);
    } finally {
      restoreRandom();
    }

    expect(defeated[0]?.id || defeated[0]?.name).toBeTruthy();
    expect(ctx.killMobInDb).toHaveBeenCalledWith('mob-1', expect.objectContaining({ respawnDelayMs: expect.any(Number), now: expect.any(Date) }));
    expect(ctx.monsterDrop).toHaveBeenCalled();
    expect(ctx.worldMap['0,0,0'].monsters).toHaveLength(0);
    expect(events.some(event => event.kind === 'mob_killed')).toBe(true);
    const killEvent = events.find(event => event.kind === 'mob_killed');
    expect(killEvent.payload.regionId).toBe('region-1');
    expect(killEvent.payload.mob.id).toBe('mob-1');
    expect(logs.some(line => line.includes('被擊敗了'))).toBe(true);
  });

  test('stacked brave items boost damage up to fifty percent', async () => {
    const restoreRandom = stubRandom([0.9, 0.1, 0.0, 0.0, 0.99, 0.99]);
    const defender = {
      accountId: 'defender',
      name: 'Visitor',
      action: 50,
      maxAction: 50,
      position: { x: 0, y: 0, z: 0 },
      morality: 30,
      level: 8,
      attack: 4,
      hp: 40,
      maxHp: 40,
      dodge: 0,
      inventory: []
    };
    const logs = [];
    const events = [];
    const ctx = {
      c: {
        accountId: 'attacker',
        name: 'Hero',
        action: 20,
        maxAction: 30,
        position: { x: 0, y: 0, z: 0 },
        morality: 40,
        level: 12,
        attack: 10,
        hp: 30,
        maxHp: 30,
        inventory: [
          { prefix: 'brave', level: 500 },
          { prefix: 'brave', level: 450 },
          { prefix: 'brave', level: 400 }
        ]
      },
      users: [{ character: defender }],
      worldMap: { '0,0,0': { owner: 'Hero', monsters: [] } },
      handleDeath: jest.fn(),
      fmt: n => n,
      saveMap: jest.fn().mockResolvedValue(),
      monsterDrop: jest.fn(),
      markPlayerDirty: jest.fn(),
      queueEvent: entry => events.push(entry)
    };
    ctx.listPlayersByName = name =>
      name.toLowerCase() === 'visitor' ? [defender] : [];

    try {
      await combat.prefixHandlers[0].handler('歐拉/Visitor', ctx, logs);
    } finally {
      restoreRandom();
    }

    expect(defender.hp).toBe(25);
    const combatEvent = events.find(e => e.kind === 'combat' && e.playerId === 'attacker');
    expect(combatEvent.payload.damage).toBe(15);
    expect(combatEvent.payload.crit).toBe(false);
  });

  test('lifesteal heals attacker based on damage dealt', async () => {
    const restoreRandom = stubRandom([0.9, 0.2, 0.1, 0.0, 0.99, 0.99]);
    const defender = {
      accountId: null,
      name: 'Slime',
      action: 0,
      position: { x: 0, y: 0, z: 0 },
      morality: 0,
      level: 5,
      attack: 4,
      hp: 120,
      maxHp: 120,
      dodge: 0
    };
    const logs = [];
    const events = [];
    const ctx = {
      c: {
        accountId: 'attacker',
        name: 'Hero',
        action: 20,
        maxAction: 30,
        position: { x: 0, y: 0, z: 0 },
        morality: 40,
        level: 12,
        attack: 40,
        hp: 50,
        maxHp: 100,
        inventory: [
          { prefix: 'leech', level: 300 },
          { prefix: 'leech', level: 200 }
        ]
      },
      users: [],
      worldMap: { '0,0,0': { owner: 'Enemy', monsters: [defender] } },
      handleDeath: jest.fn(),
      fmt: n => n,
      saveMap: jest.fn().mockResolvedValue(),
      monsterDrop: jest.fn(),
      markPlayerDirty: jest.fn(),
      queueEvent: entry => events.push(entry)
    };
    ctx.listPlayersByName = () => [];

    const effects = aggregateItemEffects(ctx.c.inventory);
    const expectedHeal = Math.round(40 * Math.min(0.3, effects.lifesteal_pct_total));

    try {
      await combat.prefixHandlers[0].handler('歐拉/Slime', ctx, logs);
    } finally {
      restoreRandom();
    }

    expect(ctx.c.hp).toBe(50 + expectedHeal);
    const combatEvent = events.find(e => e.kind === 'combat' && e.playerId === 'attacker');
    expect(combatEvent.payload.lifesteal).toBe(expectedHeal);
  });

  test('dodge prefix increases defender dodge chance', async () => {
    const restoreRandom = stubRandom([0.9, 0.2, 0.1, 0.0, 0.05]);
    const defender = {
      accountId: 'defender',
      name: 'Visitor',
      action: 20,
      maxAction: 20,
      position: { x: 0, y: 0, z: 0 },
      morality: 30,
      level: 8,
      attack: 4,
      hp: 30,
      maxHp: 30,
      dodge: 5,
      inventory: [
        { prefix: 'dodge', level: 500 },
        { prefix: 'dodge', level: 400 }
      ]
    };
    const logs = [];
    const events = [];
    const ctx = {
      c: {
        accountId: 'attacker',
        name: 'Hero',
        action: 20,
        maxAction: 30,
        position: { x: 0, y: 0, z: 0 },
        morality: 40,
        level: 12,
        attack: 10,
        hp: 30,
        maxHp: 30,
        inventory: []
      },
      users: [{ character: defender }],
      worldMap: { '0,0,0': { owner: 'Hero', monsters: [] } },
      handleDeath: jest.fn(),
      fmt: n => n,
      saveMap: jest.fn().mockResolvedValue(),
      monsterDrop: jest.fn(),
      markPlayerDirty: jest.fn(),
      queueEvent: entry => events.push(entry)
    };
    ctx.listPlayersByName = name =>
      name.toLowerCase() === 'visitor' ? [defender] : [];

    try {
      await combat.prefixHandlers[0].handler('歐拉/Visitor', ctx, logs);
    } finally {
      restoreRandom();
    }

    expect(defender.hp).toBe(30);
    const attackerEvent = events.find(e => e.kind === 'combat' && e.playerId === 'attacker');
    expect(attackerEvent.payload.hit).toBe(false);
  });
});
