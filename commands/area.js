const db = require('../db');

const rollMonsterLevel = areaLevel => {
  const rl = Math.max(1, areaLevel || 1);
  const base = rl * 10;
  let delta;
  if (rl <= 10) delta = 5;
  else if (rl <= 50) delta = 10;
  else if (rl <= 150) delta = 150;
  else if (rl <= 300) delta = 430;
  else delta = 500;
  const min = Math.max(1, base - delta);
  const max = Math.min(5000, base + delta);
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

function normalizeName(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function findMonsterIndex(list, name) {
  if (!Array.isArray(list)) return -1;
  const target = normalizeName(name);
  if (!target) return -1;
  return list.findIndex(monster => normalizeName(monster?.name) === target);
}

module.exports = {
  handlers: {
    '歐歐睏': (ctx, logs) => {
      const info = ctx.getLocationInfo(ctx.c.position);
      if (info.returnMark) {
        ctx.c.bindPoint = { ...ctx.c.position };
        ctx.c.status = '眼睛閉著';
        logs.push('歐歐睏，一暝大一寸。');
      } else {
        logs.push('你要確定欸');
      }
    }
  },
  prefixHandlers: [
    {
      prefix: '佔領/',
      handler: async (cmd, ctx, logs) => {
        const areaName = cmd.split('/')[1];
        const currentAction = Math.round(ctx.c.action ?? 0);
        if (currentAction < 1) {
          logs.push('行動值不足');
          return;
        }
        ctx.c.action = Math.max(0, currentAction - 1);
        ctx.c.lastActionUpdate = Date.now();
        ctx.markPlayerDirty?.(ctx.c.accountId);

        const info = ctx.getLocationInfo(ctx.c.position);
        const normalizedAreaName = normalizeName(areaName);
        const nameTakenInMap = Object.entries(ctx.worldMap).some(([key, loc]) => {
          if (!loc || !loc.name || loc.name === '廢墟') return false;
          if (normalizeName(loc.name) !== normalizedAreaName) return false;
          const [x, y, z] = key.split(',').map(Number);
          return !(x === ctx.c.position.x && y === ctx.c.position.y && z === ctx.c.position.z);
        });
        const dbRegion = ctx.getRegionFromDb ? await ctx.getRegionFromDb(ctx.c.position) : null;
        const hasDbOwner = dbRegion?.ownerAccountId && dbRegion.ownerAccountId !== ctx.c.accountId;

        if (
          !areaName ||
          !ctx.areaNameRegex.test(areaName) ||
          nameTakenInMap ||
          hasDbOwner ||
          info.owner !== '無所屬' ||
          (info.name !== '未開拓之地' && info.name !== '廢墟')
        ) {
          logs.push(nameTakenInMap ? '名稱已被使用' : '無法佔領');
          return;
        }

        let chance = 1;
        const lvl = ctx.c.level;
        if (lvl >= 11 && lvl <= 50) chance = 0.9;
        else if (lvl <= 200) chance = 0.8;
        else if (lvl <= 450) chance = 0.7;
        else if (lvl >= 451) chance = 0.65;

        if (Math.random() >= chance) {
          logs.push('啪，沒了');
          return;
        }

        const key = `${ctx.c.position.x},${ctx.c.position.y},${ctx.c.position.z}`;
        const existing = ctx.worldMap[key] || {};
        let initialLevel = existing.initialLevel;
        if (initialLevel == null) {
          const maxLv = Math.max(1, Math.floor(ctx.c.level / 10));
          initialLevel = Math.floor(Math.random() * maxLv) + 1;
        }
        const existingMonsters = Array.isArray(existing.monsters)
          ? existing.monsters.filter(Boolean)
          : [];
        const monstersWithoutGuardians = existingMonsters.filter(m => !m.guardian);

        const claimResult = await db.claimRegionByCoord(
          ctx.c.position.x,
          ctx.c.position.y,
          ctx.c.position.z,
          ctx.c.accountId,
          { name: areaName, level: initialLevel },
          ctx.dbClient
        );

        if (!claimResult?.ok) {
          if (claimResult?.reason === 'name-taken') {
            logs.push('名稱已被使用');
          } else if (claimResult?.reason === 'already-claimed') {
            logs.push('無法佔領');
          } else if (claimResult?.reason === 'not-claimable') {
            logs.push('無法佔領');
          } else {
            logs.push('佔領失敗，請稍後再試');
          }
          return;
        }

        ctx.worldMap[key] = {
          name: areaName,
          owner: ctx.c.name,
          level: initialLevel,
          initialLevel,
          description: existing.description || '',
          monsters: monstersWithoutGuardians,
          npcs: existing.npcs || []
        };
        if (existing.returnMark) ctx.worldMap[key].returnMark = existing.returnMark;
        if (Math.random() < 0.05) ctx.worldMap[key].returnMark = true;

        let guardianResult = null;
        if (areaName !== '未開拓之地' && areaName !== '廢墟') {
          const guardianLevel = rollMonsterLevel(initialLevel);
          const guardianHp = ctx.hpAtLevel(guardianLevel);
          const guardianAtk = ctx.attackAtLevel(guardianLevel);
          guardianResult = await db.spawnMob(
            claimResult.region?.id,
            {
              name: `${areaName}_守護神`,
              level: guardianLevel,
              isGuardian: true,
              hpMax: guardianHp,
              atk: guardianAtk
            },
            ctx.dbClient
          );
          if (guardianResult?.ok && guardianResult.mob) {
            ctx.worldMap[key].monsters.push({
              name: guardianResult.mob.name,
              guardian: true,
              level: guardianResult.mob.level,
              attack: guardianAtk,
              hp: guardianHp,
              maxHp: guardianHp,
              exp: ctx.expGainForLevel(guardianResult.mob.level)
            });
          }
        }

        logs.push(ctx.formatLocationInfo(ctx.getLocationInfo(ctx.c.position)));

        ctx.queueEvent?.({
          playerId: ctx.c.accountId,
          kind: 'region_claimed',
          payload: {
            region: {
              id: claimResult.region?.id || null,
              name: claimResult.region?.name || areaName,
              level: claimResult.region?.level ?? initialLevel,
              ownerAccountId: claimResult.region?.ownerAccountId || ctx.c.accountId,
              ownerName: ctx.c.name,
              coordinates: {
                x: ctx.c.position.x,
                y: ctx.c.position.y,
                z: ctx.c.position.z
              }
            }
          }
        });

        if (guardianResult?.ok && guardianResult.mob) {
          ctx.queueEvent?.({
            playerId: ctx.c.accountId,
            kind: 'mob_spawned',
            payload: {
              regionId: claimResult.region?.id || null,
              mob: {
                id: guardianResult.mob.id || null,
                name: guardianResult.mob.name,
                level: guardianResult.mob.level,
                isGuardian: true
              }
            }
          });
        }
      }
    },
    {
      prefix: '孵化/',
      handler: async (cmd, ctx, logs) => {
        const mName = cmd.split('/')[1];
        const currentAction = Math.round(ctx.c.action ?? 0);
        if (currentAction < 1) {
          logs.push('行動值不足');
          return;
        }
        ctx.c.action = Math.max(0, currentAction - 1);
        ctx.c.lastActionUpdate = Date.now();
        ctx.markPlayerDirty?.(ctx.c.accountId);
        const key = `${ctx.c.position.x},${ctx.c.position.y},${ctx.c.position.z}`;
        const loc = ctx.worldMap[key];
        const region = ctx.getRegionFromDb ? await ctx.getRegionFromDb(ctx.c.position) : null;
        const monsterTaken = await ctx.isMonsterNameTaken(mName);
        const playerTaken = ctx.listPlayersByName(mName).length > 0;
        if (
          !mName ||
          !loc ||
          loc.owner !== ctx.c.name ||
          !ctx.monsterNameRegex.test(mName) ||
          monsterTaken ||
          playerTaken ||
          !region ||
          (region.ownerAccountId && region.ownerAccountId !== ctx.c.accountId)
        ) {
          logs.push(monsterTaken || playerTaken ? '名稱已被使用' : '你要不要看看你現在在哪裡？');
          return;
        }

        const areaLevel = loc.level || loc.initialLevel || 1;
        const lvl = rollMonsterLevel(areaLevel);
        const attackValue = ctx.attackAtLevel(lvl);
        const hpValue = ctx.hpAtLevel(lvl);

        const spawnResult = await db.spawnMob(
          region.id,
          {
            name: mName,
            level: lvl,
            hpMax: hpValue,
            atk: attackValue
          },
          ctx.dbClient
        );

        if (!spawnResult?.ok) {
          if (spawnResult?.reason === 'mob-limit') {
            logs.push('孵化上限');
          } else {
            logs.push('孵化失敗，請稍後再試');
          }
          return;
        }

        loc.monsters = Array.isArray(loc.monsters) ? loc.monsters : [];
        const idx = findMonsterIndex(loc.monsters, spawnResult.mob.name || mName);
        const monsterEntry = {
          name: spawnResult.mob.name || mName,
          level: spawnResult.mob.level ?? lvl,
          attack: attackValue,
          hp: hpValue,
          maxHp: hpValue,
          exp: ctx.expGainForLevel(spawnResult.mob.level ?? lvl),
          guardian: !!spawnResult.mob.isGuardian
        };
        if (idx >= 0) {
          loc.monsters[idx] = { ...loc.monsters[idx], ...monsterEntry };
        } else {
          loc.monsters.push(monsterEntry);
        }

        logs.push(`在${loc.name}孵化出${monsterEntry.name}`);
        const attackFmt = ctx.fmt ? ctx.fmt(monsterEntry.attack) : Math.round(monsterEntry.attack ?? 0);
        const hpFmt = ctx.fmt
          ? ctx.fmt(monsterEntry.hp ?? monsterEntry.maxHp)
          : Math.round((monsterEntry.hp ?? monsterEntry.maxHp) ?? 0);
        const pos = ctx.c.position || { x: 0, y: 0, z: 0 };
        logs.push(`等級：${ctx.fmt ? ctx.fmt(monsterEntry.level) : Math.round(monsterEntry.level)}`);
        logs.push(`攻擊力：${attackFmt}`);
        logs.push(`血量：${hpFmt}`);
        logs.push(`位置：(${pos.x},${pos.y},${pos.z})`);

        ctx.queueEvent?.({
          playerId: ctx.c.accountId,
          kind: 'mob_spawned',
          payload: {
            regionId: region.id,
            mob: {
              id: spawnResult.mob.id || null,
              name: spawnResult.mob.name || mName,
              level: spawnResult.mob.level ?? lvl,
              isGuardian: !!spawnResult.mob.isGuardian
            }
          }
        });
      }
    }
  ]
};
