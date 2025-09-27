module.exports = {
  handlers: {
    help: (ctx, logs) => {
      logs.push(
        '指令列表：\n看看 - 查看玩家資訊\n看看/名稱 - 查詢其他單位\n佔領/地名 - 命名並佔領地區\n孵化/怪物名稱 - 在己方地區創建怪物\n歐歐睏 - 在有回歸標記的地區綁定復活點\n查看家當 - 顯示背包\n查看家當/道具名稱 - 查詢道具資訊\n歐拉 - 隨機攻擊當前單位\n歐拉/怪物名稱 - 指定攻擊怪物\nhelp - 顯示所有指令\n看路 - 檢視當前位置資訊\n前進 - y座標+1\n後退 - y座標-1\n左轉 - x座標-1\n右轉 - x座標+1\n打老鷹 - z座標+1\n挖地瓜 - z座標-1'
      );
    },
    '看看': (ctx, logs) => logs.push(ctx.formatCharacterInfo(ctx.c)),
    '看路': (ctx, logs) => logs.push(ctx.formatLocationInfo(ctx.getLocationInfo(ctx.c.position)))
  },
  prefixHandlers: [
    {
      prefix: '看看/',
      handler: (cmd, ctx, logs) => {
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
            logs.push('沒有欸你要不要再確認看看');
          } else {
            logs.push(`有多個同名對象，請使用「看看 玩家:${query}」或「看看 怪物:${query}」指定。`);
          }
        }
      }
    }
  ]
};
