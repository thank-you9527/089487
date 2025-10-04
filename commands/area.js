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
        ctx.c.action = Math.max(0, ctx.c.action - 1);
        ctx.c.lastActionUpdate = Date.now();
        const info = ctx.getLocationInfo(ctx.c.position);
        const normalizedAreaName = areaName ? areaName.toLowerCase() : '';
        const nameTaken = Object.values(ctx.worldMap).some(loc => {
          if (!loc) return false;
          if (!loc.name || loc.name === '廢墟') return false;
          return loc.name.toLowerCase() === normalizedAreaName;
        });
        if (
          !areaName ||
          !ctx.areaNameRegex.test(areaName) ||
          nameTaken ||
          info.owner !== '無所屬' ||
          (info.name !== '未開拓之地' && info.name !== '廢墟')
        ) {
          logs.push(nameTaken ? '名稱已被使用' : '無法佔領');
        } else {
          let chance = 1;
          const lvl = ctx.c.level;
          if (lvl >= 11 && lvl <= 50) chance = 0.9;
          else if (lvl <= 200) chance = 0.8;
          else if (lvl <= 450) chance = 0.7;
          else if (lvl >= 451) chance = 0.65;
          if (Math.random() < chance) {
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
            const monstersWithoutGuardians = existingMonsters.filter(
              m => !m.guardian
            );
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
            const loc = ctx.worldMap[key];
            if (areaName !== '未開拓之地' && areaName !== '廢墟') {
              const guardianLevel = rollMonsterLevel(initialLevel);
              loc.monsters.push({
                name: `${areaName}_守護神`,
                guardian: true,
                level: guardianLevel,
                attack: ctx.attackAtLevel(guardianLevel),
                hp: ctx.hpAtLevel(guardianLevel),
                maxHp: ctx.hpAtLevel(guardianLevel),
                exp: ctx.expGainForLevel(guardianLevel)
              });
            }
            await ctx.saveMap();
            logs.push(ctx.formatLocationInfo(ctx.getLocationInfo(ctx.c.position)));
          } else {
            logs.push('啪，沒了');
          }
        }
      }
    },
    {
      prefix: '孵化/',
      handler: async (cmd, ctx, logs) => {
        const mName = cmd.split('/')[1];
        ctx.c.action = Math.max(0, ctx.c.action - 1);
        ctx.c.lastActionUpdate = Date.now();
        const key = `${ctx.c.position.x},${ctx.c.position.y},${ctx.c.position.z}`;
        const loc = ctx.worldMap[key];
        const monsterTaken = await ctx.isMonsterNameTaken(mName);
        const playerTaken = ctx.listPlayersByName(mName).length > 0;
        if (
          !mName ||
          !loc ||
          loc.owner !== ctx.c.name ||
          !ctx.monsterNameRegex.test(mName) ||
          monsterTaken ||
          playerTaken
        ) {
          logs.push(monsterTaken || playerTaken ? '名稱已被使用' : '你要不要看看你現在在哪裡？');
        } else {
          const areaLevel = loc.level || loc.initialLevel || 1;
          const lvl = rollMonsterLevel(areaLevel);
          const monster = {
            name: mName,
            level: lvl,
            attack: ctx.attackAtLevel(lvl),
            hp: ctx.hpAtLevel(lvl),
            maxHp: ctx.hpAtLevel(lvl),
            exp: ctx.expGainForLevel(lvl)
          };
          loc.monsters = loc.monsters || [];
          if (loc.monsters.length >= 5) {
            logs.push('孵化上限');
            return;
          }
          loc.monsters.push(monster);
          await ctx.saveMap();
          logs.push(`在${loc.name}孵化出${mName}（等級${ctx.fmt(lvl)}）`);
        }
      }
    }
  ]
};
