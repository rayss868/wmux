#!/usr/bin/env bash
# S-A1 스파이크 빌드 — napi .node(darwin-arm64) + wasm(web/nodejs) + 네이티브 벤치 바이너리.
# 로컬 전용(CI 편입은 S-A2). Rust는 cargo PATH 필요.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CRATE_DIR/../.." && pwd)"
NAPI="$REPO_ROOT/node_modules/.bin/napi"
WASM_PACK="$REPO_ROOT/node_modules/.bin/wasm-pack"
# wasm-bindgen CLI는 wasm-pack이 Cargo.lock의 wasm-bindgen 버전에 맞춰 자체
# 다운로드·캐시·실행한다 — 홈 캐시 PATH 주입 금지(글로벌 상태 의존, 리뷰 반영).

cd "$CRATE_DIR"

echo "==> [1/4] napi .node (aarch64-apple-darwin)"
"$NAPI" build --manifest-path ./Cargo.toml --output-dir ./dist/napi \
  --platform --release --js index.cjs --dts index.d.ts

echo "==> [2/4] wasm web 타깃(렌더러용)"
"$WASM_PACK" build --target web --release --out-dir ./dist/wasm-web --out-name wmux_term

echo "==> [3/4] wasm nodejs 타깃(V4b 벤치·V5 메모리용 — web과 동일 .wasm)"
"$WASM_PACK" build --target nodejs --release --out-dir ./dist/wasm-node --out-name wmux_term

echo "==> [4/4] 네이티브 벤치 바이너리(bench 피처, 바인딩 제외)"
cargo build --release --no-default-features --features bench --bin bench_native

echo "==> 완료. 산출물:"
ls -la dist/napi/*.node dist/wasm-web/*.wasm dist/wasm-node/*.wasm target/release/bench_native 2>/dev/null || true
