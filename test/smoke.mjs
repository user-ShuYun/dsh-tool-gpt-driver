/** 冒烟测试：只读，不发任何提示词 */
import { connect, snapshot } from '../src/cdp.js';

const s = await connect(9222);
try {
  const snap = await snapshot(s);
  console.log('snapshot', JSON.stringify(snap));
  console.log('title   ', await s.evaluate('document.title'));
  console.log('heading ', String(await s.evaluate('document.body.innerText.slice(0, 120)')).replace(/\s+/g, ' '));
} finally {
  s.close();
}
