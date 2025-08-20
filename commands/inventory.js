module.exports = {
  handlers: {
    '查看家當': (ctx, logs) => {
      const items = ctx.c.inventory || [];
      if (items.length === 0) {
        logs.push(`${ctx.c.name}的所有家當！\n這裡什麼都沒有`);
      } else {
        const lines = [`${ctx.c.name}的所有家當！`];
        items.forEach((it, i) => lines.push(`${i + 1}.${it.name}`));
        logs.push(lines.join('\n'));
      }
    }
  },
  prefixHandlers: [
    {
      prefix: '查看家當/',
      handler: (cmd, ctx, logs) => {
        const name = cmd.split('/')[1];
        const items = ctx.c.inventory || [];
        const item = items.find(it => it.name === name);
        if (item) {
          logs.push(`${item.name}（等級${ctx.fmt(item.level)}）`);
        } else {
          logs.push('醒？');
        }
      }
    }
  ]
};
