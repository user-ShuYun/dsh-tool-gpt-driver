/**
 * cdp.js —— 用 Chrome DevTools Protocol 接管浏览器里的 ChatGPT。
 *
 * 前置：Edge/Chrome 以 `--remote-debugging-port=9222` 启动，且已登录 chatgpt.com。
 *
 * 这里只做四件事：读状态、发一条提示词、等它画完、把原图取回来。
 * 所有"等待"都以页面状态为准（停止按钮消失 + 图片张数增加），不看时间。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找 chatgpt.com 那个 page target */
export async function pickPage(port = 9222) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && /chatgpt\.com|chat\.openai/.test(t.url));
  if (!page) throw new Error('no chatgpt page on port ' + port + '（先用 --remote-debugging-port 启动并打开 chatgpt.com）');
  return page;
}

/** 连上页面，返回一个带 eval/close 的会话 */
export async function connect(port = 9222) {
  const page = await pickPage(port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('cdp websocket failed'));
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  };

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await call('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
    return r.result?.value;
  };

  return { ws, call, evaluate, close: () => ws.close() };
}

/** 页面上的输入框（有多个隐藏镜像节点，必须挑看得见的那个） */
const PICK_COMPOSER = `(() => {
  const list = [...document.querySelectorAll('#prompt-textarea, div.ProseMirror[contenteditable="true"], [contenteditable="true"], textarea')];
  const vis = list.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 80 && r.height > 8; });
  return vis.length ? vis[vis.length - 1] : (list[list.length - 1] || null);
})()`;

/** 当前页面快照：是否在生成、大图几张、模型/输入框状态 */
export async function snapshot(s) {
  return s.evaluate(`(() => {
    const imgs = [...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 1000);
    const stop = document.querySelector('button[aria-label*="停止"], button[data-testid="stop-button"], button[aria-label*="Stop"]');
    const ta = ${PICK_COMPOSER};
    return {
      url: location.href,
      images: imgs.length,
      busy: !!stop,
      composer: !!ta,
      composerLength: ta ? (ta.innerText || '').trim().length : -1
    };
  })()`);
}

/** 把一段文字写进输入框（ProseMirror 用 Input.insertText 最可靠，失败退回 paste 事件） */
export async function fill(s, text) {
  await s.evaluate(`(() => { const el = ${PICK_COMPOSER}; if (el) { el.focus(); } return !!el; })()`);
  await s.evaluate(`(() => {
    const el = ${PICK_COMPOSER};
    if (!el) return 'no-composer';
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    return 'cleared';
  })()`);
  await s.call('Input.insertText', { text });
  await sleep(800);

  let len = await s.evaluate(`(() => { const el = ${PICK_COMPOSER}; return el ? (el.innerText || '').length : -1; })()`);
  if (!len || len < 10) {
    await s.evaluate(`(() => {
      const el = ${PICK_COMPOSER};
      if (!el) return 'no-el';
      el.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(text)});
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return 'pasted';
    })()`);
    await sleep(900);
    len = await s.evaluate(`(() => { const el = ${PICK_COMPOSER}; return el ? (el.innerText || '').length : -1; })()`);
  }
  if (!len || len < 10) throw new Error('composer did not accept text (len=' + len + ')');
  return len;
}

