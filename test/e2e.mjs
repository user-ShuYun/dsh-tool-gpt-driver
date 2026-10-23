/** 端到端：走插件自己的工具，不碰旧脚本。会真的发一条文字问题（不生成图片）。 */
const mod = await import(process.argv[2] || '../src/index.js');

const tools = new Map();
mod.apply({ tools: { register: (t) => tools.set(t.name, t) } }, { port: 9222 });

const status = await tools.get('gpt_status').execute({});
console.log('gpt_status →', JSON.stringify(status));

const t0 = Date.now();
const res = await tools.get('gpt_ask').execute({
  text: '用一句话（40 字以内）回答：二叠纪末大灭绝最可能的主因是什么？只输出这一句话。',
  timeoutSec: 120
});
console.log('gpt_ask →', JSON.stringify({ chars: res.chars, seconds: Math.round((Date.now() - t0) / 1000) }));
console.log('answer:', res.answer.replace(/\s+/g, ' ').slice(0, 200));

const after = await tools.get('gpt_status').execute({});
console.log('gpt_status after →', JSON.stringify(after));
