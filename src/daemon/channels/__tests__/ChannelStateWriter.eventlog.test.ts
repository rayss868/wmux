// ─── ChannelStateWriter × 이벤트로그 모드 (PR3) ───────────────────────
// §6.4c 워터마크 스탬프가 **write 시점**에 적용됨(해시-내용 일치)과
// §6.4b shutdown flush의 durable 승격, 그리고 레거시 모드 불변을 고정한다.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ChannelStateWriter } from '../ChannelStateWriter';
import {
  stampWatermark,
  evaluateWatermark,
} from '../../eventlog/migrateToEventLog';
import { EMPTY_CHANNEL_STATE, type ChannelState } from '../../../shared/channels';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-writer-eventlog-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function freshState(): ChannelState {
  return { ...EMPTY_CHANNEL_STATE, channels: [], members: {}, messages: {}, idempotency: {} };
}

describe('ChannelStateWriter 이벤트로그 모드', () => {
  it('스탬프는 write 시점 적용 — 스케줄 후 상태가 변해도 해시가 기록 내용과 일치(§6.4c)', () => {
    const writer = new ChannelStateWriter(dir);
    let lamport = 7;
    writer.enableEventLogDualWrite({
      stamp: (s) => stampWatermark(s, lamport),
      durableFlush: true,
    });
    const state = freshState();
    writer.saveDebounced(state); // 스케줄(30s 디바운스 — 아직 미기록)
    // 스케줄 후 write 전에 상태·lamport 전진(라이브 참조 캡처의 핵심 창).
    state.channels.push({
      id: 'c1', companyId: 'co', name: 'late', visibility: 'public',
      status: 'active', createdAt: 1, createdBy: 'ws-1', nextSeq: 1,
    });
    state.members['c1'] = [];
    state.messages['c1'] = [];
    state.idempotency['c1'] = {};
    lamport = 9;
    writer.flushSync(); // §6.4b 경로 — write 시점에 스탬프

    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'channels.json'), 'utf8'));
    // 기록 내용에 late 채널 포함 + 워터마크가 write 시점 값(lamport 9, 해시 일치).
    expect(raw.channels).toHaveLength(1);
    expect(raw.eventLogWatermark.lamport).toBe(9);
    expect(evaluateWatermark(raw).kind).toBe('unchanged');
  });

  it('shutdown flush(§6.4b): durableFlush 활성 시 fsync 경유', () => {
    const writer = new ChannelStateWriter(dir);
    writer.enableEventLogDualWrite({
      stamp: (s) => stampWatermark(s, 1),
      durableFlush: true,
    });
    writer.saveDebounced(freshState());
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    writer.flushSync();
    expect(fsyncSpy).toHaveBeenCalled(); // §2.3 durable 시퀀스
  });

  it('레거시 모드(미설정): 스탬프 없음 + flush 비내구 — 기존 동작 불변', () => {
    const writer = new ChannelStateWriter(dir);
    writer.saveDebounced(freshState());
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    writer.flushSync();
    expect(fsyncSpy).not.toHaveBeenCalled();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'channels.json'), 'utf8'));
    expect(raw.eventLogWatermark).toBeUndefined();
  });

  it('saveImmediate({durable:true}): 마이그레이션/reseed 되쓰기 경로의 durable 승격', () => {
    const writer = new ChannelStateWriter(dir);
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    expect(writer.saveImmediate(freshState(), { durable: true })).toBe(true);
    expect(fsyncSpy).toHaveBeenCalled();
    fsyncSpy.mockClear();
    // 무옵션 기존 호출부는 비내구 그대로.
    expect(writer.saveImmediate(freshState())).toBe(true);
    expect(fsyncSpy).not.toHaveBeenCalled();
  });
});
