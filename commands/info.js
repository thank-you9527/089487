const { canonicalize } = require('../lib/names');
const { mergeDbMonstersIntoLocation, applyRespawnedMobs } = require('../lib/regions');

function parseCoordinateQuery(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^\(?(?<x>-?\d+)\s*,\s*(?<y>-?\d+)\s*,\s*(?<z>-?\d+)\)?$/);
  if (!match) return null;
  const x = Number(match.groups.x);
  const y = Number(match.groups.y);
  const z = Number(match.groups.z);
  if ([x, y, z].some(value => !Number.isFinite(value))) return null;
  return { x, y, z };
}

async function buildLocationInfo(ctx, position) {
  if (!position) return ctx.getLocationInfo(position);
  const fallbackInfo = ctx.getLocationInfo(position);
  const loadRegion = typeof ctx.getRegionFromDb === 'function' ? ctx.getRegionFromDb : null;
  if (!loadRegion) return fallbackInfo;

  try {
    const region = await loadRegion(position);
    if (!region) return fallbackInfo;

    if (region.id && typeof ctx.maybeRespawnMobs === 'function') {
      try {
        const respawn = await ctx.maybeRespawnMobs(region.id);
        if (respawn?.mobs?.length) {
          const key = `${position.x},${position.y},${position.z}`;
          const mapEntry = ctx.worldMap?.[key];
          const updates = mapEntry ? applyRespawnedMobs(mapEntry, respawn.mobs, ctx) : [];
          if (updates.length && typeof ctx.queueEvent === 'function' && ctx.c?.accountId) {
            for (const mob of updates) {
              ctx.queueEvent({
                playerId: ctx.c.accountId,
                kind: 'mob_respawned',
                payload: {
                  regionId: region.id,
                  mob: {
                    id: mob.id || null,
                    name: mob.name,
                    level: mob.level,
                    isGuardian: !!mob.guardian
                  }
                }
              });
            }
          }
        }
      } catch (err) {
        console.error('failed to refresh mobs before showing region', err);
      }
    }

    let mobs = [];
    if (typeof ctx.listRegionMobsFromDb === 'function') {
      mobs = await ctx.listRegionMobsFromDb(region.id);
      if (mobs?.length) {
        const key = `${position.x},${position.y},${position.z}`;
        const mapEntry = ctx.worldMap?.[key];
        if (mapEntry) {
          mergeDbMonstersIntoLocation(mapEntry, mobs, ctx);
        }
      }
    }

    const key = `${position.x},${position.y},${position.z}`;
    const mapEntry = ctx.worldMap?.[key];
    const npcs = Array.isArray(mapEntry?.npcs) ? mapEntry.npcs.length : 0;
    const playersHere = typeof ctx.countPlayersAt === 'function' ? ctx.countPlayersAt(position) : null;
    const population =
      typeof playersHere === 'number' ? playersHere + npcs + mobs.length : fallbackInfo.population;

    return {
      ...fallbackInfo,
      name: region.name || fallbackInfo.name,
      level: region.level != null ? region.level : fallbackInfo.level,
      owner: region.ownerDisplay || region.ownerName || fallbackInfo.owner || '無所屬',
      population
    };
  } catch (err) {
    console.error('failed to load region info', err);
    return fallbackInfo;
  }
}

