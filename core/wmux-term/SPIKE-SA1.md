# SPIKE S-A1 — 이중 타깃 배관 실증 (결과)

- 스파이크: E0 S-A1 (결정 문서 `plans/engine-core-decision-2026-07-09.md` §D5·§D6 S-A1 행·§6 코어 계약)
- 목적: 동일 코어(vte + 미니 그리드)가 **napi `.node`(데몬) + wasm(렌더러)** 두 타깃으로
  단일 크레이트 `cfg` 분기로 빌드·로드·왕복하는지 실증. VT 정확도는 E1 몫 — 이건 배관 실증.
- 환경: macOS(darwin arm64), rustc 1.96.1, Node v24.15.0, Electron 41.0.3(Node 24.14 / Chrome 146 / ABI 145).
- 범위: 로컬 전용. CI 편입·6조합·서명은 S-A2로 이월(본 스파이크 미착수).

---

## 0. 결론 (TL;DR)

| 항목 | 결과 |
|---|---|
| 단일 크레이트 `cfg` 분기 성립 | **성립** — 분리 크레이트 후퇴 불요(§7 리스크 회피). native=napi·wasm=wasm-bindgen 의존 완전 격리(`cargo tree` 실증). |
| 검증 5종(V1~V5) | **전건 통과** — 처리량 게이트 2개 모두 초과, 메모리 오더 양호. |
| napi ABI 무재빌드(U2) | **실증** — Node 24.15 빌드 `.node`가 Electron 41(Node 24.14, ABI 145)에서 무수정 로드. |
| S-A2 이월 | 6조합 프리빌드 CI + optionalDependencies + macOS 서명·공증 무회귀 + 패키지드 앱 로드 + MSRV≥1.88 CI 핀. |

---

## 1. 검증 5종 결과표

| # | 검증 | 명령 | 수치·결과 | 판정 |
|---|---|---|---|---|
| V1 | 순수 Node에서 `.node` require → new/feed/snapshot_row 왕복 | `node spike/v1-node-napi.mjs` | 7 assert PASS (cols/rows/dirtyRows=1/writebackLen=0/snapshot/CRLF/CSI삼킴), exit 0 | **PASS** |
| V2 | Electron 41 main에서 동일 `.node` 로드 (U2) | `electron spike/v2-electron-main.cjs` | electron 41.0.3 / node 24.14.0 / ABI 145에서 무재빌드 로드, 5 assert PASS, exit 0 | **PASS** |
| V3 | Electron 렌더러(hidden `show:false`)에서 web 타깃 wasm 로드 → feed 왕복 → IPC 회수 | `electron spike/v3-renderer/main.cjs` | chrome 146, 6 assert PASS, IPC 결과 회수, exit 0 | **PASS** |
| V4a | 네이티브 vte 단독 feed 처리량 (64MB 합성 ANSI, 워밍업 후) | `target/release/bench_native` | **634~782 MB/s** (게이트 ≥250, 예산 500) | **PASS** |
| V4b | wasm 스켈레톤 feed 처리량 (nodejs 타깃 = web과 동일 `.wasm`) | `node spike/v4b-wasm-bench.cjs` | **560~637 MB/s** (게이트 ≥75, 예산 150) | **PASS** |
| V5 | wasm 인스턴스 3개 동시(각 80×24 + 1MB feed) 메모리 오더 | `node spike/v5-wasm-memory.cjs` | baseline RSS 51.8MB → 3개 후 56.7MB (총 +4.9MB, 인스턴스 2·3은 거의 0) | **기록**(게이트 아님) |

일괄 재현: `npm run spike:sa1:build && npm run spike:sa1:verify`.

### V4 처리량 상세
- V4a/V4b 모두 동일 합성 스트림(SGR 색 전환 + 텍스트 + CSI 커서 + CRLF 블록, 실제 CLI 출력 근사),
  16KB 청크 feed, 3MB 워밍업 후 64MB 측정.
- **관찰: wasm이 네이티브의 ~85~90%** — 워크로드가 파서 바운드(vte 상태기)이고 그리드가 미니멀해서
  wasm 선형 메모리 접근 오버헤드가 작다. **주의**: 스켈레톤은 SGR/스크롤/reflow 미구현 →
  E1에서 셀 속성·reflow가 붙으면 두 타깃 모두 처리량이 내려간다. 본 수치는 **오더 확인용 상한**이지
  E1 예산 판정치가 아니다(결정 문서 게이트도 "예산의 50% 오더" — 절대 판정은 E1/E4).
