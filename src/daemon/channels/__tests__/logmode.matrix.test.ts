// ─── 로그 모드 매트릭스 (PR3 과제 2) ───────────────────────────────────
// 기존 채널 스위트(ChannelService/channelCursor/rosterIdentity — ChannelService를
// 생성하는 전체)를 **이벤트로그 모드로 한 번 더** 실행한다. 기존 테스트 파일은
// 무변경 — vi.mock이 ChannelService 생성자를 감싸 eventLog deps를 주입한다.
//
// 하니스 설계(최소 침습 절충의 근거):
//  - 기존 파일들의 로컬 fake writer(saveImmediate/load/failNext)는 레거시 커밋
//    seam을 검증한다. 로그 모드에서 그 seam의 등가물은 fsync 배리어이므로,
//    배리어마다 fake의 saveImmediate를 **프로브**로 1회 호출해 브리지한다:
//      · failNext 소비 → 배리어 throw → append false → PERSIST_FAILED (동일 계약)
//      · 커밋당 saveImmediate 1회 → 호출 횟수 어서션 1:1 보존
//      · 라이브 state 참조 전달 → saved[] 내용 어서션은 테스트가 읽는 시점
//        (mutation await 후 = 적용 후)의 상태를 본다 — 레거시와 동일 관측
//  - writer 인스턴스당 events 디렉토리 1개(WeakMap): 같은 writer로 재생성하는
//    재시작 테스트가 같은 로그를 replay해 레거시 load() 하이드레이션과 등가.
//    genesis = 최초 생성 시점의 writer.load() (사전 시드 상태 포함).
//  - 빈채널 reaper TTL은 초대형으로 중립화: fake writer의 load()는 리퍼를 안
//    돌리므로(실제 ChannelStateWriter.load()만 돌림) 로그 모드 부트 리퍼가
//    돌면 하니스 아티팩트 차이가 생긴다. 리퍼 시멘틱은 ChannelStateWriter
//    전용 테스트가 커버한다.

import { vi, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tempDirs: string[] = [];

vi.mock('../ChannelService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ChannelService')>();
  const { AppendOnlyLog } = await import('../../eventlog/AppendOnlyLog');
  const { SnapshotStore, SNAPSHOT_DIRNAME, GENESIS_CHANNEL_REF } = await import(
    '../../eventlog/SnapshotStore'
  );
  const { ChannelStateWriter } = await import('../ChannelStateWriter');

  // writer 인스턴스 → events 디렉토리 (재시작 테스트가 같은 로그를 보게).
  const dirByWriter = new WeakMap<object, string>();

  type Deps = ConstructorParameters<typeof actual.ChannelService>[0];

  class LogModeChannelService extends actual.ChannelService {
    constructor(deps: Deps) {
      // 이미 로그 모드로 생성하는 테스트(eventlog 통합 등)는 그대로 통과.
      if (deps.eventLog) {
        super(deps);
        return;
      }
      const writer = deps.writer as unknown as {
        load: () => unknown;
        saveImmediate: (s: unknown) => boolean;
        saveDebounced?: (s: unknown) => void;
      };
      // fake writer들엔 saveDebounced가 없다(레거시 seam엔 불필요했음) — noop 패치.
      if (typeof writer.saveDebounced !== 'function') {
        writer.saveDebounced = () => {};
      }
      let eventsDir = dirByWriter.get(writer as object);
      if (!eventsDir) {
        eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-logmode-matrix-'));
        tempDirs.push(eventsDir);
        dirByWriter.set(writer as object, eventsDir);
        // genesis = 이 writer의 현재 상태(사전 시드 포함) — 레거시 생성자의
        // writer.load() 시드와 등가 좌표(lamport 0).
        new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME)).writeDurableSync(
          GENESIS_CHANNEL_REF,
          writer.load(),
          0,
          (d) => ChannelStateWriter.isChannelState(d),
        );
      }
      // fsync 배리어 ↔ fake saveImmediate 프로브 브리지(파일 헤더 근거).
      const box: { svc: unknown } = { svc: null };
      const log = new AppendOnlyLog({
        dir: eventsDir,
        fsync: () => {
          const svc = box.svc as { state: unknown } | null;
          if (!svc) return; // 생성 중엔 append가 없다
          if (!writer.saveImmediate(svc.state)) {
            throw new Error('logmode-matrix: bridged persist failure');
          }
        },
      });
      log.open();
      const snapshots = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME), {
        // 디바운스 스냅샷이 테스트 도중/후에 실제로 쓰이지 않게 사실상 무한대.
        debounceMs: 2_000_000_000,
      });
      super({
        ...deps,
        eventLog: {
          log,
          snapshots,
          genesisRef: GENESIS_CHANNEL_REF,
          reseedRefs: [],
          machineId: 'logmode-matrix',
          // 리퍼 중립화(파일 헤더 근거).
          emptyChannelTtlHours: 24 * 365 * 100,
        },
      });
      box.svc = this;
      // load() 미러링: 레거시에선 매 커밋이 saveImmediate였으므로
      // load() == 마지막 커밋 상태 == (await 후) 라이브 상태였다. 프로브는
      // G1상 적용 **전** 상태를 넘기므로, 깊은복사로 저장하는 fake(channelCursor)의
      // load()가 한 mutation 뒤처진다 — 라이브 커밋 상태를 돌려주도록 미러링해
      // 레거시 관측과 등가로 복원한다(서비스는 로그 모드에서 load()를 안 쓴다).
      const origLoad = writer.load.bind(writer);
      writer.load = () =>
        box.svc
          ? structuredClone((box.svc as { state: unknown }).state)
          : origLoad();
    }
  }

  return { ...actual, ChannelService: LogModeChannelService };
});

afterAll(() => {
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// 대상: ChannelService를 생성하는 기존 스위트 전체(파일 무변경 재실행).
import './ChannelService.test';
import './channelCursor.test';
import './ChannelService.rosterIdentity.test';