/** 点发送（没有发送按钮时退回回车） */
export async function submit(s) {
  const r = await s.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '');
      return /send|发送/i.test(label) && !b.disabled;
    });
    if (btn) { btn.click(); return 'clicked'; }
    return 'no-button';
  })()`);
  if (r === 'no-button') {
    for (const type of ['keyDown', 'keyUp']) {
      await s.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
  }
  await sleep(1200);
  return r;
}

/**
 * 发一条提示词。**单条**：调用前必须确认页面空闲（busy=false）。
 * @returns {Promise<{url: string, imagesBefore: number}>}
 */
export async function sendPrompt(s, text) {
  const before = await snapshot(s);
  if (before.busy) throw new Error('page is still generating; wait for it to finish before sending another prompt');
  await fill(s, text);
  await submit(s);
  const after = await snapshot(s);
  return { url: after.url, imagesBefore: before.images, imagesAfterSend: after.images };
}

/**
 * 等"这一条"画完：停止按钮消失 **且** 图片张数 > 基线。
 * @param {number} baseline 发送前的张数
 */
export async function waitForImage(s, { baseline, timeoutSec = 300, pollMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  const started = Date.now();
  while (Date.now() < deadline) {
    const snap = await snapshot(s);
    if (snap.images > baseline && !snap.busy) {
      return { images: snap.images, seconds: Math.round((Date.now() - started) / 1000) };
    }
    await sleep(pollMs);
  }
  throw new Error(`timeout after ${timeoutSec}s waiting for a new image (baseline ${baseline})`);
}

/** 把页面上最新一张大图按原始像素取回（走 fetch(blob) → base64，不经过 canvas，避免空白） */
export async function exportLatestImage(s, { minWidth = 1000 } = {}) {
  const dataUrl = await s.evaluate(`(async () => {
    const imgs = [...document.querySelectorAll('img')].filter((i) => i.naturalWidth >= ${minWidth});
    if (!imgs.length) return 'NO_IMAGE';
    const img = imgs[imgs.length - 1];
    try {
      const r = await fetch(img.src);
      const b = await r.blob();
      return await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => res('READ_ERR');
        fr.readAsDataURL(b);
      });
    } catch (e) { return 'FETCH_ERR:' + e.message; }
  })()`);
  if (!dataUrl || dataUrl === 'NO_IMAGE' || String(dataUrl).startsWith('FETCH_ERR') || dataUrl === 'READ_ERR') {
    throw new Error('export failed: ' + String(dataUrl).slice(0, 80));
  }
  const base64 = String(dataUrl).split(',')[1];
  return {
    buffer: Buffer.from(base64, 'base64'),
    mime: String(dataUrl).slice(5, String(dataUrl).indexOf(';'))
  };
}

/**
 * 读最后一条 assistant 回复的正文。
 *
 * ChatGPT 的 DOM 一直在改（2026-10 的版本已经不再输出
 * `[data-message-author-role="assistant"]` 了），所以这里做两级：
 *   1. 有标准节点就用节点；
 *   2. 没有就退回"页面文字里最后一个 `ChatGPT 说：` 之后的一段"，并裁掉页脚提示。
 */
const LAST_ANSWER_JS = `(() => {
  const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  if (nodes.length) return nodes[nodes.length - 1].innerText || '';
  const body = (document.querySelector('main') || document.body).innerText || '';
  const marker = body.includes('ChatGPT 说：') ? 'ChatGPT 说：' : (body.includes('ChatGPT said') ? 'ChatGPT said' : '');
  if (!marker) return '';
  // 取**最后**一个标记之后的正文：否则会把上一轮的回答和这一轮的提问一起带进来
  const parts = body.split(marker);
  return parts[parts.length - 1]
    .replace(/ChatGPT 可能会出错[\\s\\S]*$/, '')
    .replace(/最新一条回复[\\s\\S]*$/, '')
    .trim();
})()`;

/** 等最后一条 assistant 消息稳定，返回正文 */
export async function waitForAnswer(s, { timeoutSec = 240, pollMs = 4000, minChars = 6 } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = '';
  let stable = 0;
  while (Date.now() < deadline) {
    const txt = await s.evaluate(LAST_ANSWER_JS);
    if (txt && txt === last) {
      stable++;
      if (stable >= 2 && txt.length > minChars) return txt;
    } else {
      stable = 0;
      last = txt || '';
    }
    await sleep(pollMs);
  }
  if (last) return last;
  throw new Error(`timeout after ${timeoutSec}s waiting for an answer`);
}
