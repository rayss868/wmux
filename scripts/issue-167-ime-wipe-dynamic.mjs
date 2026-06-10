#!/usr/bin/env node
// Dynamic verification for issue #167 — AutoGLM voice/IME injection wipes the
// already-typed line.
//
// Hypothesis under test (two-part):
//   1. ENABLER — xterm.js's hidden textarea retains IME-composed text after it
//      has been sent to the PTY (it is only cleared on blur / paste). So after
//      typing "abc" through an IME, textarea.value === "abc" even though the
//      shell already has those bytes.
//   2. TRIGGER — an external injector (AutoGLM voice) treats that textarea as
//      a populated edit field and "replaces" its content. Depending on how it
//      replaces (backspace keystrokes / programmatic value swap + keyCode 229 /
//      TSF range-replace composition), xterm emits destructive bytes (\x7f)
//      or drops/mangles the inserted text.
//
// The suspect code is entirely in xterm.js's browser input layer
// (CompositionHelper + CoreBrowserTerminal textarea handlers), so we test the
// REAL @xterm/xterm 6.0 bundle in a real Chromium page and treat term.onData
// as ground truth — those bytes are exactly what wmux forwards to the PTY.
// A local line model applies the bytes like a shell echo line so "the typed
// line got wiped" is directly observable.
//
// IME synthesis: CDP Input.imeSetComposition / Input.insertText (Chromium's
// real IME pipeline). If the environment doesn't deliver composition events
// (some headless builds), falls back to synthesized DOM CompositionEvents,
// which exercise the same xterm handlers.
//
// Run: node scripts/issue-167-ime-wipe-dynamic.mjs

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const xtermJs = readFileSync(join(root, 'node_modules/@xterm/xterm/lib/xterm.js'), 'utf8');
const xtermCss = readFileSync(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8');

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>wmux-167</title>
<style>${xtermCss}</style>
<body><div id="t" style="width:800px;height:300px"></div>
<script>${xtermJs}<\/script>
<script>
  window.__bytes = [];   // raw onData chunks (what wmux would write to the PTY)
  window.__events = [];  // textarea event trace
  window.__line = '';    // shell-line model: printable appends, \\x7f erases

  const term = new Terminal({ cols: 80, rows: 10 });
  term.open(document.getElementById('t'));
  term.onData((d) => {
    window.__bytes.push(d);
    for (const ch of d) {
      if (ch === '\\x7f' || ch === '\\b') window.__line = window.__line.slice(0, -1);
      else if (ch >= ' ') window.__line += ch;
    }
  });
  term.focus();

  const ta = document.querySelector('.xterm-helper-textarea');
  for (const type of ['keydown','keyup','compositionstart','compositionupdate','compositionend','beforeinput','input']) {
    ta.addEventListener(type, (e) => {
      window.__events.push({
        type,
        data: e.data ?? null,
        inputType: e.inputType ?? null,
        key: e.key ?? null,
        keyCode: e.keyCode ?? null,
        isComposing: e.isComposing ?? null,
        value: ta.value,
      });
    }, true);
  }

  window.__ta = ta;
  window.__reset = () => { window.__bytes = []; window.__events = []; window.__line = ''; ta.value = ''; term.focus(); };
  // DOM-synthesis fallback: emulate an IME commit (compositionstart/update,
  // textarea mutation, compositionend) without Chromium's IME pipeline.
  window.__domCompose = (text) => {
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: text }));
    ta.value += text;
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: text }));
  };
