//! napi-build 셋업 — 네이티브(.node) 타깃에서만 실행.
//! wasm32에서는 napi-build 자체가 cfg로 의존에서 빠지므로 no-op.

fn main() {
    #[cfg(not(target_arch = "wasm32"))]
    napi_build::setup();
}
