// X3 embedded browser pane — live dogfood (part 1: in-session scenarios).
// Covers: port-badge click (create), second badge click (reuse+navigate),
// target=_blank same-view popup policy, terminal URL click smart routing
// (plain localhost → pane, Ctrl+click inverse), Ctrl+Shift+L forceNew.
// Part 2 (x3-dogfood-restore.mjs) verifies URL persistence across restart.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const CDP = process.env.CDP || 'http://127.0.0.1:18841';
const OUT = 'D:/wmux/out-dogfood';
const PY = 'C:\\Users\\rizz\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\python.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

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
  await page.keyboard.type(s); await sleep(150); await page.keyboard.press('Enter'); await sleep(400);
}
async function visibleWebviews(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('webview'))
      .filter((wv) => wv.offsetParent !== null)
      .map((wv) => {
        let url = '';
        try { url = wv.getURL(); } catch {}
        return { surfaceId: wv.getAttribute('data-surface-id'), url, src: wv.getAttribute('src') };
      });
  });
}
async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const page = await findRenderer(ctx);
if (!page) { console.log('no renderer page'); process.exit(2); }
await page.bringToFront().catch(() => {});

// ── 0. fresh workspace ───────────────────────────────────────────────────────
const wsCountBefore = await page.evaluate(() => document.querySelectorAll('span.font-mono.truncate').length);
await page.keyboard.press('Control+n');
await sleep(1500);
const wsCountAfter = await page.evaluate(() => document.querySelectorAll('span.font-mono.truncate').length);
report('S0 new workspace', wsCountAfter === wsCountBefore + 1, `${wsCountBefore} -> ${wsCountAfter}`);
await focusVisibleTerm(page);
await typeLine(page, 'cd \\');
await sleep(1200);

// ── 1. start server :18234, wait for port badge, click it ───────────────────
await typeLine(page, `$p1 = Start-Process -FilePath '${PY}' -ArgumentList '-m','http.server','18234' -PassThru -WindowStyle Hidden; Write-Host "X3PID1=$($p1.Id)"`);
const badge1 = await waitFor(async () =>
  page.evaluate(() => !!document.querySelector('button[title*="localhost:18234"]')), 25000);
report('S1a port badge :18234 appears', !!badge1);
await page.screenshot({ path: `${OUT}/x3-01-badge.png` }).catch(() => {});

let wvAfterClick = null;
if (badge1) {
  await page.click('button[title*="localhost:18234"]');
  wvAfterClick = await waitFor(async () => {
    const wvs = await visibleWebviews(page);
    return wvs.length === 1 && wvs[0].url.includes(':18234') ? wvs : null;
  }, 10000);
  report('S1b badge click opens browser pane on :18234', !!wvAfterClick, JSON.stringify(wvAfterClick));
  await page.screenshot({ path: `${OUT}/x3-02-port-click.png` }).catch(() => {});
}

// ── 2. second server :18235 — badge click must REUSE (navigate, no new pane) ─
await focusVisibleTerm(page);
await typeLine(page, `$p2 = Start-Process -FilePath '${PY}' -ArgumentList '-m','http.server','18235' -PassThru -WindowStyle Hidden; Write-Host "X3PID2=$($p2.Id)"`);
const badge2 = await waitFor(async () =>
  page.evaluate(() => !!document.querySelector('button[title*="localhost:18235"]')), 25000);
report('S2a port badge :18235 appears', !!badge2);
if (badge2) {
  await page.click('button[title*="localhost:18235"]');
  const reused = await waitFor(async () => {
    const wvs = await visibleWebviews(page);
    return wvs.length === 1 && wvs[0].url.includes(':18235') ? wvs : null;
  }, 10000);
  report('S2b badge click reuses pane + navigates to :18235', !!reused, JSON.stringify(reused));
  await page.screenshot({ path: `${OUT}/x3-03-reuse.png` }).catch(() => {});
}

