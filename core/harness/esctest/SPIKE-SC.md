# SPIKE S-C — esctest 어댑터 (결과)

- 스파이크: E0 S-C (결정 문서 `plans/engine-core-decision-2026-07-09.md` §5-3·D6 S-C 행·§8 U4)
- 목적: esctest2(GPL-2.0, 무수정 실행)를 PTY 어댑터로 구동해 피검체(@xterm/headless)에 질의
  왕복을 태우고, **통과 기준 = DECRQCRA 왕복 1건 + cup.py(CPR 기반) 완주**를 실증. 실패도
  유효 산출물(결정 문서 §7 폴백 "esctest 축 축소" 존재).
- 환경: macOS(darwin arm64), Python 3.14.6, Node v24.15.0, node-pty 1.1.x, @xterm/headless 6.
- vendor 핀: esctest2 `664be3cf2c1e3f06bc93a8bafb48a0db83c607db` (2025-08-24, ThomasDickey).

---

## 0. 결론 (TL;DR)

| 항목 | 결과 |
|---|---|
| **통과 기준 — DECRQCRA 왕복 1건** | **달성** — 대표 세트에서 DECRQCRA 브리지 왕복 **1052건** 성공(T1 게이트). |
| **통과 기준 — cup.py 완주** | **달성** — cup.py **6/6 케이스 전부 실행·판정 반환**, 하드 타임아웃 없음(T2 게이트). |
| 어댑터 아키텍처 | **성립** — node-pty로 esctest(python3, vendor) 스폰 → 바이트 라우팅 → xterm.js feed/응답. |
| GPL 격리 | **준수** — vendor/ gitignored, 저장소·CI·산출물에 GPL 소스 0, 체크섬 클린룸 도출. |
| 대표 세트 xterm.js 실태 | **16파일 92케이스 전부 pass** — 앵커 격리 시 xterm.js는 이 범위를 완전 준수(미준수 미발견). |
| 하니스 테스트 T1/T2/T3 | **19/19 통과** (`npm run test:harness`). |

**결정 문서 §5-3 대비 실측 델타 1건(정직 보고)**: §5-3은 "CPR 등은 xterm.js가 자체 방출하므로
구현 불요, DECRQCRA만 브리지"라 했으나, **XTERM_WINOPS 크기 리포트(`CSI 18 t`/`19 t`)도
xterm.js가 침묵**한다(실측). esctest `reset()`이 초기화에서 `GetScreenSize()`=`CSI 18 t`를
쓰므로, 이 브리지 없이는 **어떤 케이스도 실행되지 않는다**(reset이 timeout으로 죽음). DECRQCRA와
동일 성격의 geometry 브리지를 추가했다(어댑터가 grid 크기를 알므로 검증력 손실 0). 매핑 42파일이
이 의존을 가진다(query-dependency-map.md). → **M3/E1 확장 시 WINOPS 크기 브리지는 DECRQCRA와
같은 1급 어댑터 구성요소**.

---

## 1. 질의 의존 매핑 집계 (선행 반일 — U4 해소, 상세: query-dependency-map.md)

esctest2 `tests/*.py` **79파일**(80 − `__init__.py`) 기계 스캔. primary(파일당 최우선 질의 1개) 분포:

| primary 질의 | 파일 수 | 비율 |
|---|---:|---:|
| **DECRQCRA** (그리드 체크섬) | **47** | **59%** |
| CPR (커서 위치) | 14 | 18% |
| OSC 색 질의 | 6 | 8% |
| (무질의 — 되읽기 없음) | 5 | 6% |
| WINOPS (크기·타이틀) | 3 | 4% |
| DA / DA2 / DECRQM | 4 | 5% |

- **DECRQCRA가 esctest 가치의 대부분을 좌우**한다 — 주력 어서션 `AssertScreenCharsInRectEqual`이
  셀마다 1×1 rect DECRQCRA 체크섬 왕복을 돌기 때문(escutil 확인). 병용 포함 47파일 의존.
