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
          const targetChar = ctx.findCharacterByName(targetName);
          if (targetChar) {
            logs.push(ctx.formatCharacterInfo(targetChar));
          } else {
            const foundMonster = ctx.findMonsterByName(targetName);
            if (foundMonster) {
              const m = foundMonster.monster;
              const pos = foundMonster.location.split(',').map(Number);
              logs.push(`名稱：${m.name}\n等級：${ctx.fmt(m.level)}\n攻擊力：${ctx.fmt(m.attack)}\n血量：${ctx.fmt(m.hp)}\n位置：(${pos[0]},${pos[1]},${pos[2]})`);
            } else {
              logs.push('沒有欸你要不要再確認看看');
            }
          }
        }
      }
    }
  ]
};
