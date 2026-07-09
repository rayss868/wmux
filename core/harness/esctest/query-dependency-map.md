# esctest2 질의 의존 매핑 (E0 하니스 M3, U4 해소)

- 스파이크: E0 S-C (결정 문서 `plans/engine-core-decision-2026-07-09.md` §5-3·D6 S-C 행·§8 U4)
- 대상: esctest2 (github.com/ThomasDickey/esctest2) 커밋 핀 `664be3cf2c1e3f06bc93a8bafb48a0db83c607db` (2025-08-24)
- 방법: `tests/*.py` **79파일 기계 스캔**(grep 유사 심볼 카운트 — GPL 로직 미독해, "어떤 응답
  질의를 쓰는가"의 의존 목록만 추출). 스캐너는 헬퍼 호출(GetCursorPosition·
  AssertScreenCharsInRectEqual 등)과 직접 esccmd 호출(DECRQCRA·DA·…)을 심볼 매칭으로 센다.
- **이 표가 M3 가치 판정의 근거다**: DECRQCRA 기반이 몇 파일 / CPR만 몇 파일 / 무질의 몇 파일.

> 파일 수: 80개 중 `__init__.py`(테스트 아님)를 제외한 **79개**가 스캔 대상.

## 헬퍼 → 질의 매핑 (esctest 프레임워크 사용법, escutil/esccmd 확인)

| esctest 헬퍼 / 심볼 | 방출 질의 | 와이어 (요청 → 응답) |
|---|---|---|
| `AssertScreenCharsInRectEqual`, `GetChecksumOfRect`, `AssertCharHasSGR` | **DECRQCRA** | `CSI Pid;Pp;t;l;b;r * y` → `DCS Pid !~ HHHH ST` |
| `GetCursorPosition` (`DSR DSRCPR`), `DECXCPR` | **CPR** | `CSI 6 n` → `CSI row;col R` |
| `GetScreenSize`/`GetDisplaySize`/`GetWindowTitle`/… (`XTERM_WINOPS`) | **WINOPS** | `CSI 18 t`·`19 t`·`11 t`·타이틀 → 리포트 |
| `esccmd.DA`, `DECID` | **DA** | `CSI c` → `CSI ?…c` |
| `esccmd.DA2` | **DA2** | `CSI > c` → `CSI >…c` |
| `DECRQSS` | **DECRQSS** | `DCS $ q … ST` → `DCS … ST` |
| `DECRQM` | **DECRQM** | `CSI ? Ps $ p` → `CSI ? Ps;v $ y` |
| `DSRDECLocatorStatus`·`DSRKeyboard`·… | **DSR_OTHER** | 각 DSR 서브타입 |
| `GetIndexedColors`·`ReadOSC`·`reset_color` | **OSC_QUERY** | OSC 색/타이틀 질의 |

> **결정적 관찰**: `AssertScreenCharsInRectEqual`(테스트 슈트의 주력 어서션)는 내부적으로
> **셀마다 1×1 rect DECRQCRA 체크섬 왕복**을 돈다(escutil `GetChecksumOfRect` → `esccmd.DECRQCRA`).
> 즉 "화면 문자를 읽는" 거의 모든 검증이 DECRQCRA에 의존한다. 이것이 DECRQCRA 지원이
> esctest 축의 핵심 게이트인 이유다.

## 집계 (primary = 파일이 의존하는 최우선 질의 1개)

| primary 질의 | 파일 수 | 비율 |
|---|---:|---:|
| **DECRQCRA** (그리드 체크섬 왕복) | **47** | **59%** |
| CPR (커서 위치만) | 14 | 18% |
| OSC_QUERY (색/타이틀) | 6 | 8% |
| (무질의 — 화면 되읽기 없음) | 5 | 6% |
| WINOPS (윈도우/화면 크기·타이틀) | 3 | 4% |
| DA (장치 속성) | 2 | 3% |
| DA2 | 1 | 1% |
| DECRQM (모드 질의) | 1 | 1% |

**병용 포함 집계**(한 파일이 여러 질의를 쓰면 각각에 카운트):

| 질의 | 의존 파일 수 | 비율 |
|---|---:|---:|
| DECRQCRA | 47 | 59% |
| CPR | 43 | 54% |
| WINOPS | 42 | 53% |
| DA/DA2 | 4 | 5% |
| DECRQSS | 2 | 3% |
| DECRQM | 2 | 3% |
| OSC 색 질의 | 6 | 8% |

### 해석 (판단 아닌 사실)
- **DECRQCRA 없이는 esctest 축의 59%(primary 기준) / 병용 기준 47파일이 검증 불가**. 결정
  문서 §5-3의 "DECRQCRA 어댑터 브리지"가 esctest 가치의 대부분을 좌우한다.
- **CPR·WINOPS 크기 질의는 각각 43·42파일이 의존**. CPR은 xterm.js가 자체 방출하지만,
  **WINOPS 크기 리포트는 xterm.js가 침묵**한다(§SPIKE-SC 실측) — 42파일이 reset 단계에서
  WINOPS 브리지 없이는 막힌다. 이는 결정 문서 §5-3이 포착하지 못한 의존이다.
