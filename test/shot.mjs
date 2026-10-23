/** 截图 + 看可见文字 */
import { writeFileSync } from 'node:fs';
import { connect } from '../src/cdp.js';

const s = await connect(9222);
try {
  const shot = await s.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync('D:/deepseek/art/plugin-page.png', Buffer.from(shot.data, 'base64'));
  const text = await s.evaluate(`(() => (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400))()`);
  console.log('TEXT:', text);
  console.log('URL :', await s.evaluate('location.href'));
} finally {
  s.close();
}
