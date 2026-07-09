// V4b — wasm 스켈레톤 feed 처리량 마이크로벤치.
// 게이트 ≥75MB/s(예산 150의 50%). web 타깃 wasm을 Node에서 로드하기 어려워
// wasm-bindgen nodejs 타깃을 추가로 빌드해 측정한다(결정 문서 V4b 허용 조항).
// nodejs 타깃과 web 타깃은 동일 .wasm 바이너리(wmux_term_bg.wasm) — glue만 다름.
const path = require('node:path');
const { WmuxTerm } = require(path.join(__dirname, '..', 'dist', 'wasm-node', 'wmux_term.js'));

// V4a와 동일 합성 스트림(공정 비교).
function synthStream(targetBytes) {
  const block = Buffer.from(
    '\x1b[31mERROR\x1b[0m build failed at \x1b[1msrc/main.rs:42\x1b[0m: ' +
    'expected `;` \x1b[2mnote: consider adding\x1b[0m\r\n' +
    '\x1b[32m  Compiling\x1b[0m wmux-term v0.0.0 (units 1/1)\r\n',
    'latin1'
  );
  const parts = [];
  let len = 0;
  while (len < targetBytes) { parts.push(block); len += block.length; }
  return Buffer.concat(parts).subarray(0, targetBytes);
}

const TOTAL = 64 * 1024 * 1024; // 64MB
const CHUNK = 16 * 1024;
const stream = synthStream(TOTAL);

// 워밍업 — 3MB(JIT·wasm 인스턴스 안정화).
{
  const g = new WmuxTerm(80, 24);
  const warm = stream.subarray(0, 3 * 1024 * 1024);
  for (let off = 0; off < warm.length; off += CHUNK) {
    g.feed(warm.subarray(off, off + CHUNK));
  }
}

// 측정.
const g = new WmuxTerm(80, 24);
const t0 = process.hrtime.bigint();
let accDirty = 0;
for (let off = 0; off < stream.length; off += CHUNK) {
  const r = g.feed(stream.subarray(off, off + CHUNK));
  accDirty += r.dirty_rows;
}
const t1 = process.hrtime.bigint();

const secs = Number(t1 - t0) / 1e9;
const mb = TOTAL / (1024 * 1024);
const mbps = mb / secs;

console.log('[V4b] wasm 스켈레톤 feed 처리량 (nodejs 타깃 — web과 동일 .wasm)');
console.log(`  node ${process.version}`);
console.log(`  bytes    = ${mb} MB`);
console.log(`  elapsed  = ${secs.toFixed(4)} s`);
console.log(`  throughput = ${mbps.toFixed(1)} MB/s`);
console.log(`  gate     = 75 MB/s (예산 150의 50%)`);
console.log(`  (accDirty=${accDirty} — 최적화 방지)`);
if (mbps >= 75.0) {
  console.log('  RESULT   = PASS');
  process.exit(0);
} else {
  console.log('  RESULT   = BELOW GATE (설계 재검토 트리거 데이터)');
  process.exit(2);
}