- **무질의 5파일**(decera·decfra·decrc·decset_tite_inhibit·scorc)은 화면을 되읽지 않는 순수
  side-effect 테스트 — esctest 축으로는 검증력이 없다(이 축은 5-1 골든/5-2 차등이 담당).
- **픽셀/윈도우 크기 질의**(`CSI 14 t` 등)는 headless에 개념이 없어 응답 불가 — 픽셀 축은
  esctest로 검증 불가(정직한 한계, xterm_winops.py 일부 케이스가 여기 해당).

## 파일별 의존 표 (79파일 전수)

`숫자` = 스캐너가 센 심볼 출현 횟수(의존 강도 참고치).

### primary = DECRQCRA — 47파일 (그리드 체크섬 왕복)
apc(3) · bs(DECRQCRA3,CPR17,WINOPS6) · cha(D2,CPR8,W2) · cr(D2,CPR5) · cup(D2,CPR11,W2) · dch(7) ·
dcs(2) · decaln(D6,CPR6,W2) · decbi(D3,CPR4) · deccra(D10,CPR2,W3) · decdc(D9,CPR5,W2) ·
decfi(D3,CPR4,W3) · decic(D10,CPR5,W3) · decrectops(D7,CPR2,W3) · decscl(D5,CPR5,W3,DECRQM7) ·
decsed(19) · decsel(12) · decsera(2) · decset(D26,CPR34,W18) · decstbm(D14,CPR8,W6) ·
decstr(D7,CPR8,W2) · dl(D11,W5) · ech(7) · ed(11) · el(8) · ff(D10,CPR12,W5) · hpr(D2,CPR4,W2) ·
hvp(D2,CPR11,W2) · ich(D9,CPR5,W3) · il(D8,W2) · ind(D10,CPR12,W5) · lf(D10,CPR12,W5) ·
nel(D10,CPR13,W5) · pm(3) · rep(D5,W2) · ri(D10,CPR12,W2) · ris(D5,CPR7,W9) · rm(2) ·
s8c1t(D2,CPR2,DECRQSS1) · save_restore_cursor(D5,CPR10,W2) · sd(D10,W2) · **sgr(3) ⚠️깨진 import** ·
sm(D6,CPR3,W2) · sos(3) · su(D10,W2) · vpr(D2,CPR4,W2) · vt(D10,CPR12,W5)

> ⚠️ **sgr.py는 esctest2 자체 결함**: `from escutil import AssertCharHasSGR`를 하지만
> `AssertCharHasSGR`는 escutil(및 전 소스)에 정의가 없다 → 실행 시 ImportError. vendor 핀
> 기준 이 파일은 실행 불가(우리 결함 아님, esctest2 실태).

### primary = CPR — 14파일 (커서 위치, DECRQCRA 미사용)
cbt(5) · cht(6) · cnl(CPR6,W3) · cpl(CPR6,W3) · cub(CPR10,W3) · cud(CPR6,W3) · cuf(CPR7,W4) ·
cuu(6) · decdsr(CPR2,DA2,DSR_OTHER14) · hpa(CPR7,W2) · hts(3) · tbc(8) · vpa(CPR7,W2) ·
xterm_save(CPR3,W3)

### primary = WINOPS — 3파일
decrqss(W1,DECRQSS14) · sm_title(18) · xterm_winops(170)

### primary = DA / DA2 — 3파일
da(2) · decid(DA4) · da2(2)

### primary = DECRQM — 1파일
decrqm(104)

### primary = OSC 색 질의 — 6파일
change_color(5) · change_dynamic_color(5) · change_special_color(13) ·
manipulate_selection_data(1) · reset_color(6) · reset_special_color(24)

### primary = 무질의 (화면 되읽기 없음) — 5파일
decera · decfra · decrc · decset_tite_inhibit · scorc

## M3 확장 시 우선 파일 목록 (질의 매핑 기반 — 데이터, 판단 아님)

E0/M3 확장(코어 피검체 esctest 통과)의 커버리지-대-비용 관점 정렬:

1. **CPR-only 14파일** — 브리지 불요(xterm.js·코어 모두 CPR 자체 방출), 즉시 검증 가능한
   최저비용군: cub·cuu·cud·cuf·cbt·cht·cnl·cpl·hpa·vpa·hts·tbc·cha·cup(+WINOPS 크기 브리지만).
2. **DECRQCRA 순수군**(CPR 병용 적음, rect 검증 집중) — 브리지 왕복 대량 실증 완료:
   deccra(456회)·decfra(264)·ed(126)·ich(120)·el(56)·dch(28)·decsed·decsel·decic·decdc.
3. **DECRQM·DA·DA2** — xterm.js 자체 방출 확인됨(SPIKE-SC 실측), 브리지 불요: decrqm·da·da2.
4. **제외/저가치**: 무질의 5파일(검증력 없음), sgr(깨진 import), 픽셀 축(headless 불가),
   OSC 색 6파일(esctest README 명시 "색은 테스트 불가" — 5-2 차등이 상보).
