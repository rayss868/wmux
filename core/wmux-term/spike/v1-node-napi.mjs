// V1 — 순수 Node에서 .node 애드온 require → new/feed/snapshot_row 왕복.
// 성공 조건: 왕복 결과가 기대와 일치 + exit 0.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const addon = require(path.join(here, '..', 'dist', 'napi', 'index.cjs'));

const { WmuxTerm } = addon;

let fail = 0;
function check(name, cond, got) {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    console.error(`  FAIL ${name} — got: ${JSON.stringify(got)}`);
    fail++;
  }
}

console.log('[V1] 순수 Node + napi .node 왕복');
console.log(`  node ${process.version}`);

const term = new WmuxTerm(10, 3);
check('cols getter', term.cols === 10, term.cols);
check('rows getter', term.rows === 3, term.rows);

const enc = new TextEncoder();
const r1 = term.feed(enc.encode('hi'));
check('feed dirtyRows=1', r1.dirtyRows === 1, r1);
check('feed writebackLen=0 (스켈레톤 상수)', r1.writebackLen === 0, r1);
check('snapshot_row(0) = "hi" + 공백', term.snapshotRow(0) === 'hi        ', JSON.stringify(term.snapshotRow(0)));

const r2 = term.feed(enc.encode('\r\ncd'));
check('CRLF 후 snapshot_row(1) = "cd"', term.snapshotRow(1) === 'cd        ', JSON.stringify(term.snapshotRow(1)));

// SGR 시퀀스가 셀에 새지 않는지(파서가 삼킴).
term.reset();
term.feed(enc.encode('\x1b[31mred\x1b[0m'));
check('reset + CSI 삼킴 → "red"만', term.snapshotRow(0) === 'red       ', JSON.stringify(term.snapshotRow(0)));

if (fail === 0) {
  console.log('[V1] OK — 전 왕복 통과');
  process.exit(0);
} else {
  console.error(`[V1] FAIL — ${fail}건`);
  process.exit(1);
}
