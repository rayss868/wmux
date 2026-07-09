//! wasm-bindgen 바인딩 레이어 — wasm32 타깃 전용(렌더러 워커용).
//!
//! cfg(target_arch = "wasm32")에서만 컴파일. 코어 로직(`Grid`)을 JS 클래스로
//! 감싸는 얇은 어댑터. napi 레이어와 동일 표면(§6 계약 최소 부분집합).

use crate::grid::Grid;
use wasm_bindgen::prelude::*;

/// feed() 반환 — JS로 노출되는 dirty 집계.
#[wasm_bindgen]
pub struct FeedResult {
    dirty_rows: u32,
    writeback_len: u32,
}

#[wasm_bindgen]
impl FeedResult {
    #[wasm_bindgen(getter)]
    pub fn dirty_rows(&self) -> u32 {
        self.dirty_rows
    }

    #[wasm_bindgen(getter)]
    pub fn writeback_len(&self) -> u32 {
        self.writeback_len
    }
}

/// 터미널 그리드 — JS `new WmuxTerm(cols, rows)`.
#[wasm_bindgen]
pub struct WmuxTerm {
    inner: Grid,
}

#[wasm_bindgen]
impl WmuxTerm {
    #[wasm_bindgen(constructor)]
    pub fn new(cols: u32, rows: u32) -> WmuxTerm {
        WmuxTerm {
            inner: Grid::new(cols, rows),
        }
    }

    /// 바이트 slice를 feed(JS `Uint8Array` → `&[u8]`).
    pub fn feed(&mut self, bytes: &[u8]) -> FeedResult {
        let r = self.inner.feed(bytes);
        FeedResult {
            dirty_rows: r.dirty_rows,
            writeback_len: r.writeback_len,
        }
    }

    pub fn snapshot_row(&self, y: u32) -> String {
        self.inner.snapshot_row(y)
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }

    #[wasm_bindgen(getter)]
    pub fn cols(&self) -> u32 {
        self.inner.cols()
    }

    #[wasm_bindgen(getter)]
    pub fn rows(&self) -> u32 {
        self.inner.rows()
    }
}