- CPR·WINOPS 크기는 각 43·42파일 의존. **sgr.py는 esctest2 자체의 깨진 import**(AssertCharHasSGR
  미정의)로 실행 불가 — 우리 결함 아님, vendor 실태로 기록.

---

## 2. cup.py 실행 결과 (T2 — 케이스별, xterm.js 실태)

`(?i)^CUPTests\.` 무수정 실행 (max-vt-level=5, timeout=3s):

| 케이스 | 판정 |
|---|---|
| CUPTests.test_CUP_ColumnOnly | **pass** |
| CUPTests.test_CUP_DefaultParams | **pass** |
| CUPTests.test_CUP_OutOfBoundsParams | **pass** |
| CUPTests.test_CUP_RespectsOriginMode | **pass** |
| CUPTests.test_CUP_RowOnly | **pass** |
| CUPTests.test_CUP_ZeroIsTreatedAsOne | **pass** |

**6/6 pass** — xterm.js는 CUP(커서 위치)를 정확히 준수. 이 실행에서 CPR 왕복 다수 + DECRQCRA 1건
+ WINOPS 크기 브리지 8건이 esctest로 되돌아갔다(reset의 tab-stop 설정 + RespectsOriginMode의
rect 체크섬). **cup.py는 무수정으로 완주하며 판정을 반환한다 → 통과 기준 달성.**

### 대표 세트 전체 (16파일, report.json)
`pass=92 fail=0 error=0`, DECRQCRA 브리지 왕복 **1052건**, WINOPS 브리지 125건.

| include | pass | DECRQCRA왕복 | | include | pass | DECRQCRA왕복 |
|---|---:|---:|---|---|---:|---:|
| CUP | 6 | 1 | | DECCRA | 10 | 456 |
| CUF | 5 | 0 | | DECFRA | 7 | 264 |
| CUB | 7 | 0 | | ED | 10 | 126 |
| CUU | 5 | 0 | | EL | 7 | 56 |
| CUD | 5 | 0 | | ICH | 6 | 120 |
| CHA | 6 | 1 | | DCH | 6 | 28 |
| VPA | 4 | 0 | | DA | 2 | 0 |
| HPA | 4 | 0 | | DA2 | 2 | 0 |

**xterm.js 미준수 발견: 없음(이 대표 세트 범위 내).** 앵커 격리 시 16파일 92케이스가 전부 pass —
xterm.js@6은 CUP/CUF/CUB/CUU/CUD/CHA/VPA/HPA/DECCRA/DECFRA/ED/EL/ICH/DCH/DA/DA2를 완전 준수.
(주의: 이는 "미준수가 없다"가 아니라 "이 16파일 범위에서 미발견"이다 — 전 80파일 실행은 M3 확장
과제. 픽셀/윈도우 축은 headless 개념 부재로 esctest 검증 불가.)

---

## 3. DECRQCRA 왕복 증적 (T1)