function findRegionKeyByName(worldMap, name) {
  if (!worldMap || typeof worldMap !== 'object') return null;
  const target = canonicalize(name);
  if (!target) return null;
  const matches = [];
  for (const key of Object.keys(worldMap)) {
    const loc = worldMap[key];
    if (!loc || typeof loc.name !== 'string') continue;
    if (canonicalize(loc.name) === target) {
      matches.push(key);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return matches;
  return null;
}

async function showRegionByQuery(query, ctx, logs) {
  const coord = parseCoordinateQuery(query);
  let position = coord;

  if (!position) {
    const key = findRegionKeyByName(ctx.worldMap, query);
    if (Array.isArray(key)) {
      logs.push('有多個地區使用這個名稱，請改用座標搜尋。');
      return true;
    }
    if (typeof key === 'string') {
      const [x, y, z] = key.split(',').map(Number);
      if ([x, y, z].every(value => Number.isFinite(value))) {
        position = { x, y, z };
      }
    }
    if (!position && typeof ctx.findRegionCoordsByName === 'function') {
      try {
        const matches = await ctx.findRegionCoordsByName(query);
        if (Array.isArray(matches) && matches.length > 0) {
          if (matches.length === 1) {
            position = matches[0].position;
          } else {
            logs.push('有多個地區使用這個名稱，請改用座標搜尋。');
            return true;
          }
        }
      } catch (err) {
        console.error('failed to look up region by name', err);
      }
    }
  }

  if (!position) return false;

  const info = await buildLocationInfo(ctx, position);
  logs.push(ctx.formatLocationInfo(info));
  return true;
}

module.exports = {
  handlers: {
    help: (ctx, logs) => {
      logs.push(
        [
          '指令列表：',
          'help：顯示指令列表',
          '看看：顯示目前角色資訊',
          '看看/名稱：查詢其他玩家或怪物資訊',
          '看路：顯示目前所在地區資訊',
          '前進：往目前面向方向前進一格',
          '後退：往相反方向退一格',
          '左轉：向左移動一格',
          '右轉：向右移動一格',
          '打老鷹：向上移動一格',
          '挖地瓜：向下移動一格',
          '佔領/地名：命名並佔領目前地區',
          '孵化/名稱：在目前地區孵化守護神候補或怪物',
          '歐歐睏：在有回歸標記的地區綁定復活點',
          '歐拉：對當前目標發動攻擊或友善互動',
          '歐拉/名稱：指定攻擊目前所在地區的玩家或怪物',
          '捏捏/道具名：製作或刷新道具',
          '蛋雕/道具名：刪除背包內的道具',
          '讓我看看/前綴+道具名：查看指定道具的詳細資訊',
          '查看家當：列出自己的背包內容'
        ].join('\n')
      );
    },
    '看看': (ctx, logs) => logs.push(ctx.formatCharacterInfo(ctx.c)),
    '看路': async (ctx, logs) => {
      const pos = ctx.c.position || { x: 0, y: 0, z: 0 };
      const info = await buildLocationInfo(ctx, pos);
      logs.push(ctx.formatLocationInfo(info));
    }
  },
  prefixHandlers: [
    {
      prefix: '看看/',
      handler: async (cmd, ctx, logs) => {
        const targetName = cmd.split('/')[1];
        if (!targetName) {
          logs.push('沒有欸你要不要再確認看看');
        } else {
          const raw = targetName.trim();
          const prefixMatch = raw.match(/^(玩家|怪物)[:：](.+)$/);
          const query = prefixMatch ? prefixMatch[2].trim() : raw;
          if (!query) {
            logs.push('沒有欸你要不要再確認看看');
            return;
          }

          const currentKey =
            ctx.currentLocationKey ||
            `${ctx.c.position.x},${ctx.c.position.y},${ctx.c.position.z}`;
          const playerMatches = ctx.listPlayersByName(query);
          const monsterMatches = ctx.listMonstersByName(query);

          const showPlayer = player => logs.push(ctx.formatCharacterInfo(player));
          const showMonster = ({ monster, location }) => {
            const pos = location.split(',').map(Number);
            logs.push(
              `名稱：${monster.name}\n等級：${ctx.fmt(monster.level)}\n攻擊力：${ctx.fmt(monster.attack)}\n血量：${ctx.fmt(monster.hp)}\n位置：(${pos[0]},${pos[1]},${pos[2]})`
            );
          };

          if (prefixMatch) {
            if (prefixMatch[1] === '玩家') {
              if (playerMatches.length === 1) {
                showPlayer(playerMatches[0]);
              } else if (playerMatches.length > 1) {
                const sameTile = playerMatches.filter(
                  p =>
                    p.position?.x === ctx.c.position.x &&
                    p.position?.y === ctx.c.position.y &&
                    p.position?.z === ctx.c.position.z
                );
                if (sameTile.length === 1) {
                  showPlayer(sameTile[0]);
                } else {
                  logs.push('還是有多位玩家同名，請再確認。');
                }
              } else {
                logs.push('沒有欸你要不要再確認看看');
              }
            } else if (prefixMatch[1] === '怪物') {
              if (monsterMatches.length === 1) {
                showMonster(monsterMatches[0]);
              } else if (monsterMatches.length > 1) {
                const sameTile = monsterMatches.filter(match => match.location === currentKey);
                if (sameTile.length === 1) {
                  showMonster(sameTile[0]);
                } else {
                  logs.push('這個名稱的怪物有好幾隻，請到現場確認。');
                }
              } else {
                logs.push('沒有欸你要不要再確認看看');
              }
            }
            return;
          }

          const sameTilePlayer = playerMatches.filter(
            p =>
              p.position?.x === ctx.c.position.x &&
              p.position?.y === ctx.c.position.y &&
              p.position?.z === ctx.c.position.z
          );
          if (sameTilePlayer.length === 1) {
            showPlayer(sameTilePlayer[0]);
            return;
          }

          const sameTileMonster = monsterMatches.filter(match => match.location === currentKey);
          if (sameTileMonster.length === 1 && playerMatches.length === 0) {
            showMonster(sameTileMonster[0]);
            return;
          }

          const totalMatches = playerMatches.length + monsterMatches.length;
          if (totalMatches === 1) {
            if (playerMatches.length === 1) showPlayer(playerMatches[0]);
            else showMonster(monsterMatches[0]);
          } else if (totalMatches === 0) {
            if (!(await showRegionByQuery(query, ctx, logs))) {
              logs.push('沒有欸你要不要再確認看看');
            }
          } else {
            logs.push(`有多個同名對象，請使用「看看 玩家:${query}」或「看看 怪物:${query}」指定。`);
          }
        }
      }
    }
  ]
};
