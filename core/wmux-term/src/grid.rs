//! 코어 로직 — 바인딩 레이어(napi/wasm)가 공유하는 유일한 공용 모듈.
//!
//! S-A1 스파이크 범위: vte raw `Perform` 8콜백 + 미니 그리드(문자 셀 + 커서).
//! `print`는 셀 기록 + 커서 전진, `execute`는 CR/LF만 처리.
//! SGR·스크롤·reflow·유니코드 폭은 **구현하지 않는다**(E1 몫). 이건 배관 실증이다.
//!
//! `no_std` 미사용(스켈레톤은 std 허용 — wasm/napi 양측 std 타깃).
//!
//! 구조: `Grid = Parser + Screen` 필드 분리 — `feed`가 `self.parser.advance(&mut self.screen, ..)`로
//! 필드별 분리 대여를 쓰므로 파서를 소유권에서 꺼낼 필요가 없다(`std::mem::take` 불사용).
//! Perform 콜백이 언와인드해도 파서 상태가 default로 유실되는 경로 자체가 없다(리뷰 반영).

use vte::{Params, Parser, Perform};

/// 그리드 치수 상한 — cols·rows 각각 클램프. 4096²=16M 셀이라 `cols*rows` usize
/// 오버플로가 원천 차단된다(리뷰 반영 — checked_mul 대신 도메인 상한).
const MAX_DIM: u32 = 4096;

/// feed() 반환 표면 — §6 계약의 최소 부분집합.
/// writeback은 스켈레톤에선 항상 0(표면만 예약 — E1의 Interactive 모드에서 실채움).
pub struct FeedResult {
    /// 이번 feed로 변경된(dirty) 행 수.
    pub dirty_rows: u32,
    /// PTY 되쓰기 바이트 길이 — 스켈레톤 상수 0.
    pub writeback_len: u32,
}

/// 화면 상태(셀·커서·dirty) — `Perform` 구현체.
/// 파서와 분리된 필드라 `advance` 동안 파서와 동시 대여가 성립한다.
struct Screen {
    cols: u32,
    rows: u32,
    /// 행 우선(row-major) 셀 저장 — cols*rows 길이.
    cells: Vec<char>,
    /// 커서 위치(0-기반).
    cursor_x: u32,
    cursor_y: u32,
    /// 이번 feed에서 터치된 행 표시(dirty 집계용).
    dirty: Vec<bool>,
}

/// 미니 그리드 + vte 파서 상태. 공개 표면은 스파이크 계약(§6 최소 부분집합)만.
pub struct Grid {
    parser: Parser,
    screen: Screen,
}

impl Grid {
    /// 신규 그리드 — cols×rows 공백 셀 + 커서 (0,0).
    /// 치수는 [1, 4096]으로 클램프(0 방어 + 곱 오버플로 원천 차단).
    pub fn new(cols: u32, rows: u32) -> Self {
        let cols = cols.clamp(1, MAX_DIM);
        let rows = rows.clamp(1, MAX_DIM);
        let len = (cols as usize) * (rows as usize); // ≤ 16M — 오버플로 불가.
        Grid {
            parser: Parser::new(),
            screen: Screen {
                cols,
                rows,
                cells: vec![' '; len],
                cursor_x: 0,
                cursor_y: 0,
                dirty: vec![false; rows as usize],
            },
        }
    }

    /// 바이트 스트림을 파서에 흘려보내고 dirty 집계를 반환.
    /// 파서(self.parser)와 화면(self.screen)은 별개 필드라 분리 대여 — take/복귀 없음.
    pub fn feed(&mut self, bytes: &[u8]) -> FeedResult {
        for d in self.screen.dirty.iter_mut() {
            *d = false;
        }
        self.parser.advance(&mut self.screen, bytes);

        let dirty_rows = self.screen.dirty.iter().filter(|&&d| d).count() as u32;
        FeedResult {
            dirty_rows,
            writeback_len: 0, // 스켈레톤 — 표면만 예약.
        }
    }

    /// 지정 행의 문자열 스냅샷(trailing 공백 유지 — cols 폭 고정).
    pub fn snapshot_row(&self, y: u32) -> String {
        if y >= self.screen.rows {
            return String::new();
        }
        let start = (y as usize) * (self.screen.cols as usize);
        let end = start + (self.screen.cols as usize);
        self.screen.cells[start..end].iter().collect()
    }

    /// 전체 초기화 — 셀 공백, 커서 원점, 파서 리셋.
    pub fn reset(&mut self) {
        for c in self.screen.cells.iter_mut() {
            *c = ' ';
        }
        self.screen.cursor_x = 0;
        self.screen.cursor_y = 0;
        for d in self.screen.dirty.iter_mut() {
            *d = false;
        }
        self.parser = Parser::new();
    }

    pub fn cols(&self) -> u32 {
        self.screen.cols
    }

    pub fn rows(&self) -> u32 {
        self.screen.rows
    }
}