- 게이트가 예산의 50%인 이유(설계 재검토 트리거)를 양 타깃 모두 넉넉히 상회 → **설계 재검토 트리거 미발동**.

### V5 메모리 상세
- nodejs 타깃 wasm-bindgen 산출물은 **단일 wasm 인스턴스(모듈 공유)** — "인스턴스"는 `WmuxTerm` 객체
  3개(각자 자체 그리드 Vec + 커서)를 뜻한다. 그리드는 80×24 char ≈ 7.7KB로 지극히 작다.
- 1MB feed는 transient(파서가 소비, 셀엔 마지막 화면만 남음) → RSS 증가의 대부분은 첫 인스턴스의
  wasm 힙 확장이고 2·3번째는 거의 무증가. **50페인 우려에 대한 긍정 신호**.
- **한계 명시**: wasm 선형 메모리 export가 nodejs 단일 파일 glue에서 직접 노출되지 않아
  RSS/external 오더로 대체 측정. 본 판정은 **E2 SharedArrayBuffer 도입 전 미측정치**(결정 문서 §7 리스크 대장).

---

## 2. 단일 크레이트 `cfg` 분기 — 성립 실증

핵심 아키텍처 주장(결정 문서 D5): "코어 로직은 공용 모듈 1개, 바인딩 레이어만 `cfg` 분기".

구조:
- `src/grid.rs` — **유일 공용 모듈**. vte raw `Perform` 8콜백 + 미니 그리드(문자 셀 + 커서).
  `print`=셀 기록+커서 전진, `execute`=CR/LF만. SGR/스크롤/reflow **미구현**(스켈레톤).
- `src/lib.rs` — `#[cfg(all(feature="bindings", target_arch="wasm32"))] mod wasm_binding;` /
  `#[cfg(all(feature="bindings", not(target_arch="wasm32")))] mod napi_binding;`
- `src/napi_binding.rs` / `src/wasm_binding.rs` — 각각 `Grid`를 감싸는 **얇은 어댑터**(로직 중복 0).

`cargo tree` 격리 증거:

```
# native (default)  → napi 3.10.3 + vte, wasm-bindgen 없음
├── napi v3.10.3 / napi-derive v3.5.9 / napi-sys v3.2.2 / napi-build v2.3.2
└── vte v0.15.0

# wasm32            → wasm-bindgen 0.2.126 + vte, napi 없음
├── vte v0.15.0
└── wasm-bindgen v0.2.126
```

**⇒ 분리 크레이트 후퇴 불요.** §7 리스크("wasm+napi 동시 산출 마찰 → 분리 크레이트 후퇴")는 발동하지 않았다.

---

## 3. 셋업 선택 근거

| 선택 | 결정 | 근거 |
|---|---|---|
| wasm 빌더 | **wasm-pack 0.15.0** (npm devDep) | cargo install(글로벌 상태) 대신 npm devDep → 버전이 package.json/lockfile에 핀, CI(S-A2) 동일 버전 상속, 재현성 확보. 리포 관례(모든 툴이 npm devDep)와 정합. |
| napi 빌더 | **@napi-rs/cli 3.7.2** (npm devDep) | 동일 재현성 논리. napi CLI v3는 crate 디렉터리에 `package.json`(napi 설정) 요구 → `core/wmux-term/package.json` 신설(napi 설정 전용, private). |
| napi 크레이트 버전 핀 | **napi-rs 메이저 3** (napi 3.10.3 / napi-derive 3 / napi-build 2) | 결정 문서 D5 "최신 안정 메이저 핀". Cargo.toml에 `"3"` 캐럿으로 메이저 고정. |
| napi 피처 | `default-features=false, features=["napi8"]` | N-API v8(Node 12.22+/Electron 전 지원 범위 커버). 불필요 기본 피처 제거. |
| wasm 타깃 | **web(렌더러 정본) + nodejs(벤치·메모리 측정)** | web 타깃은 V3 렌더러 실증. nodejs 타깃은 동일 `.wasm`(glue만 다름) — Node에서 web ESM+fetch 로드가 번거로워 V4b/V5 계측용으로 추가(결정 문서 V4b 허용 조항). |

---

## 4. 마찰 지점과 우회 (정직 보고)