// ── 3. target=_blank inside the guest → same-view navigation, no new window ─
const pagesBefore = ctx.pages().length;
let guest = null;
for (const p of ctx.pages()) {
  try { if (p.url().includes(':18235')) { guest = p; break; } } catch {}
}
if (!guest) {
  report('S3 target=_blank same-view', false, 'guest page for :18235 not found via CDP');
} else {
  await guest.evaluate(() => {
    const a = document.createElement('a');
    a.href = 'http://localhost:18234/';
    a.target = '_blank';
    a.textContent = 'x3-blank';
    document.body.appendChild(a);
    a.click();
  }).catch((e) => report('S3 evaluate error', false, String(e)));
  const navigated = await waitFor(async () => {
    const wvs = await visibleWebviews(page);
    return wvs.length >= 1 && wvs[0].url.includes(':18234') ? wvs : null;
  }, 8000);
  const pagesAfter = ctx.pages().length;
  report('S3 target=_blank same-view, no popup', !!navigated && pagesAfter <= pagesBefore,
    `url=${navigated ? navigated[0].url : 'unchanged'} pages ${pagesBefore}->${pagesAfter}`);
  await page.screenshot({ path: `${OUT}/x3-04-blank.png` }).catch(() => {});
}

// ── 4. terminal URL click — smart routing ────────────────────────────────────
async function cellSize(page) {
  const c = await page.evaluate(() => {
    const el = document.querySelector('.xterm-char-measure-element');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : null;
  });
  return c || { w: 9, h: 18 };
}
async function termRect(page) {
  return page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('.xterm-screen')).filter((el) => el.offsetParent !== null);
    const el = s[s.length - 1]; if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
}
async function clickUrlOnRows(page, colPx, rows, modifier) {
  const rect = await termRect(page);
  const cell = await cellSize(page);
  for (const row of rows) {
    const x = rect.x + colPx * cell.w;
    const y = rect.y + (row + 0.5) * cell.h;
    await page.mouse.move(x, y);
    await sleep(500); // let the link provider register the hover
    if (modifier) await page.keyboard.down('Control');
    await page.mouse.click(x, y);
    if (modifier) await page.keyboard.up('Control');
    await sleep(800);
  }
}

await focusVisibleTerm(page);
await typeLine(page, 'cls; echo http://localhost:18234/x3click');
await sleep(500);
await clickUrlOnRows(page, 10, [1, 2], false);
const linkNav = await waitFor(async () => {
  const wvs = await visibleWebviews(page);
  return wvs.length >= 1 && wvs[0].url.includes('/x3click') ? wvs : null;
}, 6000);
report('S4a plain click on localhost URL -> browser pane', !!linkNav, linkNav ? linkNav[0].url : 'no nav');
await page.screenshot({ path: `${OUT}/x3-05-linkclick.png` }).catch(() => {});

await focusVisibleTerm(page);
await typeLine(page, 'cls; echo http://localhost:18235/x3external');
await sleep(500);
await clickUrlOnRows(page, 10, [1, 2], true); // Ctrl+click inverts -> external
await sleep(2500);
const wvsAfterCtrl = await visibleWebviews(page);
const stayed = wvsAfterCtrl.length >= 1 && !wvsAfterCtrl[0].url.includes('/x3external');
report('S4b Ctrl+click localhost URL stays out of pane (external)', stayed,
  wvsAfterCtrl.length ? wvsAfterCtrl[0].url : 'no webview');

// ── 5. Ctrl+Shift+L forceNew — a second browser pane appears ────────────────
await focusVisibleTerm(page);
await page.keyboard.press('Control+Shift+L');
const second = await waitFor(async () => {
  const wvs = await visibleWebviews(page);
  return wvs.length === 2 ? wvs : null;
}, 8000);
report('S5 Ctrl+Shift+L creates a SECOND browser pane (forceNew)', !!second,
  second ? second.map((w) => w.url).join(' | ') : 'count != 2');
await page.screenshot({ path: `${OUT}/x3-06-forcenew.png` }).catch(() => {});

// Save expectations for the restart-persistence check (part 2).
const expectation = {
  webviews: await visibleWebviews(page),
  note: 'first surface should restore on its LAST navigated URL, second on default google',
};
writeFileSync(`${OUT}/x3-persist-expectation.json`, JSON.stringify(expectation, null, 2));
console.log('EXPECTATION=' + JSON.stringify(expectation));

const failed = results.filter((r) => !r.pass).length;
console.log(`SUMMARY: ${results.length - failed}/${results.length} pass`);
await browser.close();
process.exit(failed ? 1 : 0);
