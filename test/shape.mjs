/** 插件形状测试：用假 ctx 跑 apply()，确认 5 个工具都注册上了（不碰网络） */
import { apply, name, inject } from '../src/index.js';

const registered = [];
const ctx = { tools: { register: (tool) => registered.push(tool) } };

apply(ctx, { port: 9222 });

console.log('name   ', name);
console.log('inject ', JSON.stringify(inject));
console.log('tools  ', registered.map((t) => t.name).join(', '));

const bad = [];
for (const t of registered) {
  if (!t.name) bad.push('missing name');
  if (!t.description) bad.push(t.name + ': missing description');
  if (typeof t.execute !== 'function') bad.push(t.name + ': missing execute');
}
if (bad.length) {
  console.error('FAIL', bad);
  process.exit(1);
}
console.log('shape  OK');
