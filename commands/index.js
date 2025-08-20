const movement = require('./movement');
const info = require('./info');
const area = require('./area');
const inventory = require('./inventory');
const combat = require('./combat');

const modules = [movement, info, area, inventory, combat];

const handlers = {};
const prefixHandlers = [];
for (const m of modules) {
  if (m.handlers) Object.assign(handlers, m.handlers);
  if (m.prefixHandlers) prefixHandlers.push(...m.prefixHandlers);
}

module.exports = function dispatch(cmd, ctx, logs) {
  for (const { prefix, handler } of prefixHandlers) {
    if (cmd.startsWith(prefix)) return handler(cmd, ctx, logs);
  }
  const fn = handlers[cmd];
  if (fn) return fn(ctx, logs);
  logs.push(cmd);
};
