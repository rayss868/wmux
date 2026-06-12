// X3 dogfood — S4 retest. After `cls; echo URL` the URL output lands on ROW 0
// (cls homes the cursor before echo prints); the first run clicked rows 1-2.
import { chromium } from 'playwright-core';

const CDP = process.env.CDP || 'http://127.0.0.1:18841';
const OUT = 'D:/wmux/out-dogfood';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findRenderer(ctx) {
  for (const p of ctx.pages()) {
    try { if (await p.evaluate(() => !!document.querySelector('.xterm'))) return p; } catch {}
  }
  return null;
}
async function focusVisibleTerm(page) {
  const box = await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('.xterm-screen')).filter((el) => el.offsetParent !== null);
    const el = s[s.length - 1]; if (!el) return null; const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (box) await page.mouse.click(box.x, box.y);
  await sleep(300);
}
async function typeLine(page, s) {
  await page.keyboard.type(s); await sleep(150); await page.keyboard.press('Enter'); await sleep(500);
}
async function visibleWebviews(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('webview'))
    .filter((wv) => wv.offsetParent !== null)
    .map((wv) => { let url = ''; try { url = wv.getURL(); } catch {} return { surfaceId: wv.getAttribute('data-surface-id'), url }; }));
}
async function clickRow0(page, modifier) {
  const geo = await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('.xterm-screen')).filter((el) => el.offsetParent !== null);
    const el = s[s.length - 1]; if (!el) return null;
    const r = el.getBoundingClientRect();
    const m = document.querySelector('.xterm-char-measure-element');
    const mr = m ? m.getBoundingClientRect() : null;
    return { x: r.x, y: r.y, cw: mr && mr.width > 0 ? mr.width : 9, ch: mr && mr.height > 0 ? mr.height : 18 };
  });
  if (!geo) return false;
  const x = geo.x + 12 * geo.cw; // inside "http://localhost:..."
  const y = geo.y + 0.5 * geo.ch; // ROW 0
  await page.mouse.move(x, y);
  await sleep(600);
  if (modifier) await page.keyboard.down('Control');
  await page.mouse.click(x, y);
  if (modifier) await page.keyboard.up('Control');
  await sleep(800);
  return true;
}
async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeoutMs) return null; await sleep(intervalMs); }
}

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const page = await findRenderer(ctx);
if (!page) { console.log('no renderer'); process.exit(2); }
await page.bringToFront().catch(() => {});

// S4a: plain click on a localhost URL navigates the existing browser pane.
await focusVisibleTerm(page);
await typeLine(page, 'cls; echo http://localhost:18234/x3click');
await clickRow0(page, false);
const nav = await waitFor(async () => {
  const wvs = await visibleWebviews(page);
  return wvs.some((w) => w.url.includes('/x3click')) ? wvs : null;
}, 6000);
console.log(`${nav ? 'PASS' : 'FAIL'} S4a plain click localhost -> pane — ${nav ? JSON.stringify(nav) : 'no nav'}`);
await page.screenshot({ path: `${OUT}/x3-07-linkclick-row0.png` }).catch(() => {});

// S4b: Ctrl+click inverts to external — the pane must NOT navigate.
await focusVisibleTerm(page);
await typeLine(page, 'cls; echo http://localhost:18235/x3external');
await clickRow0(page, true);
await sleep(2500);
const wvs = await visibleWebviews(page);
const stayed = wvs.length > 0 && !wvs.some((w) => w.url.includes('/x3external'));
console.log(`${stayed ? 'PASS' : 'FAIL'} S4b Ctrl+click localhost stays external — ${JSON.stringify(wvs)}`);

await browser.close();
process.exit(nav && stayed ? 0 : 1);
