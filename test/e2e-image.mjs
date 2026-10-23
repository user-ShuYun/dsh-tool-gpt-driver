/**
 * 端到端：图片链路。走插件自己的 gpt_send / gpt_wait_image，
 * 真的发一条出图提示词并等它画完取回来。
 *
 *   node test/e2e-image.mjs <promptFile> <outPath> [timeoutSec]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [promptFile, outPath, timeoutArg] = process.argv.slice(2);
if (!promptFile || !outPath) {
  console.error('用法: node test/e2e-image.mjs <promptFile> <outPath> [timeoutSec]');
  process.exit(1);
}

const mod = await import('../src/index.js');
const tools = new Map();
mod.apply({ tools: { register: (t) => tools.set(t.name, t) } }, { port: 9222 });

const status = await tools.get('gpt_status').execute({});
console.log('before  ', JSON.stringify({ busy: status.busy, images: status.images }));

const t0 = Date.now();
const sent = await tools.get('gpt_send').execute({ fromFile: resolve(promptFile) });
console.log('sent    ', JSON.stringify({ baseline: sent.baseline, url: sent.url }));

const res = await tools.get('gpt_wait_image').execute({
  outPath,
  timeoutSec: Number(timeoutArg || 300)
});
console.log('saved   ', JSON.stringify({ ...res, seconds: Math.round((Date.now() - t0) / 1000) }));
