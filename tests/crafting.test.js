process.env.JWT_SECRET = 'test-secret';
process.env.DATABASE_URL = 'pg-mem://craft-tests';

const db = require('../db');
const crafting = require('../commands/crafting');

const craftHandler = crafting.prefixHandlers.find(h => h.prefix === '捏捏/').handler;
const scrapHandler = crafting.prefixHandlers.find(h => h.prefix === '蛋雕/').handler;
const inspectHandler = crafting.prefixHandlers.find(h => h.prefix === '讓我看看/').handler;

beforeAll(async () => {
  await db.init();
});

describe('crafting commands', () => {
  let accountId;
  let secondAccountId;

  beforeAll(async () => {
    const maker = await db.createAccount('maker', 'hash');
    accountId = maker.id;
    const other = await db.createAccount('other', 'hash');
    secondAccountId = other.id;
  });

  const baseContext = () => ({
    fmt: v => Math.round(v),
    listPlayersByName: () => [],
    listMonstersByName: () => [],
    queueEvent: jest.fn(),
    users: [],
    markPlayerDirty: jest.fn()
  });

  test('maker can craft and refresh their own item', async () => {
    const ctx = baseContext();
    ctx.c = {
      accountId,
      name: '製作者',
      level: 20,
      action: 5,
      inventory: [],
      position: { x: 0, y: 0, z: 0 }
    };
    ctx.users.push({ username: ctx.c.accountId, character: ctx.c });
    const logs = [];

    const originalRandom = Math.random;
    Math.random = jest
      .fn()
      .mockReturnValueOnce(0.1) // tier roll keeps T
      .mockReturnValueOnce(0.01); // prefix roll

    try {
      await db.withTx(async client => {
        ctx.dbClient = client;
        await craftHandler('捏捏/測試用道具', ctx, logs);
      });
    } finally {
      Math.random = originalRandom;
    }

    expect(logs[0]).toBe('製作成功！');
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^道具名稱：/),
        expect.stringMatching(/^等級：/),
        expect.stringMatching(/^製作者：製作者/),
        expect.stringMatching(/^持有者：無/),
        expect.stringMatching(/^能力：/),
        expect.stringMatching(/^描述：/)
      ])
    );
    expect(ctx.c.action).toBe(4);
    expect(ctx.queueEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'craft',
        payload: expect.objectContaining({ base_name: '測試用道具', prefix: 'brave' })
      })
    );

    const crafted = await db.findActiveItemByNameNorm('測試用道具'.normalize('NFKC').toLowerCase());
    expect(crafted).toBeTruthy();
    expect(crafted.prefix).toBe('brave');

    // refresh with new prefix
    const refreshLogs = [];
    Math.random = jest
      .fn()
      .mockReturnValueOnce(0.2) // keep tier
      .mockReturnValueOnce(0.8); // choose different prefix
    try {
      await db.withTx(async client => {
        ctx.dbClient = client;
        await craftHandler('捏捏/測試用道具', ctx, refreshLogs);
      });
    } finally {
      Math.random = originalRandom;
    }
    expect(refreshLogs[0]).toBe('製作成功！');
    expect(refreshLogs).toEqual(expect.arrayContaining(['製作成功！']));
    const refreshed = await db.findActiveItemByNameNorm('測試用道具'.normalize('NFKC').toLowerCase());
    expect(refreshed).toBeTruthy();
    expect(refreshed.prefix).not.toBe('brave');
  });

  test('other player cannot craft same named item until deleted', async () => {
    const ctxOther = baseContext();
    ctxOther.c = {
      accountId: secondAccountId,
      name: '其他人',
      level: 20,
      action: 3,
      inventory: [],
      position: { x: 0, y: 0, z: 0 }
    };
    ctxOther.users.push({ username: ctxOther.c.accountId, character: ctxOther.c });
    const logs = [];

    await db.withTx(async client => {
      ctxOther.dbClient = client;
      await craftHandler('捏捏/測試用道具', ctxOther, logs);
    });

    expect(logs[0]).toBe('此名稱已被另一位玩家使用');
    expect(ctxOther.c.action).toBe(2);

    // give original maker the item and delete it
    const item = await db.findActiveItemByNameNorm('測試用道具'.normalize('NFKC').toLowerCase());
    expect(item).toBeTruthy();
    await db.setItemOwner(item.id, accountId);
    item.ownerId = accountId;

    const ctxDelete = baseContext();
    ctxDelete.c = {
      accountId,
      name: '製作者',
      level: 20,
      action: 3,
      inventory: [item],
      position: { x: 0, y: 0, z: 0 }
    };
    ctxDelete.users.push({ username: ctxDelete.c.accountId, character: ctxDelete.c });
    const deleteLogs = [];
    await db.withTx(async client => {
      ctxDelete.dbClient = client;
      await scrapHandler('蛋雕/測試用道具', ctxDelete, deleteLogs);
    });
    expect(deleteLogs[0]).toBe('已蛋雕測試用道具');

    const removed = await db.findActiveItemByNameNorm('測試用道具'.normalize('NFKC').toLowerCase());
    expect(removed).toBeNull();

    // other player can now craft
    const logsAfter = [];
    const originalRandom = Math.random;
    Math.random = jest
      .fn()
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.05);
    try {
      await db.withTx(async client => {
        ctxOther.dbClient = client;
        await craftHandler('捏捏/測試用道具', ctxOther, logsAfter);
      });
    } finally {
      Math.random = originalRandom;
    }
    expect(logsAfter[0]).toBe('製作成功！');
    expect(logsAfter).toEqual(expect.arrayContaining(['製作成功！']));
  });

  test('inspect shows item details', async () => {
    const item = await db.findActiveItemByNameNorm('測試用道具'.normalize('NFKC').toLowerCase());
    expect(item).toBeTruthy();
    const ctx = baseContext();
    ctx.c = {
      accountId,
      name: '觀察者',
      level: 10,
      action: 3,
      inventory: [],
      position: { x: 0, y: 0, z: 0 }
    };
    ctx.users.push({ username: ctx.c.accountId, character: ctx.c });
    ctx.users.push({ username: item.makerId, character: { accountId: item.makerId, name: '其他人' } });
    const logs = [];
    await db.withTx(async client => {
      ctx.dbClient = client;
      await inspectHandler('讓我看看/驍勇+測試用道具', ctx, logs);
    });
    expect(logs[0]).toContain('製作者：');
    expect(logs[0]).toContain('效果：');
  });
});
