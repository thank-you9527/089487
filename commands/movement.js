const move = async (ctx, dx, dy, dz, cost, verb, logs) => {
  const { c, pickupItems, getLocationInfo, formatLocationInfo } = ctx;
  const newPos = { x: c.position.x + dx, y: c.position.y + dy, z: c.position.z + dz };
  if (newPos.x < -90 || newPos.x > 90 || newPos.y < -180 || newPos.y > 180 || newPos.z < -100 || newPos.z > 100) {
    logs.push('無法移動，已達邊界');
    return;
  }
  c.position = newPos;
  await pickupItems(c);
  if (cost) {
    c.action = Math.max(0, c.action - cost);
    c.lastActionUpdate = Date.now();
  }
  const info = getLocationInfo(newPos);
  logs.push(`${c.name}${verb}移動，抵達了${info.name}`);
  logs.push('');
  logs.push(formatLocationInfo(info));
};

module.exports = {
  handlers: {
    '前進': (ctx, logs) => move(ctx, 0, 1, 0, 1, '往前', logs),
    '後退': (ctx, logs) => move(ctx, 0, -1, 0, 1, '往後', logs),
    '左轉': (ctx, logs) => move(ctx, -1, 0, 0, 1, '往左', logs),
    '左轉打方向燈': (ctx, logs) => move(ctx, -1, 0, 0, 0, '往左', logs),
    '右轉': (ctx, logs) => move(ctx, 1, 0, 0, 1, '往右', logs),
    '右轉打方向燈': (ctx, logs) => move(ctx, 1, 0, 0, 0, '往右', logs),
    '打老鷹': (ctx, logs) => move(ctx, 0, 0, 1, 1, '往上', logs),
    '挖地瓜': (ctx, logs) => move(ctx, 0, 0, -1, 1, '往下', logs)
  },
  prefixHandlers: []
};
