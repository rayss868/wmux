// X3 dogfood part 2 — URL persistence across restart.
// Expects the relaunched app to restore the two browser surfaces of the test
// workspace on their LAST navigated URLs (session.json browserUrl, written by
// updateBrowserUrl on did-navigate), not their creation URLs.
import { chromium } from 'playwright-core';

const CDP = process.env.CDP;
const OUT = 'D:/wmux/out-dogfood';
const EXPECT = {
  'surface-5a5216a9-b1ab-4539-8ba5-ed31c6724445': 'http://localhost:18234/',
  'surface-307d6ad6-2672-4b96-afd2-ec785c93795c': 'http://localhost:18234/x3click',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findRenderer(ctx) {
  for (const p of ctx.pages()) {
    try { if (await p.evaluate(() => !!document.querySelector('.xterm, webview'))) return p; } catch {}
  }
  return null;
}

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
let page = null;
for (let i = 0; i < 30 && !page; i++) { page = await findRenderer(ctx); if (!page) await sleep(1000); }
if (!page) { console.log('no renderer'); process.exit(2); }
await page.bringToFront().catch(() => {});

// Webviews of a non-active workspace stay mounted (display:none) in single
// mode, so the src attribute is readable regardless of which ws is active.
let found = null;
for (let i = 0; i < 20; i++) {
  found = await page.evaluate((ids) => {
    const out = {};
    for (const wv of document.querySelectorAll('webview')) {
      const id = wv.getAttribute('data-surface-id');
      if (ids.includes(id)) out[id] = wv.getAttribute('src');
    }
    return out;
  }, Object.keys(EXPECT));
  if (Object.keys(found).length === Object.keys(EXPECT).length) break;
  await sleep(1000);
}

let pass = true;
for (const [id, want] of Object.entries(EXPECT)) {
  const got = found[id];
  const ok = typeof got === 'string' && got.replace(/\/$/, '') === want.replace(/\/$/, '');
  if (!ok) pass = false;
  console.log(`${ok ? 'PASS' : 'FAIL'} restore ${id.slice(0, 16)} src=${got} (want ${want})`);
}
await page.screenshot({ path: `${OUT}/x3-08-restored.png` }).catch(() => {});
console.log(pass ? 'PASS S6 URL persistence across restart' : 'FAIL S6 URL persistence across restart');
await browser.close();
process.exit(pass ? 0 : 1);
