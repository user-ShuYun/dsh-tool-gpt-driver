/** 诊断：页面上 assistant 回复用什么选择器、内容是什么 */
import { connect, snapshot } from '../src/cdp.js';

const s = await connect(9222);
try {
  console.log('snap', JSON.stringify(await snapshot(s)));
  const info = await s.evaluate(`(() => {
    const qs = ['[data-message-author-role]', '[data-message-author-role="assistant"]', 'article', '[data-testid*="conversation-turn"]', '.markdown', 'main'];
    const counts = {};
    for (const q of qs) counts[q] = document.querySelectorAll(q).length;
    const turns = [...document.querySelectorAll('[data-message-author-role]')].slice(-3).map((n) => ({
      role: n.getAttribute('data-message-author-role'),
      text: (n.innerText || '').replace(/\\s+/g, ' ').slice(0, 100)
    }));
    const articles = [...document.querySelectorAll('article')].slice(-2).map((n) => (n.innerText || '').replace(/\\s+/g, ' ').slice(0, 100));
    return { counts, turns, articles };
  })()`);
  console.log(JSON.stringify(info, null, 1));
} finally {
  s.close();
}