<\/script>`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}
const show = (s) => JSON.stringify(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(PAGE);
});

let browser;
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => !!window.__ta);
  const cdp = await page.context().newCDPSession(page);

  const state = () =>
    page.evaluate(() => ({
      bytes: window.__bytes,
      line: window.__line,
      taValue: window.__ta.value,
      events: window.__events.map((e) => `${e.type}(${e.inputType ?? e.key ?? e.data ?? ''})${e.isComposing ? '*' : ''}`),
    }));
  const reset = () => page.evaluate(() => window.__reset());

  // Compose text via CDP IME pipeline; falls back to DOM synthesis when the
  // environment doesn't deliver composition events to the page.
  let useDomFallback = false;
  async function imeCommit(text) {
    if (useDomFallback) {
      await page.evaluate((t) => window.__domCompose(t), text);
    } else {
      for (let i = 1; i <= text.length; i++) {
        await cdp.send('Input.imeSetComposition', { text: text.slice(0, i), selectionStart: i, selectionEnd: i });
      }
      await cdp.send('Input.insertText', { text });
    }
    await sleep(80); // CompositionHelper finalizes in setTimeout(0)
  }

  // ── T0: plain (non-IME) typing leaves no residue ──────────────────────────
  console.log('T0: plain keystrokes (baseline)');
  for (const ch of 'abc') {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: 'Key' + ch.toUpperCase(), text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
  }
  await sleep(80);
  {
    const s = await state();
    check('T0 bytes are "abc"', s.bytes.join('') === 'abc', show(s.bytes.join('')));
    check('T0 textarea has NO residue', s.taValue === '', `value=${show(s.taValue)}`);
  }

  // ── T1: IME-composed typing leaves residue (ENABLER) ──────────────────────
  console.log('T1: IME composition "abc" (the enabler)');
  await reset();
  await imeCommit('abc');
  {
    const s = await state();
    const sawComposition = s.events.some((e) => e.startsWith('compositionstart'));
    if (!sawComposition) {
      useDomFallback = true;
      console.log('  (CDP IME events not delivered — switching to DOM-synthesis fallback)');
      await reset();
      await imeCommit('abc');
    }
  }
  {
    const s = await state();
    check('T1 bytes are "abc" (sent to PTY once)', s.bytes.join('') === 'abc', show(s.bytes.join('')));
    check('T1 textarea RETAINS "abc" after send', s.taValue === 'abc', `value=${show(s.taValue)} — residue enables external "replace field" behavior`);
    console.log(`  trace: ${s.events.join(' → ')}`);
  }

  // Helper: seed the canonical repro state — shell line "abc", textarea "abc" —
  // then clear the byte tape so each scenario asserts only the injection's bytes.
  async function seed() {
    await reset();
    await imeCommit('abc');
    await page.evaluate(() => { window.__bytes = []; });
  }

  // ── T2: injector clears the "field" with backspace keys, then inserts ─────
  console.log('T2: backspace-clear + voice insert (S1: SendInput VK_BACK style)');
  await seed();
  for (let i = 0; i < 3; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  }
  await sleep(50);
  await imeCommit('voice');
  {
    const s = await state();
    const dels = (s.bytes.join('').match(/\x7f/g) || []).length;
    check('T2 xterm forwarded 3 destructive DEL bytes', dels === 3, `DEL count=${dels}`);
    check('T2 WIPE REPRODUCED: typed "abc" erased from line', s.line === 'voice', `line=${show(s.line)} (expected "voice" if wiped, "abcvoice" if appended)`);
    console.log(`  bytes: ${show(s.bytes.join(''))}  textarea after: ${show(s.taValue)}`);
  }


  // ── T3: programmatic value replace + keyCode 229 (S2: DEL diff path) ──────
  console.log('T3: keydown 229 + programmatic shorter replace (S2: _handleAnyTextareaChanges)');
  await seed();
  await page.evaluate(() => {
    const ta = window.__ta;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229 }));
    ta.value = 'xy'; // injector swaps field content with shorter recognized text
  });
  await sleep(80);
  {
    const s = await state();
    const bytes = s.bytes.join('');
    check('T3 xterm emitted a lone destructive DEL', bytes === '\x7f', `bytes=${show(bytes)} — one char of the typed line erased`);
    check('T3 replacement text LOST (never sent) and line damaged', s.line === 'ab' && !bytes.includes('xy'), `line=${show(s.line)} (was "abc") — "xy" never reached the PTY`);
  }

  // ── T4: TSF range-replace composition (S3) ────────────────────────────────
  console.log('T4: composition with replacement range 0..3 (S3: TSF replace)');
  await seed();
  if (!useDomFallback) {
    await cdp.send('Input.imeSetComposition', { text: 'voice', selectionStart: 5, selectionEnd: 5, replacementStart: 0, replacementEnd: 3 });
    await cdp.send('Input.insertText', { text: 'voice' });
    await sleep(80);
    const s = await state();
    const bytes = s.bytes.join('');
    check('T4 commit MANGLED by stale composition position', bytes !== 'voice' && bytes.length < 'voice'.length, `bytes=${show(bytes)} — substring(start=3) of replaced value, not the full text`);
    console.log(`  line=${show(s.line)} textarea=${show(s.taValue)}`);
  } else {
    console.log('  (skipped — requires CDP IME pipeline)');
  }

  // ── T5: fix direction — idle-cleared textarea removes the hazard ──────────
  console.log('T5: same injection against an idle-cleared textarea (fix preview)');
  await seed();
  await page.evaluate(() => { window.__ta.value = ''; }); // what an idle-clear guard would do post-send
  await page.evaluate(() => { window.__bytes = []; window.__line = 'abc'; }); // keep shell line, clear tape
  await imeCommit('voice');
  {
    const s = await state();
    check('T5 voice text APPENDS cleanly (no wipe) once residue is gone', s.line === 'abcvoice' && !s.bytes.join('').includes('\x7f'), `line=${show(s.line)} bytes=${show(s.bytes.join(''))}`);
  }

  // ── T6: the wmux fix (imeResidueGuard) against the real IME pipeline ──────
  // Mirrors src/renderer/terminal/imeResidueGuard.ts (same event scheme:
  // compositionstart cancels, compositionend/keydown/onData re-arm a debounced
  // clear). Validates the race-safety design against real Chromium event
  // ordering: normal IME typing must be unaffected, back-to-back compositions
  // must not lose text to the timer, and the residue must be gone once idle.
  console.log('T6: imeResidueGuard scheme — normal IME typing intact, residue cleared when idle');
  await reset();
  await page.evaluate(() => {
    const ta = window.__ta;
    const DELAY = 150;
    let composing = false;
    let timer = null;
    const cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
    const schedule = () => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        if (composing) return;
        if (ta.selectionStart !== ta.selectionEnd) return;
        if (ta.value.length === 0) return;
        ta.value = '';
      }, DELAY);
    };
    ta.addEventListener('compositionstart', () => { composing = true; cancel(); });
    ta.addEventListener('compositionend', () => { composing = false; schedule(); });
    ta.addEventListener('keydown', () => { if (!composing) schedule(); });
  });
  await imeCommit('abc');
  await imeCommit('def'); // back-to-back: second composition starts within the debounce window
  {
    const s = await state();
    check('T6 back-to-back IME commits both reach the PTY', s.bytes.join('') === 'abcdef', `bytes=${show(s.bytes.join(''))}`);
  }
  await sleep(300); // let the guard go idle
  {
    const s = await state();
    check('T6 residue cleared once idle', s.taValue === '', `value=${show(s.taValue)}`);
  }
  await imeCommit('ghi'); // typing again after a clear must still work
  {
    const s = await state();
    check('T6 IME typing after a clear still works', s.bytes.join('') === 'abcdefghi', `bytes=${show(s.bytes.join(''))}`);
  }
  // Replay the T2 injector against the guarded terminal: a field-replacing
  // tool sends one Backspace per char it READS in the field. Idle guard has
  // emptied it, so it sends zero backspaces and just commits.
  await sleep(300);
  {
    const n = await page.evaluate(() => window.__ta.value.length);
    for (let i = 0; i < n; i++) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
    await imeCommit('voice');
    const s = await state();
    check('T6 injection with guard: appends cleanly, NO wipe', s.line === 'abcdefghivoice' && !s.bytes.join('').includes('\x7f'), `line=${show(s.line)}`);
  }

  console.log('');
  const fails = results.filter((r) => !r.ok);
  console.log(`${results.length - fails.length}/${results.length} checks passed${fails.length ? ` — FAILURES: ${fails.map((f) => f.name).join('; ')}` : ''}`);
  process.exitCode = fails.length ? 1 : 0;
} finally {
  await browser?.close();
  server.close();
}
