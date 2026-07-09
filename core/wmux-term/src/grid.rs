//! 코어 로직 — 바인딩 레이어(napi/wasm)가 공유하는 유일한 공용 모듈.
//!
//! S-A1 스파이크 범위: vte raw `Perform` 8콜백 + 미니 그리드(문자 셀 + 커서).
//! `print`는 셀 기록 + 커서 전진, `execute`는 CR/LF만 처리.
//! SGR·스크롤·reflow·유니코드 폭은 **구현하지 않는다**(E1 몫). 이건 배관 실증이다.
//!
//! `no_std` 미사용(스켈레톤은 std 허용 — wasm/napi 양측 std 타깃).

use vte::{Params, Parser, Perform};

/// feed() 반환 표면 — §6 계약의 최소 부분집합.
/// writeback은 스켈레톤에선 항상 0(표면만 예약 — E1의 Interactive 모드에서 실채움).
pub struct FeedResult {
    /// 이번 feed로 변경된(dirty) 행 수.
    pub dirty_rows: u32,
    /// PTY 되쓰기 바이트 길이 — 스켈레톤 상수 0.
    pub writeback_len: u32,
}

/// 미니 그리드 + vte 파서 상태.
///
/// 셀은 `char` 1개(스켈레톤 — grapheme 클러스터·폭2 스페이서 없음).
/// 파서(`Parser`)를 그리드에 소유시켜 `feed`가 재진입 없이 왕복하도록 한다.
pub struct Grid {
    cols: u32,
    rows: u32,
    /// 행 우선(row-major) 셀 저장 — cols*rows 길이.
    cells: Vec<char>,
    /// 커서 위치(0-기반).
    cursor_x: u32,
    cursor_y: u32,
    /// 이번 feed에서 터치된 행 표시(dirty 집계용).
    dirty: Vec<bool>,
    parser: Parser,
}

impl Grid {
    /// 신규 그리드 — cols×rows 공백 셀 + 커서 (0,0).
    pub fn new(cols: u32, rows: u32) -> Self {
        // 0 방어: 최소 1×1 (파서 왕복이 패닉하지 않도록).
        let cols = cols.max(1);
        let rows = rows.max(1);
        let len = (cols as usize) * (rows as usize);
        Grid {
            cols,
            rows,
            cells: vec![' '; len],
            cursor_x: 0,
            cursor_y: 0,
            dirty: vec![false; rows as usize],
            parser: Parser::new(),
        }
    }

    /// 바이트 스트림을 파서에 흘려보내고 dirty 집계를 반환.
    ///
    /// 소유 파서를 잠시 꺼내(std::mem::take) `advance`에 `self`(Perform)를 넘긴다 —
    /// vte 0.15 `advance(&mut self, perform, bytes)` 시그니처의 대여 충돌 회피.
    pub fn feed(&mut self, bytes: &[u8]) -> FeedResult {
        for d in self.dirty.iter_mut() {
            *d = false;
        }
        // 파서를 소유권에서 분리 → self를 Perform으로 대여 → 복귀.
        let mut parser = std::mem::take(&mut self.parser);
        parser.advance(self, bytes);
        self.parser = parser;

        let dirty_rows = self.dirty.iter().filter(|&&d| d).count() as u32;
        FeedResult {
            dirty_rows,
            writeback_len: 0, // 스켈레톤 — 표면만 예약.
        }
    }

    /// 지정 행의 문자열 스냅샷(trailing 공백 유지 — cols 폭 고정).
    pub fn snapshot_row(&self, y: u32) -> String {
        if y >= self.rows {
            return String::new();
        }
        let start = (y as usize) * (self.cols as usize);
        let end = start + (self.cols as usize);
        self.cells[start..end].iter().collect()
    }

    /// 전체 초기화 — 셀 공백, 커서 원점, 파서 리셋.
    pub fn reset(&mut self) {
        for c in self.cells.iter_mut() {
            *c = ' ';
        }
        self.cursor_x = 0;
        self.cursor_y = 0;
        for d in self.dirty.iter_mut() {
            *d = false;
        }
        self.parser = Parser::new();
    }

    pub fn cols(&self) -> u32 {
        self.cols
    }

    pub fn rows(&self) -> u32 {
        self.rows
    }

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
/// 스켈레톤에선 `print`/`execute`만 그리드에 반영, 나머지 6개는 no-op 표면 유지.
impl Perform for Grid {
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
}
