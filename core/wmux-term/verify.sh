#!/usr/bin/env bash
# S-A1 스파이크 검증 5종 — V1~V5 순차 실행, 하나라도 실패 시 비영 종료.
# 리뷰 반영: stale artifact로 통과하는 구멍을 막기 위해 검증 전 빌드를 강제한다
# (현재 소스에서 재빌드된 산출물만 검증 대상 — cargo/wasm-pack 증분 빌드라 반복 비용 낮음).
set -uo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CRATE_DIR/../.." && pwd)"
ELECTRON="$REPO_ROOT/node_modules/.bin/electron"

cd "$CRATE_DIR"

echo "==> 검증 전 빌드 강제(stale artifact 방지)"
bash "$CRATE_DIR/build.sh" || { echo ">>> 빌드 실패 — 검증 중단"; exit 1; }
FAIL=0
run() { echo ""; echo "======== $1 ========"; shift; "$@"; local rc=$?; if [ $rc -ne 0 ]; then echo ">>> 실패(exit $rc)"; FAIL=1; fi; }

echo "==> cargo test(공용 그리드 로직)"
cargo test --release 2>&1 | tail -8 || FAIL=1

run "V1 순수 Node napi" node "$CRATE_DIR/spike/v1-node-napi.mjs"
run "V2 Electron main napi" "$ELECTRON" "$CRATE_DIR/spike/v2-electron-main.cjs"
run "V3 Electron 렌더러 wasm" "$ELECTRON" "$CRATE_DIR/spike/v3-renderer/main.cjs"
run "V4a 네이티브 vte 처리량" "$CRATE_DIR/target/release/bench_native"
run "V4b wasm 처리량" node "$CRATE_DIR/spike/v4b-wasm-bench.cjs"
run "V5 wasm 메모리 오더" node "$CRATE_DIR/spike/v5-wasm-memory.cjs"

echo ""
if [ $FAIL -eq 0 ]; then echo "==> 검증 5종 전부 통과"; exit 0; else echo "==> 일부 실패"; exit 1; fi
