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
        const nameTaken = Object.values(ctx.worldMap).some(
          loc => loc.name === areaName && loc.name !== '廢墟'
        );
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
            const maxLv = Math.max(1, Math.floor(ctx.c.level / 10));
            const newLevel = Math.floor(Math.random() * maxLv) + 1;
            const existing = ctx.worldMap[key] || {};
            ctx.worldMap[key] = {
              name: areaName,
              owner: ctx.c.name,
              level: newLevel,
              description: existing.description || '',
              monsters: existing.monsters || [],
              npcs: existing.npcs || []
            };
            if (Math.random() < 0.05) ctx.worldMap[key].returnMark = true;
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
        const nameTaken = Object.values(ctx.worldMap).some(
          l => Array.isArray(l.monsters) && l.monsters.some(m => m.name === mName)
        );
        if (!mName || !loc || loc.owner !== ctx.c.name || !ctx.monsterNameRegex.test(mName) || nameTaken) {
          logs.push(nameTaken ? '名稱已被使用' : '你要不要看看你現在在哪裡？');
        } else {
          const rl = loc.level || 1;
          const base = rl * 10;
          let delta;
          if (rl <= 10) delta = 5;
          else if (rl <= 50) delta = 10;
          else if (rl <= 150) delta = 150;
          else if (rl <= 300) delta = 430;
          else delta = 500;
          let min = base - delta;
          let max = base + delta;
          min = Math.max(1, min);
          max = Math.min(5000, max);
          const lvl = Math.floor(Math.random() * (max - min + 1)) + min;
          const monster = {
            name: mName,
            level: lvl,
            attack: ctx.attackAtLevel(lvl),
            hp: ctx.hpAtLevel(lvl),
            maxHp: ctx.hpAtLevel(lvl),
            exp: ctx.expGainForLevel(lvl)
          };
          loc.monsters = loc.monsters || [];
          loc.monsters.push(monster);
          await ctx.saveMap();
          logs.push(`在${loc.name}孵化出${mName}（等級${ctx.fmt(lvl)}）`);
        }
      }
    }
  ]
};
