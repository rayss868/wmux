import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  SnapshotStore,
  GENESIS_CHANNEL_REF,
  CHANNEL_PROJECTION_REF,
  reseedRef,
  isSnapshotEnvelope,
} from '../SnapshotStore';
import type { ChannelState } from '../../../shared/channels';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-snap-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 헬퍼 ──────────────────────────────────────────────────────────────

function isChannelStateLike(d: unknown): boolean {
  if (typeof d !== 'object' || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o['version'] === 'number' &&
    Array.isArray(o['channels']) &&
    typeof o['members'] === 'object' &&
    o['members'] !== null
  );
}

/** 마커로 구분되는 최소 ChannelState-유사 projection. */
function proj(marker: string): ChannelState {
  return {
    version: 1,
    channels: [
      {
        id: `ch-${marker}`,
        companyId: 'co',
        name: marker,
        visibility: 'public',
        status: 'active',
        createdAt: 0,
        createdBy: 'ws',
        nextSeq: 1,
      },
    ],
    members: {},
    messages: {},
    idempotency: {},
  };
}

// ── T-스냅샷 손상 폴백(§5): 최신 → .bak → reseed → genesis ────────────────

describe('T-스냅샷 손상 폴백', () => {
  it('최신 → .bak → reseed → genesis 순으로 강등', () => {
    const store = new SnapshotStore(dir);
    store.writeDurableSync(GENESIS_CHANNEL_REF, proj('genesis'), 0);
    store.writeDurableSync(reseedRef(1), proj('reseed'), 5);
    store.writeDurableSync(CHANNEL_PROJECTION_REF, proj('active-old'), 9);
    store.writeDurableSync(CHANNEL_PROJECTION_REF, proj('active-new'), 10); // .bak=active-old

    const opts = {
      activeRef: CHANNEL_PROJECTION_REF,
      genesisRef: GENESIS_CHANNEL_REF,
      reseedRefs: [reseedRef(1)],
      validateProjection: isChannelStateLike,
    };

    // 1. 정상 → 최신 active-new.
    let fb = store.loadWithFallback<ChannelState>(opts);
    expect(fb!.source).toBe('snapshot');
    expect(fb!.snapshotLamport).toBe(10);
    expect(fb!.projection.channels[0].id).toBe('ch-active-new');

    // 2. primary 손상 → .bak(active-old).
    fs.writeFileSync(store.snapshotPath(CHANNEL_PROJECTION_REF), 'CORRUPT{');
    fb = store.loadWithFallback<ChannelState>(opts);
    expect(fb!.source).toBe('snapshot');
    expect(fb!.snapshotLamport).toBe(9);
    expect(fb!.projection.channels[0].id).toBe('ch-active-old');

    // 3. .bak도 손상 → reseed.
    fs.writeFileSync(
      `${store.snapshotPath(CHANNEL_PROJECTION_REF)}.bak`,
      'CORRUPT{',
    );
    fb = store.loadWithFallback<ChannelState>(opts);
    expect(fb!.source).toBe('reseed');
    expect(fb!.snapshotLamport).toBe(5);
    expect(fb!.projection.channels[0].id).toBe('ch-reseed');

    // 4. reseed 손상 → genesis(바닥).
    fs.writeFileSync(store.snapshotPath(reseedRef(1)), 'CORRUPT{');
    fs.rmSync(`${store.snapshotPath(reseedRef(1))}.bak`, { force: true });
    fb = store.loadWithFallback<ChannelState>(opts);
    expect(fb!.source).toBe('genesis');
    expect(fb!.snapshotLamport).toBe(0);
    expect(fb!.projection.channels[0].id).toBe('ch-genesis');
  });

  it('reseed 다수 → 최신(높은 번호)부터 시도', () => {
    const store = new SnapshotStore(dir);
    store.writeDurableSync(GENESIS_CHANNEL_REF, proj('genesis'), 0);
    store.writeDurableSync(reseedRef(1), proj('reseed-1'), 3);
    store.writeDurableSync(reseedRef(2), proj('reseed-2'), 7);

    const fb = store.loadWithFallback<ChannelState>({
      activeRef: CHANNEL_PROJECTION_REF, // 부재
      genesisRef: GENESIS_CHANNEL_REF,
      reseedRefs: [reseedRef(1), reseedRef(2)],
      validateProjection: isChannelStateLike,
    });
    expect(fb!.source).toBe('reseed');
    expect(fb!.projection.channels[0].id).toBe('ch-reseed-2'); // 최신
    expect(fb!.snapshotLamport).toBe(7);
  });

  it('genesis마저 손상 → null(파국은 상위가 처리)', () => {
    const store = new SnapshotStore(dir);
    store.writeDurableSync(GENESIS_CHANNEL_REF, proj('genesis'), 0);
    fs.writeFileSync(store.snapshotPath(GENESIS_CHANNEL_REF), 'CORRUPT{');
    fs.rmSync(`${store.snapshotPath(GENESIS_CHANNEL_REF)}.bak`, { force: true });
    const fb = store.loadWithFallback<ChannelState>({
      activeRef: CHANNEL_PROJECTION_REF,
      genesisRef: GENESIS_CHANNEL_REF,
      reseedRefs: [],
      validateProjection: isChannelStateLike,
    });
    expect(fb).toBeNull();
  });
});

