// V2 — Electron 41 main 프로세스에서 동일 .node 로드 (U2 실증: ABI 안정 → 무재빌드).
// 창 불필요. app.whenReady → require → 검증 → process.exit(0/1).
const { app } = require('electron');
const path = require('node:path');

function run() {
  let fail = 0;
  const check = (name, cond, got) => {
    if (cond) {
      console.log(`  PASS ${name}`);
    } else {
      console.error(`  FAIL ${name} — got: ${JSON.stringify(got)}`);
      fail++;
    }
  };

  console.log('[V2] Electron 41 main 프로세스 + napi .node (U2)');
  console.log(`  electron ${process.versions.electron} / node ${process.versions.node} / modules ABI ${process.versions.modules}`);

  // 순수 Node가 빌드한 것과 정확히 동일한 .node — 재빌드 없이 로드되어야 U2 통과.
  const addon = require(path.join(__dirname, '..', 'dist', 'napi', 'index.cjs'));
  const { WmuxTerm } = addon;

  const term = new WmuxTerm(80, 24);
  check('new(80,24) cols', term.cols === 80, term.cols);
  check('new(80,24) rows', term.rows === 24, term.rows);

  const enc = new TextEncoder();
  const r = term.feed(enc.encode('electron main OK'));
  check('feed dirtyRows=1', r.dirtyRows === 1, r);
  check('snapshot_row(0) 선두 일치', term.snapshotRow(0).startsWith('electron main OK'), JSON.stringify(term.snapshotRow(0)));

  term.feed(enc.encode('\r\nline2'));
  check('CRLF 후 row1', term.snapshotRow(1).startsWith('line2'), JSON.stringify(term.snapshotRow(1)));

  if (fail === 0) {
    console.log('[V2] OK — Electron main에서 무재빌드 로드·왕복 성공');
    app.exit(0);
  } else {
    console.error(`[V2] FAIL — ${fail}건`);
    app.exit(1);
  }
}

app.whenReady().then(run).catch((e) => {
  console.error('[V2] 예외:', e);
  app.exit(1);
});
