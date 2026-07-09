import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FrameCoalescer } from '../frameCoalescer';

// node 환경에는 requestAnimationFrame이 없어 코얼레서는 setTimeout(16ms)
// 폴백으로 프레임을 스케줄한다. fake timer로 프레임 경계를 결정적으로 제어한다.
describe('FrameCoalescer — 프레임당 1회 병합(마지막 값 승리)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('같은 key의 N회 연속 push를 프레임당 commit 1회로 병합한다', () => {
    const commit = vi.fn<(k: string, v: number) => void>();
    const fc = new FrameCoalescer<string, number>(commit);

    for (let i = 1; i <= 10; i++) fc.push('pty-1', i);
    // 아직 프레임 미도래 — commit 0회.
    expect(commit).toHaveBeenCalledTimes(0);
    expect(fc.pendingSize).toBe(1);

    vi.advanceTimersByTime(16);
    // 프레임 1회 → commit 1회, 마지막 값(10)만 반영.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('pty-1', 10);
  });

  it('서로 다른 key는 같은 프레임에서 각각 1회씩 commit된다', () => {
    const commit = vi.fn<(k: string, v: number) => void>();
    const fc = new FrameCoalescer<string, number>(commit);

    fc.push('a', 1);
    fc.push('b', 2);
    fc.push('a', 3); // a 갱신 — 마지막 값 3 승리
    vi.advanceTimersByTime(16);

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith('a', 3);
    expect(commit).toHaveBeenCalledWith('b', 2);
  });

  it('다음 프레임의 push는 새 commit을 만든다(프레임 간 병합 없음)', () => {
    const commit = vi.fn<(k: string, v: number) => void>();
    const fc = new FrameCoalescer<string, number>(commit);

    fc.push('x', 1);
    vi.advanceTimersByTime(16);
    fc.push('x', 2);
    vi.advanceTimersByTime(16);

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenNthCalledWith(1, 'x', 1);
    expect(commit).toHaveBeenNthCalledWith(2, 'x', 2);
  });

  it('flush(commit) 도중 들어온 값은 유실 없이 다음 프레임에 반영된다', () => {
    const commit = vi.fn<(k: string, v: number) => void>();
    const fc = new FrameCoalescer<string, number>(commit);
    // 첫 commit이 실행되는 순간 재-push해서 in-flight 게이트를 자극한다.
    commit.mockImplementationOnce(() => {
      fc.push('re', 99);
    });

    fc.push('re', 1);
    vi.advanceTimersByTime(16); // 1 commit → 내부에서 99 재적재
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenNthCalledWith(1, 're', 1);

    vi.advanceTimersByTime(16); // 다음 프레임에 99 반영
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenNthCalledWith(2, 're', 99);
  });

  it('flushNow()는 예약 프레임을 취소하고 pending을 즉시 동기 반영한다', () => {
    const commit = vi.fn<(k: string, v: number) => void>();
    const fc = new FrameCoalescer<string, number>(commit);

    fc.push('k', 7);
    fc.flushNow();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('k', 7);

    // 타이머를 돌려도 중복 commit이 없어야 한다(프레임이 취소됐으므로).
    vi.advanceTimersByTime(32);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('dispose()는 pending을 폐기하고 반영하지 않는다', () => {
    const commit = vi.fn<(k: string, v: number) => void>();
    const fc = new FrameCoalescer<string, number>(commit);

    fc.push('k', 1);
    fc.dispose();
    vi.advanceTimersByTime(32);
    expect(commit).toHaveBeenCalledTimes(0);
    expect(fc.pendingSize).toBe(0);
  });
});
