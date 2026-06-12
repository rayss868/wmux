// X3 dogfood cleanup — close the test workspace (it landed in the shared
// session.json) via the sidebar close + confirm flow.
import { chromium } from 'playwright-core';

const CDP = process.env.CDP;
const WS_NAME = 'Workspace 7';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findRenderer(ctx) {
  for (const p of ctx.pages()) {
    try { if (await p.evaluate(() => !!document.querySelector('.xterm, webview'))) return p; } catch {}
  }
  return null;
}

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const page = await findRenderer(ctx);
if (!page) { console.log('no renderer'); process.exit(2); }
await page.bringToFront().catch(() => {});

const clickedClose = await page.evaluate((name) => {
  const rows = Array.from(document.querySelectorAll('.group'));
  const row = rows.find((r) => (r.innerText || '').includes(name));
  if (!row) return 'row-not-found';
  const x = Array.from(row.querySelectorAll('button')).find((b) => b.textContent?.trim() === '✕');
  if (!x) return 'close-btn-not-found';
  x.click();
  return 'ok';
}, WS_NAME);
console.log('close click:', clickedClose);
await sleep(700);

const confirmed = await page.evaluate(() => {
  const popups = Array.from(document.querySelectorAll('div.fixed'));
  const popup = popups.find((p) => p.className.includes('w-[220px]'));
  if (!popup) return 'confirm-popup-not-found';
  const buttons = popup.querySelectorAll('button');
  const yes = buttons[buttons.length - 1];
  if (!yes) return 'confirm-btn-not-found';
  yes.click();
  return 'ok';
});
console.log('confirm click:', confirmed);
await sleep(1500);

const stillThere = await page.evaluate((name) =>
  Array.from(document.querySelectorAll('.group')).some((r) => (r.innerText || '').includes(name)), WS_NAME);
console.log(stillThere ? 'FAIL workspace still present' : 'PASS test workspace closed');
await browser.close();
process.exit(stillThere ? 1 : 0);
