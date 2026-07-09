// V5 — wasm 인스턴스 3개 동시 생성(각 80×24 + feed 1MB) 시 메모리 오더 기록.
// nodejs 타깃 wasm-bindgen 모듈은 단일 wasm 인스턴스(모듈 공유)이므로,
// "인스턴스"는 WmuxTerm 객체 3개(각각 자체 그리드 + 선형 메모리 상 Vec 할당)를 뜻한다.
// process.memoryUsage()로 RSS·external·wasm 선형 메모리(ArrayBuffer 바이트) 오더 측정.
const path = require('node:path');
const wasm = require(path.join(__dirname, '..', 'dist', 'wasm-node', 'wmux_term.js'));
const { WmuxTerm } = wasm;

function synth1MB() {
  const block = Buffer.from(
    '\x1b[32m  Compiling\x1b[0m module \x1b[1msome/path.rs\x1b[0m ok\r\n',
    'latin1'
  );
  const parts = [];
  let len = 0;
  const target = 1024 * 1024;
  while (len < target) { parts.push(block); len += block.length; }
  return Buffer.concat(parts).subarray(0, target);
}

// wasm 선형 메모리 바이트 — wasm-bindgen이 노출하는 memory.buffer.
function wasmMemBytes() {
  // nodejs glue는 `wasm` 심볼로 exports를 담는다. memory export 접근.
  try {
    // wasm-bindgen nodejs 산출물은 내부적으로 wasm.memory를 쓴다 — d.ts엔 없으나
    // 런타임 exports에 존재. 안전 접근 위해 __wbindgen 계열 없이 memory만 탐색.
    const mod = require(path.join(__dirname, '..', 'dist', 'wasm-node', 'wmux_term_bg.js'));
    // bg.js가 없을 수도 있으니(단일 파일 산출) fallback.
    return mod && mod.memory ? mod.memory.buffer.byteLength : null;
  } catch {
    return null;
  }
}

function snap(label) {
  const m = process.memoryUsage();
  return {
    label,
    rssMB: (m.rss / 1048576).toFixed(2),
    externalMB: (m.external / 1048576).toFixed(2),
    arrayBuffersMB: (m.arrayBuffers / 1048576).toFixed(2),
  };
}

console.log('[V5] wasm 인스턴스 3개 동시 — 메모리 오더');
console.log(`  node ${process.version}`);

const stream = synth1MB();
const rows = [];
rows.push(snap('baseline (모듈 로드 후)'));

const terms = [];
for (let i = 0; i < 3; i++) {
  const t = new WmuxTerm(80, 24);
  t.feed(stream); // 1MB feed.
  terms.push(t);
  rows.push(snap(`인스턴스 ${i + 1} 생성+1MB feed 후`));
}

// 살아있게 유지(GC 방지).
let checksum = 0;
for (const t of terms) checksum += t.snapshot_row(0).length;

const memBytes = wasmMemBytes();

console.log('  --- process.memoryUsage() 오더 ---');
for (const r of rows) {
  console.log(`  ${r.label.padEnd(30)} rss=${r.rssMB}MB external=${r.externalMB}MB arrayBuffers=${r.arrayBuffersMB}MB`);
}
if (memBytes != null) {
  console.log(`  wasm 선형 메모리(공유 인스턴스) = ${(memBytes / 1048576).toFixed(2)} MB`);
} else {
  console.log('  wasm 선형 메모리 = (nodejs 단일 파일 산출 — memory export 직접 노출 안 됨, RSS 오더로 대체)');
}
console.log(`  (checksum=${checksum})`);

// 메모리 오더 판정: 3개 인스턴스가 RSS를 폭증시키지 않는지(각 그리드는 80*24 char = ~7.7KB).
// 이 검증은 "오더 기록"이 목적 — pass/fail 게이트 아님(결정 문서 V5 = 기록).
console.log('[V5] OK — 오더 기록 완료(게이트 아님, E2 SharedArrayBuffer 전 미측정치)');
process.exit(0);
