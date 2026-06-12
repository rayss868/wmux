// Dynamic verification of the imeStormGuard auto-recovery against the REAL
// runtime: synthesize the keyCode-229 claim-storm signature on the live
// xterm helper textarea (defineProperty overrides keyCode/isComposing on
// trusted-shaped KeyboardEvents) and assert that the guard blurs/refocuses
// the textarea and surfaces the recovery toast.
import { chromium } from 'playwright-core';

const CDP = process.env.CDP;
const OUT = 'D:/wmux/out-dogfood';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findRenderer(ctx) {
  for (const p of ctx.pages()) {
    try { if (await p.evaluate(() => !!document.querySelector('.xterm'))) return p; } catch {}
  }
  return null;
}

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const page = await findRenderer(ctx);
if (!page) { console.log('no renderer'); process.exit(2); }
await page.bringToFront().catch(() => {});

// Fresh workspace + focus its terminal.
await page.keyboard.press('Control+n');
await sleep(2500);
const box = await page.evaluate(() => {
  const s = Array.from(document.querySelectorAll('.xterm-screen')).filter((el) => el.offsetParent !== null);
  const el = s[s.length - 1]; if (!el) return null; const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(box.x, box.y);
await sleep(1500);

const result = await page.evaluate(() => {
  const ta = document.activeElement;
  if (!ta || !ta.classList?.contains('xterm-helper-textarea')) {
    return { error: 'active element is not the xterm textarea: ' + ta?.className };
  }
  const events = [];
  ta.addEventListener('blur', () => events.push('blur'), true);
  ta.addEventListener('focus', () => events.push('focus'), true);

  const stormKey = (code, key) => {
    const e = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
    // KeyboardEvent init can't set the deprecated keyCode — define it the way
    // the IME storm actually presents (229 + isComposing false).
    Object.defineProperty(e, 'keyCode', { get: () => 229 });
    Object.defineProperty(e, 'isComposing', { get: () => false });
    ta.dispatchEvent(e);
  };

  const codes = ['KeyA', 'KeyS', 'KeyD', 'ArrowDown', 'ArrowUp', 'Space', 'KeyF', 'KeyG'];
  for (const c of codes) stormKey(c, 'Process');

  return { events, dispatched: codes.length };
});
await sleep(800);

const toast = await page.evaluate(() => {
  const t = document.body.innerText;
  return t.includes('자동으로 복구') || t.includes('recovered automatically');
});
const refocused = await page.evaluate(() => document.activeElement?.classList?.contains('xterm-helper-textarea') === true);

console.log('storm result:', JSON.stringify(result));
console.log(`blur/focus fired: ${result.events?.join(',')}`);
console.log(`${result.events?.includes('blur') && result.events?.includes('focus') ? 'PASS' : 'FAIL'} guard performed blur->focus resync`);
console.log(`${toast ? 'PASS' : 'FAIL'} recovery toast shown`);
console.log(`${refocused ? 'PASS' : 'FAIL'} textarea holds focus after recovery`);
await page.screenshot({ path: `${OUT}/ime-storm-recovery.png` }).catch(() => {});

await browser.close();
const pass = result.events?.includes('blur') && result.events?.includes('focus') && toast && refocused;
process.exit(pass ? 0 : 1);
