#!/usr/bin/env bash
# E0 하니스 M3 — esctest2 벤더 페치 (GPL 격리 정책: engine-core-decision-2026-07-09.md §5-3)
#
# esctest2(ThomasDickey/esctest2)는 GPL-2.0이다. 저장소에 소스를 **커밋하지 않는다** —
# 이 스크립트가 실행 시점에 커밋 핀으로 vendor/에 클론하고 핀 해시를 검증한다.
# vendor/ 는 .gitignore 등재(저장소·CI 캐시·아티팩트·배포물 어디에도 GPL 파일 없음).
#
# 클린룸 규율: 이 스크립트와 어댑터는 esctest의 "사용법"(실행 인자·I/O 채널)만 쓴다.
# DECRQCRA 체크섬 계산 로직은 vendor/ 소스에서 이식하지 않는다 — DEC STD 070 / xterm
# ctlseqs 규격에서만 도출한다(adapter.ts 주석에 출처 명시).
set -euo pipefail

# ── 커밋 핀 ─────────────────────────────────────────────────────────────────
# 2025-08-24 Thomas E. Dickey. 업그레이드 시 이 해시만 교체(재현성 고정).
ESCTEST_REPO="https://github.com/ThomasDickey/esctest2.git"
ESCTEST_PIN="664be3cf2c1e3f06bc93a8bafb48a0db83c607db"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="$SCRIPT_DIR/vendor"

# 이미 올바른 핀으로 존재하면 재사용(네트워크 재접촉 회피).
if [ -d "$VENDOR_DIR/.git" ]; then
  current="$(git -C "$VENDOR_DIR" rev-parse HEAD 2>/dev/null || echo none)"
  if [ "$current" = "$ESCTEST_PIN" ]; then
    echo "[fetch-esctest] vendor already at pin $ESCTEST_PIN — reuse"
    exit 0
  fi
  echo "[fetch-esctest] vendor exists at $current, expected $ESCTEST_PIN — re-fetching"
  rm -rf "$VENDOR_DIR"
fi

echo "[fetch-esctest] cloning $ESCTEST_REPO @ $ESCTEST_PIN"
# 얕은 히스토리로 핀만 가져온다. 네트워크 필요.
git clone --no-checkout --filter=blob:none "$ESCTEST_REPO" "$VENDOR_DIR"
git -C "$VENDOR_DIR" checkout --quiet "$ESCTEST_PIN"

# 핀 검증(중간자·태그 이동 방어).
got="$(git -C "$VENDOR_DIR" rev-parse HEAD)"
if [ "$got" != "$ESCTEST_PIN" ]; then
  echo "[fetch-esctest] PIN MISMATCH: got $got expected $ESCTEST_PIN" >&2
  exit 1
fi

# GPL 라이선스 실재 확인(격리 정책 근거의 사실 확인).
if ! grep -qi "GNU GENERAL PUBLIC LICENSE" "$VENDOR_DIR/LICENSE" 2>/dev/null; then
  echo "[fetch-esctest] WARNING: expected GPL LICENSE not found in vendor" >&2
fi

echo "[fetch-esctest] OK — vendored at $VENDOR_DIR (pin $ESCTEST_PIN, GPL-2.0, gitignored)"
