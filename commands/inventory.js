module.exports = {
  handlers: {
    '查看家當': (ctx, logs) => {
      const fmt = typeof ctx.fmt === 'function' ? ctx.fmt : v => v;
      const items = (ctx.c.inventory || []).filter(
        it =>
          it &&
          !(it.deleted_at != null && it.deleted_at !== false) &&
          !(it.deletedAt != null && it.deletedAt !== false)
      );
      if (items.length === 0) {
        logs.push(`${ctx.c.name}的所有家當！\n背包空空如也`);
      } else {
        const lines = [`${ctx.c.name}的所有家當！`];
        items.forEach((it, i) => {
          const prefix = typeof it.prefix === 'string' && it.prefix ? `${it.prefix} ` : '';
          const display = `${prefix}${it.name || '未命名'}`;
          lines.push(`${i + 1}.${display} Lv.${fmt(it.level || 0)}`);
        });
        logs.push(lines.join('\n'));
      }
    }
  },
  prefixHandlers: [
    {
      prefix: '查看家當/',
      handler: (cmd, ctx, logs) => {
        logs.push('請改用「讓我看看/前綴+名稱」查詳情。');
      }
    }
  ]
};