### 와이어 형식 (xterm ctlseqs 규격 — 클린룸 도출)
- 요청: `CSI Pid ; Pp ; Pt ; Pl ; Pb ; Pr * y` (intermediate `*`, final `y`)
- 응답: `DCS Pid ! ~ HHHH ST` = `ESC P {pid}!~{4자리 대문자 hex} ESC \`
- 체크섬: `(-Σ code) & 0xFFFF`, blank 셀 = 0x20 (xterm #336 "blank 균등", DEC VT520 실동작).

### 왕복 실증
- **대표 세트 1052건 왕복 성공** — deccra 456, decfra 264, ed 126, ich 120, el 56, dch 28,
  cup/cha 각 1. 전부 esctest 어서션을 통과했다(응답 체크섬이 esctest 기대와 일치).
- **규격 정합 교차검증**: esctest는 응답 체크섬을 `0x10000 - checksum`으로 역산해 문자 코드와
  비교한다(escutil.py:279 사용법 확인). 우리 브리지가 `(-sum)&0xFFFF`를 보내면 이 역산이 sum을
  정확히 복원 → 왕복이 성립(T3 단위 테스트가 이 항등을 고정).
- **체크섬 단위 정답**(T3, 파이썬 교차 계산): 'A'(1×1)=`0xFFBF`, 'AB'(1×2)=`0xFF7D`,
  'Hello'(1×5)=`0xFE0C`, 빈 2×2=`0xFF80` — 브리지 산출이 전부 일치.

---

## 4. DECRQCRA 브리지 사용 범위 (§5-3 문면 준수)

| 응답 경로 | 처리 주체 | 근거 |
|---|---|---|
| CPR (`CSI 6 n`) | **xterm.js 자체 방출**(무가공 라우팅) | 실측: `CSI 1;1R` 방출 |
| DA/DA2/DSR/DECRQM/DECXCPR | **xterm.js 자체 방출**(무가공 라우팅) | 실측: 전부 응답 |
| **DECRQCRA** (`CSI…*y`) | **어댑터 브리지**(그리드 스냅샷 체크섬) | xterm.js 미구현 — §5-3 명시 브리지 |
| **WINOPS 크기** (`CSI 18/19 t`) | **어댑터 브리지**(grid geometry) | **실측 추가** — xterm.js 침묵(§5-3 미포착) |
| WINOPS 픽셀/타이틀 push·pop | (미지원 — 흘려보냄) | headless 개념 부재(정직한 한계) |

- 브리지 2종 다 리포트 필드로 사용량 기록(`decrqcraBridgeUses`·`winopsBridgeUses`).
- 브리지는 **판정 대상(그리드/geometry)에서 산출**하므로 검증력 유지 — 어댑터가 응답을 "지어내는"
  것이 아니라 피검체 상태를 규격 형식으로 되쓴다. 이 경로가 xterm.js 한정임을 대장에 기록(E1
  코어는 자체 writeback으로 DECRQCRA·WINOPS를 방출할 수 있어 브리지 불요 — §6-1 Interactive 모드).

---

## 5. GPL 격리 준수 체크리스트 (§5-3 정책)

| 항목 | 상태 | 증거 |
|---|---|---|
| esctest 소스 저장소 미커밋 | ✅ | `.gitignore`에 `core/harness/esctest/vendor/` 등재, `git check-ignore` 확인 |
| 실행 시점 클론(커밋 핀) | ✅ | `fetch-esctest.sh` — 핀 `664be3c…` 클론 + 핀 해시 검증 |
| CI 캐시·아티팩트·배포물 GPL 미포함 | ✅ | vendor는 gitignored, 제품 빌드(src/·packaged)는 vendor 무접촉 |
| NOTICE 실행 의존 고지 | ✅ | `core/harness/esctest/NOTICE.md` 신설(루트 THIRD_PARTY 무접촉 — 배포물 무접촉) |
| DECRQCRA 체크섬 클린룸 도출 | ✅ | `decrqcra.ts` 주석 — DEC STD 070 / xterm ctlseqs 출처 명시, vendor 로직 미참조 |
| 스캐너가 GPL 로직 미독해 | ✅ | grep 유사 심볼 카운트만(로직 이식 아님) — query-dependency-map.md 방법론 |
| 실행 인자·I/O 프로토콜 사용법 | ✅ | vendor README·`--help`·escio 시그니처 확인(사용법은 격리와 무관, 로직 이식만 금지) |

> 클린룸 보강: esctest는 **애초에 체크섬을 계산하지 않는다** — DECRQCRA 요청만 보내고 계산은
> 터미널 몫이다. 즉 체크섬 알고리즘은 vendor 소스에 존재하지도 않으며, 우리는 xterm이 응답으로
> 낼 값을 피검체 그리드에서 독립 재현했다(참조할 GPL 로직이 없었음 — 규격에서만 도출).

---

## 6. 마찰 · 우회

| # | 마찰 | 우회 / 해소 |
|---|---|---|
| F1 | esctest는 stdin에 `tty.setraw` — tty 없으면 `termios.error`로 즉사 | **PTY 필수** 확정. node-pty로 python3를 PTY 자식 스폰(escio가 sys.stdin/stdout↔PTY 사용). |
| F2 | reset()이 `GetScreenSize()`=`CSI 18 t`를 쓰는데 xterm.js가 침묵 → 모든 케이스가 reset에서 timeout | **WINOPS 크기 브리지 추가**(§5-3 미포착 델타). 어댑터가 grid geometry로 `CSI 8;rows;cols t` 응답. |
| F3 | `--include`는 case-sensitive `re.search` — 소문자 파일명(`cup`)이 대문자 클래스(`CUPTests`)에 안 맞음 | 어댑터가 include에 `(?i)` 플래그 자동 부여(이미 `(?...)`면 존중). |
| F4 | 짧은 이름 부분매칭 폭발 — `(?i)cha`가 `ChangeColorTests`까지 매칭 → OSC 색 질의에서 hang(timeout) | **클래스 접두 앵커** `(?i)^<Class>Tests\.` 사용(gen-report 기본). 클래스명은 파일명과 1:1 아님(ed.py→EDTests) — vendor 클래스명 그대로 앵커. |
| F5 | esctest 로그 포맷이 추측과 다름(`Run test:`/`Passed.`, `*** TEST X FAILED:`) | 파서를 vendor 실측 포맷에 맞춰 재작성(parseEsctestLog). known-bug `Fails as expected:`=pass, skip 표식 처리. |
| F6 | 픽셀 크기(`CSI 14 t`)·윈도우 픽셀 질의는 headless 개념 부재로 응답 불가 | **정직한 한계로 기록** — 픽셀 축은 esctest 검증 불가(흘려보냄, 해당 케이스는 timeout). 5-2 차등이 상보. |
| F7 | tsx 부재로 gen-report 직접 실행 불가 | esbuild 번들(external deps) + `WMUX_ESCTEST_VENDOR`/`WMUX_ESCTEST_REPORT` env 오버라이드로 실행(어댑터도 동일 패턴). |
| F8 | DECRQCRA 요청이 청크 경계에 걸릴 수 있음 | 어댑터가 미완결 요청을 `incomplete`로 이월(pending 버퍼) — 다음 chunk와 합쳐 재파싱. |

---

## 7. E0/M3 확장 시 우선 파일 목록 (질의 매핑 기반 — 데이터)

query-dependency-map.md §"M3 확장 우선 파일"과 동일. 요지:
1. **CPR-only 14파일** — 브리지 불요(코어도 CPR 자체 방출), 최저비용 즉시 검증군.
2. **DECRQCRA 순수군** — 브리지 왕복 대량 실증 완료(deccra 456회 등).
3. **DA/DA2/DECRQM** — xterm.js 자체 방출 확인, 브리지 불요.
4. **제외/저가치** — 무질의 5파일(검증력 없음)·sgr(깨진 import)·픽셀 축·OSC 색 6파일.

## 8. 재현 방법

```bash
# 1) vendor 페치 (GPL, gitignored — 네트워크 필요)
bash core/harness/esctest/fetch-esctest.sh

# 2) 통과 기준 게이트 (T1 DECRQCRA 왕복 + T2 cup.py 완주 + T3 체크섬)
npm run test:harness   # vitest.harness — esctest-adapter.harness.test.ts 포함

# 3) 리포트 생성 (report.json — xterm.js 기준선 실태)
#    tsx 부재 시 esbuild 번들 경로(SPIKE §6 F7). WMUX_ESCTEST_REPORT로 출력 경로 지정.
```

- report.json은 xterm.js 산출물(GPL 아님)이라 커밋 가능 — 절대경로는 `<vendor>`로 스크럽.
- vendor 부재 시 T1/T2는 명시 skip(T3·파서 단위는 vendor 무관 항상 실행).