| # | 마찰 | 우회 | 근본 마찰 여부 |
|---|---|---|---|
| F1 | napi CLI v3가 crate에 `package.json` 요구(standalone json 불가) — 없으면 "package.json not found" | `core/wmux-term/package.json`(napi 설정 전용, private) 신설 | 배관 관례(napi-rs 표준 레이아웃). 근본 마찰 아님. |
| F2 | 마이크로벤치 바이너리가 rlib 링크 시 napi 런타임 심볼(`napi_*`) 미해결 — 스탠드얼론 바이너리엔 Node 런타임 부재 | `bench` 피처 + `[[bin]] required-features=["bench"]`로 napi 빌드에서 격리, 벤치는 `--no-default-features --features bench`로 순수 `Grid`만 링크 | **napi 바인딩의 본질적 성질**(심볼은 로드타임 Node 제공). 피처 게이트가 정석 해법 — 근본 마찰 아니나 E1에서 벤치/바인딩 분리를 계약으로 유지 필요. |
| F3 | vte 0.15 `advance(&mut self, perform, bytes)` — 파서를 그리드가 소유하면 대여 충돌 | `std::mem::take`로 파서를 잠시 분리 → `self`를 `Perform`으로 대여 → 복귀 | vte 0.15 API 형상. 근본 마찰 아님(관용 패턴). E1에서 파서 소유 구조 재검토 여지. |
| F4 | wasm-pack가 out-dir마다 `.gitignore`(`*`) 생성 | 스파이크 산출물은 build.sh 재생성 → crate `.gitignore`로 `dist/` 전체 제외 | 스파이크 한정. 근본 마찰 아님. |

**근본 마찰로 실패한 항목: 없음.** 전 검증 통과, 분리 크레이트 후퇴 불요.

---

## 5. 발견 사항 (S-A2·E1에 영향)

1. **MSRV 상승 — napi-rs 3 = rustc 1.88** (S-0 조건 ②c 해소):
   - vte 1.62.1 / wasm-bindgen 1.77 / **napi 3.10.3 = 1.88** → **교집합 MSRV = 1.88**. 설치본 1.96.1로 여유.
   - **S-A2 조치 필요**: 6조합 CI 툴체인을 **≥1.88**로 핀(napi 메이저 3의 하한).
2. **wasm/native 처리량 근접**은 스켈레톤 특성(파서 바운드) — E1에서 셀 속성·reflow 추가 시 재계측 필수.
3. **V5 wasm 선형 메모리 직접 측정 불가**(nodejs glue 비노출) — E2에서 web 타깃 `memory.buffer` 직접 계측 경로 필요.
4. **napi CLI가 전 타깃 빌드** — 벤치 바이너리를 `required-features`로 격리하지 않으면 `.node` 빌드가 깨진다(F2). E1에서 벤치/바인딩 격리 규율 유지.

---

## 6. S-A2 이월 항목 (본 스파이크 미착수)

- **6조합 프리빌드 CI**: win(x64/arm64) · mac(x64/arm64) · linux(x64/arm64) `.node` 매트릭스. (본 스파이크는 darwin-arm64 1개.)
- **optionalDependencies 패키징**: 플랫폼별 `.node`를 optionalDependencies로 분배(napi-rs 표준).
- **macOS 서명·공증 무회귀** (S-A2 1급 기준): 신규 `.node`의 osxSign entitlements·프루닝 편입. `forge.config.ts` 프레임에 신규 네이티브 애드온 등록.
- **패키지드 앱 로드**(win): electron-forge package 산출물에서 `.node` 로드 실증.
- **CI 툴체인 ≥1.88 핀** (본 스파이크 발견 5-1).
- **wasm web 타깃의 렌더러 워커 통합**: 실제 xterm.js 폴백 경로 배선(E2 damage 소비와 연동).

---

## 7. 산출물 위치

- 크레이트: `core/wmux-term/` (Cargo.toml / src/{lib,grid,napi_binding,wasm_binding}.rs / build.rs / package.json)
- 검증 스크립트: `core/wmux-term/spike/` (v1~v5) + `src/bin/bench_native.rs`
- 빌드·검증 오케스트레이터: `core/wmux-term/{build.sh,verify.sh}` → npm `spike:sa1:build` / `spike:sa1:verify`
- 산출물(gitignore, 로컬 재생성): `dist/napi/*.node` · `dist/wasm-web/` · `dist/wasm-node/`
