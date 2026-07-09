//! napi-build 셋업 — 네이티브(.node) 타깃에서만 실행.
//!
//! 주의(리뷰 반영): build.rs 안의 `#[cfg(target_arch)]`는 **빌드 호스트** 기준이라
//! 크로스 타깃(wasm32) 판정에 쓸 수 없다 — cargo가 넘겨주는 타깃 env로 판정한다.

fn main() {
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if target_arch != "wasm32" {
        napi_build::setup();
    }
}
