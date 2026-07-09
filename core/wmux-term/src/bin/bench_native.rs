//! V4a — vte 단독 네이티브 feed 처리량 마이크로벤치.
//!
//! 게이트 ≥250MB/s(예산 500의 50%). 대량 합성 ANSI 스트림 ≥64MB,
//! 워밍업 후 측정. 결과를 MB/s로 stdout 출력.
//!
//! 실행: cargo run --release --bin bench_native

use std::time::Instant;
use wmux_term::Grid;

/// 대표 워크로드 근사 합성 ANSI 스트림 생성.
///
/// 블록 구성: SGR 색 전환 + ASCII 텍스트 + **CSI 커서 이동(파라미터 파싱 경로)** +
/// **UTF-8 멀티바이트(한글 — 연속바이트 경로)** + CRLF.
/// **주의(정직 레이블 — 리뷰 반영)**: 이 수치는 best-case 상한이다 — OSC/DCS·
/// 청크 경계 분할 이스케이프·이모지 ZWJ 최악 경로는 미포함(E1 셀 속성 구현 후 재계측).
fn synth_stream(target_bytes: usize) -> Vec<u8> {
    let mut buf = Vec::with_capacity(target_bytes + 512);
    let block: &[u8] =
        "\x1b[31mERROR\x1b[0m build failed at \x1b[1msrc/main.rs:42\x1b[0m: \
          expected `;` \x1b[2mnote: consider adding\x1b[0m\r\n\
          \x1b[32m  Compiling\x1b[0m wmux-term v0.0.0 (units 1/1)\r\n\
          \x1b[10;5H\x1b[2K빌드 진행 중… 한글 로그 라인 \x1b[0;36m확인\x1b[0m\r\n"
            .as_bytes();
    while buf.len() < target_bytes {
        buf.extend_from_slice(block);
    }
    buf.truncate(target_bytes);
    buf
}

fn main() {
    let total_bytes: usize = 64 * 1024 * 1024; // 64MB
    let stream = synth_stream(total_bytes);
    let chunk = 16 * 1024; // 16KB 청크로 feed(PTY read 근사).

    // 워밍업 — 3MB 흘려 캐시·분기예측 안정화.
    // (리뷰 반영: `.min`은 곱 전체에 걸어야 한다 — 연산자 우선순위 버그 수정.)
    {
        let mut g = Grid::new(80, 24);
        let warm_len = (3 * 1024 * 1024usize).min(stream.len());
        for c in stream[..warm_len].chunks(chunk) {
            std::hint::black_box(g.feed(c));
        }
    }

    // 측정 — 새 그리드로 전량 feed.
    let mut g = Grid::new(80, 24);
    let t0 = Instant::now();
    let mut acc_dirty: u64 = 0;
    for c in stream.chunks(chunk) {
        let r = g.feed(c);
        acc_dirty = acc_dirty.wrapping_add(r.dirty_rows as u64);
    }
    let elapsed = t0.elapsed();
    std::hint::black_box(acc_dirty);
    // 셀 쓰기 경로가 LTO로 제거되지 못하도록 최종 그리드 내용도 관측한다(리뷰 반영).
    let mut sink: u64 = 0;
    for y in 0..g.rows() {
        for ch in g.snapshot_row(y).chars() {
            sink = sink.wrapping_add(ch as u64);
        }
    }
    std::hint::black_box(sink);

    let mb = total_bytes as f64 / (1024.0 * 1024.0);
    let secs = elapsed.as_secs_f64();
    let mbps = mb / secs;

    println!("[V4a] vte 단독 네이티브 feed 처리량");
    println!("  bytes    = {} MB", mb as u64);
    println!("  elapsed  = {:.4} s", secs);
    println!("  throughput = {:.1} MB/s", mbps);
    println!("  gate     = 250 MB/s (예산 500의 50%)");
    if mbps >= 250.0 {
        println!("  RESULT   = PASS");
        std::process::exit(0);
    } else {
        println!("  RESULT   = BELOW GATE (설계 재검토 트리거 데이터)");
        std::process::exit(2); // 게이트 미달 — 정직 보고용 비영 코드.
    }
}