// ── durable write/load + debounce ──────────────────────────────────────

describe('durable 스냅샷 write/load', () => {
  it('writeDurableSync → load 왕복(snapshotLamport 보존)', () => {
    const store = new SnapshotStore(dir);
    store.writeDurableSync(CHANNEL_PROJECTION_REF, proj('x'), 42, isChannelStateLike);
    const env = store.load<ChannelState>(CHANNEL_PROJECTION_REF, isChannelStateLike);
    expect(env!.snapshotLamport).toBe(42);
    expect(env!.projection.channels[0].id).toBe('ch-x');
    expect(isSnapshotEnvelope(env)).toBe(true);
  });

  it('projection 검증 실패 스냅샷은 load에서 null(폴백 유도)', () => {
    const store = new SnapshotStore(dir);
    // 봉투는 유효하나 projection이 ChannelState-유사가 아님.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      store.snapshotPath(CHANNEL_PROJECTION_REF),
      JSON.stringify({ version: 1, snapshotLamport: 1, projection: { bogus: true } }),
    );
    expect(
      store.load(CHANNEL_PROJECTION_REF, isChannelStateLike),
    ).toBeNull();
  });

  it('saveDebounced → flushSync가 pending을 durable 동기 쓰기로 소진', () => {
    const store = new SnapshotStore(dir, { debounceMs: 1_000_000 });
    store.saveDebounced(CHANNEL_PROJECTION_REF, proj('deb'), 7);
    store.flushSync();
    const env = store.load<ChannelState>(CHANNEL_PROJECTION_REF, isChannelStateLike);
    expect(env!.snapshotLamport).toBe(7);
    expect(env!.projection.channels[0].id).toBe('ch-deb');
    store.dispose();
  });
});

// ── T-컴팩션 순서(§9 가드) ──────────────────────────────────────────────

describe('T-컴팩션 순서', () => {
  const G = 'genesis-channel.json';

  it('durable 미확정 → 절단 후보 0(§9 함정)', () => {
    const plan = SnapshotStore.planCompaction({
      segments: [{ num: 1, maxLamport: 5, empty: false }],
      snapshotLamport: 10,
      durableSnapshotConfirmed: false,
      activeSegment: 2,
      genesisRef: G,
      reseedRefs: [reseedRef(1)],
    });
    expect(plan.truncatableSegments).toEqual([]);
    // genesis·reseed는 항상 보호 목록에(절대 비절단, D14).
    expect(plan.protectedSnapshots).toEqual([G, reseedRef(1)]);
  });

  it('durable 확정 → snapshotLamport 미만 세그먼트 절단(감사용 최근 1개 보존)', () => {
    const plan = SnapshotStore.planCompaction({
      segments: [
        { num: 1, maxLamport: 5, empty: false }, // < 20 후보
        { num: 2, maxLamport: 15, empty: false }, // < 20 후보(최근 → 감사 보존)
        { num: 3, maxLamport: 25, empty: false }, // > 20 → 후보 아님
        { num: 4, maxLamport: 0, empty: true }, // 활성(빈)
      ],
      snapshotLamport: 20,
      durableSnapshotConfirmed: true,
      activeSegment: 4,
      genesisRef: G,
      reseedRefs: [],
    });
    // 후보 {1,2} 중 최고번호(2)는 감사 보존 → 절단 = [1].
    expect(plan.truncatableSegments).toEqual([1]);
    expect(plan.protectedSnapshots).toEqual([G]);
  });

  it('활성 세그먼트는 snapshotLamport 이하라도 절단 후보 아님', () => {
    const plan = SnapshotStore.planCompaction({
      segments: [{ num: 1, maxLamport: 5, empty: false }],
      snapshotLamport: 10,
      durableSnapshotConfirmed: true,
      activeSegment: 1,
      genesisRef: G,
      reseedRefs: [],
    });
    expect(plan.truncatableSegments).toEqual([]);
  });

  it('후보 1개뿐 → 감사 보존으로 절단 0', () => {
    const plan = SnapshotStore.planCompaction({
      segments: [
        { num: 1, maxLamport: 5, empty: false },
        { num: 2, maxLamport: 0, empty: true },
      ],
      snapshotLamport: 10,
      durableSnapshotConfirmed: true,
      activeSegment: 2,
      genesisRef: G,
      reseedRefs: [reseedRef(1), reseedRef(2)],
    });
    expect(plan.truncatableSegments).toEqual([]);
    expect(plan.protectedSnapshots).toEqual([G, reseedRef(1), reseedRef(2)]);
  });
});
