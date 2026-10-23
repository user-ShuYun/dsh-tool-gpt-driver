/**
 * dsh-tool-gpt-driver —— 把"接管浏览器里的 ChatGPT"做成 DSH 插件。
 *
 * 提供 5 个工具：
 *   gpt_status        看页面状态（在不在生成、有几张图、输入框状态）
 *   gpt_send          发一条提示词（页面在生成时拒绝，避免串图）
 *   gpt_wait_image    等这一条画完并把原图取回来（停止按钮消失 + 张数增加 + 哈希）
 *   gpt_ask           问一条，等回答稳定后返回文字
 *   gpt_export_latest 立刻取回最新一张图
 *
 * 设计约束（踩过的坑，写进代码里）：
 *   1. **单条**：模块级 single-flight 锁 + 页面 busy 检查，两条并发直接报错；
 *   2. **基线**：gpt_send 记录发送前的图片张数，gpt_wait_image 只认"比基线多"的图；
 *   3. **哈希**：取回来的图算 sha256 并和调用方给的 knownHashes 比对，重复就判失败。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { connect, snapshot, sendPrompt, waitForImage, exportLatestImage, waitForAnswer } from './cdp.js';

export const name = 'tool-gpt-driver';
export const inject = ['tools'];

const DEFAULTS = { port: 9222, minWidth: 1000, pollMs: 3000 };

/** 单条通道：谁在发、发给谁、基线是多少 */
const channel = { busy: false, baseline: null };

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function savePng(path, buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  return buffer.length;
}

async function withPage(port, fn) {
  const s = await connect(port);
  try {
    return await fn(s);
  } finally {
    s.close();
  }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };

  ctx.tools.register({
    name: 'gpt_status',
    description:
      '查看浏览器里 ChatGPT 的状态：页面是否在生成（busy）、已有几张生成图、输入框是否可用。'
      + '发提示词之前先用它确认页面空闲。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          url: { type: 'string', required: true },
          busy: { type: 'boolean', required: true },
          images: { type: 'integer', required: true },
          composer: { type: 'boolean', required: true },
          channelBusy: { type: 'boolean', required: true }
        }
      }
    },
    async execute() {
      const snap = await withPage(cfg.port, snapshot);
      return { ...snap, channelBusy: channel.busy };
    }
  });

  ctx.tools.register({
    name: 'gpt_send',
    description:
      '把一条提示词发给浏览器里的 ChatGPT 并发送。**一次只发一条**：页面还在生成时会拒绝，'
      + '不会排队、不会覆盖；成功后返回发送前的图片张数作为后续 gpt_wait_image 的基线。',
    parameters: {
      text: { type: 'string', required: true, description: '完整提示词正文' },
      fromFile: { type: 'string', description: '可选：从该文件读取提示词（给了就忽略 text）' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          baseline: { type: 'integer', required: true }
        }
      }
    },
    async execute(args) {
      if (channel.busy) throw new Error('gpt_send: 上一条还没结束（单通道），先 gpt_wait_image 或等一下');
      const text = args.fromFile
        ? (existsSync(args.fromFile) ? readFileSync(args.fromFile, 'utf8') : (() => { throw new Error('fromFile not found: ' + args.fromFile); })())
        : args.text;
      if (!text || text.trim().length < 4) throw new Error('gpt_send: text 太短');

      channel.busy = true;
      try {
        const r = await withPage(cfg.port, (s) => sendPrompt(s, text));
        channel.baseline = r.imagesBefore;
        return { sent: true, url: r.url, baseline: r.imagesBefore };
      } catch (e) {
        channel.busy = false;
        throw e;
      }
    }
  });

  ctx.tools.register({
    name: 'gpt_wait_image',
    description:
      '等上一条 gpt_send 画完并把原始像素的图存到 outPath。判定条件是"停止按钮消失 **且** 图片张数超过基线"，'
      + '不看时间。返回文件路径、字节数、sha256；给了 knownHashes 且命中就判定为重复并报错。',
    parameters: {
      outPath: { type: 'string', required: true, description: 'PNG 保存路径' },
      timeoutSec: { type: 'integer', description: '超时秒数，默认 300' },
      knownHashes: {
        type: 'array',
        description: '可选：已知素材的 sha256 列表，命中即判重复（防止同一张图被当成新图）',
        items: { type: 'string' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          sha256: { type: 'string', required: true },
          seconds: { type: 'integer', required: true },
          duplicate: { type: 'boolean', required: true }
        }
      }
    },
    async execute(args) {
      const baseline = channel.baseline ?? 0;
      try {
        const waited = await withPage(cfg.port, async (s) => {
          await waitForImage(s, { baseline, timeoutSec: args.timeoutSec ?? 300, pollMs: cfg.pollMs });
          return exportLatestImage(s, { minWidth: cfg.minWidth });
        });
        const hash = sha(waited.buffer);
        const bytes = savePng(args.outPath, waited.buffer);
        const duplicate = Array.isArray(args.knownHashes) && args.knownHashes.includes(hash);
        if (duplicate) throw new Error(`duplicate image (sha256 ${hash.slice(0, 12)} already known): ${args.outPath}`);
        return { path: args.outPath, bytes, sha256: hash, seconds: waited.seconds ?? 0, duplicate: false };
      } finally {
        channel.busy = false;
        channel.baseline = null;
      }
    }
  });

  ctx.tools.register({
    name: 'gpt_ask',
    description: '发一条文字问题给 ChatGPT，等回答稳定后返回正文（不涉及图片）。',
    parameters: {
      text: { type: 'string', required: true, description: '问题正文' },
      timeoutSec: { type: 'integer', description: '超时秒数，默认 240' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true },
          chars: { type: 'integer', required: true }
        }
      }
    },
    async execute(args) {
      if (channel.busy) throw new Error('gpt_ask: 有一条请求在途，等它结束');
      channel.busy = true;
      try {
        const answer = await withPage(cfg.port, async (s) => {
          await sendPrompt(s, args.text);
          return waitForAnswer(s, { timeoutSec: args.timeoutSec ?? 240, pollMs: 4000 });
        });
        return { answer, chars: answer.length };
      } finally {
        channel.busy = false;
        channel.baseline = null;
      }
    }
  });

  ctx.tools.register({
    name: 'gpt_export_latest',
    description: '立刻把页面上最新一张生成图按原始像素取回并存盘（不等待，用于补取）。',
    parameters: { outPath: { type: 'string', required: true, description: 'PNG 保存路径' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          sha256: { type: 'string', required: true }
        }
      }
    },
    async execute(args) {
      const img = await withPage(cfg.port, (s) => exportLatestImage(s, { minWidth: cfg.minWidth }));
      const hash = sha(img.buffer);
      const bytes = savePng(args.outPath, img.buffer);
      return { path: args.outPath, bytes, sha256: hash };
    }
  });
}