impl Screen {
    /// 커서 위치의 셀에 문자를 기록하고 커서를 전진.
    /// 줄 끝 도달 시 다음 행 0열로 랩(스켈레톤 — 자동 랩만, DECAWM 미구현).
    fn put_char(&mut self, c: char) {
        if self.cursor_y >= self.rows {
            return;
        }
        let idx = (self.cursor_y as usize) * (self.cols as usize) + (self.cursor_x as usize);
        if idx < self.cells.len() {
            self.cells[idx] = c;
            self.dirty[self.cursor_y as usize] = true;
        }
        // 커서 전진.
        self.cursor_x += 1;
        if self.cursor_x >= self.cols {
            self.cursor_x = 0;
            if self.cursor_y + 1 < self.rows {
                self.cursor_y += 1;
            }
            // 마지막 행이면 커서 y 고정(스크롤 미구현 — E1 몫).
        }
    }

    fn carriage_return(&mut self) {
        self.cursor_x = 0;
    }

    fn line_feed(&mut self) {
        if self.cursor_y + 1 < self.rows {
            self.cursor_y += 1;
        }
        // 스크롤 미구현 — 마지막 행에서 고정.
    }
}

/// vte raw `Perform` — 8콜백 전부 구현(ansi 피처 금지, 결정 문서 D1 파서 서브결정).
/// 스켈레톤에선 `print`/`execute`만 화면에 반영, 나머지 6개는 no-op 표면 유지.
impl Perform for Screen {
    fn print(&mut self, c: char) {
        self.put_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\r' => self.carriage_return(),
            b'\n' => self.line_feed(),
            _ => {} // 그 외 C0 제어문자 무시(스켈레톤).
        }
    }

    fn hook(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _action: char) {
        // DCS 진입 — 스켈레톤 no-op(표면 유지).
    }

    fn put(&mut self, _byte: u8) {
        // DCS 데이터 바이트 — no-op.
    }

    fn unhook(&mut self) {
        // DCS 종료 — no-op.
    }

    fn osc_dispatch(&mut self, _params: &[&[u8]], _bit_more: bool) {
        // OSC(7/8/52/133 등) — 스켈레톤 no-op. E1에서 1급 이벤트로 dispatch.
    }

    fn csi_dispatch(
        &mut self,
        _params: &Params,
        _intermediates: &[u8],
        _ignore: bool,
        _action: char,
    ) {
        // CSI(SGR·커서 이동·스크롤 영역 등) — no-op. E1 몫.
    }

    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {
        // ESC(charset·alt-screen 등) — no-op. E1 몫.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn print_advances_cursor_and_records_cell() {
        // 핵심 함수 테스트 1: print가 셀 기록 + 커서 전진하는가.
        let mut g = Grid::new(10, 3);
        let r = g.feed(b"hi");
        assert_eq!(g.snapshot_row(0), "hi        "); // 2글자 + 8공백(cols=10).
        assert_eq!(r.dirty_rows, 1);
        assert_eq!(r.writeback_len, 0); // 스켈레톤 상수.
    }

    #[test]
    fn crlf_moves_cursor_to_next_line() {
        // 핵심 함수 테스트 2: execute(CR/LF)가 커서를 다음 행 0열로 옮기는가.
        let mut g = Grid::new(10, 3);
        g.feed(b"ab\r\ncd");
        assert_eq!(g.snapshot_row(0), "ab        ");
        assert_eq!(g.snapshot_row(1), "cd        "); // CR로 0열 복귀 + LF로 행 이동.
    }

    #[test]
    fn reset_clears_grid() {
        let mut g = Grid::new(5, 2);
        g.feed(b"xyz");
        g.reset();
        assert_eq!(g.snapshot_row(0), "     "); // 전부 공백.
    }

    #[test]
    fn csi_is_swallowed_not_printed() {
        // SGR 시퀀스가 셀에 새지 않는지(csi_dispatch no-op이라도 파서가 삼킴).
        let mut g = Grid::new(20, 2);
        g.feed(b"\x1b[31mred\x1b[0m");
        assert_eq!(g.snapshot_row(0), "red                 "); // ANSI 코드 제외, 'red'만.
    }

    #[test]
    fn auto_wrap_at_line_end() {
        // 줄 끝 자동 랩(스켈레톤).
        let mut g = Grid::new(3, 2);
        g.feed(b"abcd");
        assert_eq!(g.snapshot_row(0), "abc");
        assert_eq!(g.snapshot_row(1), "d  ");
    }

    #[test]
    fn dimensions_clamped_to_max() {
        // 치수 상한 클램프 — 곱 오버플로 원천 차단(리뷰 반영).
        let g = Grid::new(u32::MAX, u32::MAX);
        assert_eq!(g.cols(), MAX_DIM);
        assert_eq!(g.rows(), MAX_DIM);
    }

    #[test]
    fn split_csi_across_feed_chunks_survives() {
        // 청크 경계에 걸친 CSI — 파서 상태가 feed 호출 사이에 보존되는가
        // (mem::take 제거 구조의 회귀 방지 — 리뷰 반영).
        let mut g = Grid::new(20, 2);
        g.feed(b"\x1b[3"); // CSI 파라미터 중간에서 절단.
        g.feed(b"1mred\x1b[0m");
        assert_eq!(g.snapshot_row(0), "red                 "); // 분할 시퀀스도 삼켜짐.
    }
}
