import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishA2aTask } from '../publisher';
import { isVerifiedItem } from '../../../shared/completionEvidence';
import type { EvidenceItem, TaskState } from '../../../shared/types';

// publisher.publish()는 window.electronAPI.events.publish로 위임한다. node 테스트
// 환경엔 window가 없으므로 globalThis.window에 목을 심어 방출 페이로드를 포착한다
// (publisher는 typeof window 가드로 부재를 견딘다 — 목이 없으면 그냥 삼켜진다).
let published: Array<Record<string, unknown>>;

beforeEach(() => {
  published = [];
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      events: {
        publish: (input: Record<string, unknown>) => {
          published.push(input);
        },
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('publishA2aTask — verifiedItemCount 부착 (§6.M PR-C)', () => {
  it('완료 전이 + 검증 카운트 → 이벤트에 verifiedItemCount 실림', () => {
    publishA2aTask('ws-from', 'ws-to', 't1', 'completed', 'updated', undefined, 1);
    expect(published).toHaveLength(1);
    const e = published[0];
    expect(e.type).toBe('a2a.task');
    expect(e.workspaceId).toBe('ws-from'); // base scope === sender (fail-safe invariant)
    expect(e.verifiedItemCount).toBe(1);
  });

  it('unverified 완료(카운트 0) → 0은 부재와 구별되어 실림(!== undefined 가드)', () => {
    // 0 = "완료됐으나 검증 아이템 없음" — 부재(created/cancelled)와 구별되는
    // 등급 신호라 반드시 방출되어야 한다(truthiness가 아니라 !== undefined).
    publishA2aTask('ws-from', 'ws-to', 't1', 'completed', 'updated', undefined, 0);
    expect(published[0]).toHaveProperty('verifiedItemCount', 0);
  });

  it('evidence 없는 created/cancelled(카운트 undefined) → 필드 부재', () => {
    publishA2aTask('ws-from', 'ws-to', 't1', 'submitted', 'created', undefined, undefined);
    expect(published[0]).not.toHaveProperty('verifiedItemCount');
    published = [];
    publishA2aTask('ws-from', 'ws-to', 't1', 'canceled', 'cancelled', undefined, undefined);
    expect(published[0]).not.toHaveProperty('verifiedItemCount');
  });

  it('messagePreview와 verifiedItemCount 병존(서로 독립 부착)', () => {
    publishA2aTask('ws-from', 'ws-to', 't1', 'completed', 'updated', 'preview', 2);
    expect(published[0]).toMatchObject({ messagePreview: 'preview', verifiedItemCount: 2 });
  });
});

// emitA2aTaskEvent(useRpcBridge)의 파생식과 동형: task.status.evidence.items를
// isVerifiedItem으로 세어 카운트를 만든다. 관측 계약(evidence 등급 → 방출)을 방출자
// 경계에서 검증한다 — 2000줄 React 훅을 node 테스트에 끌어오지 않기 위해 파생식을
// 동일 isVerifiedItem·동일 publishA2aTask로 재현한다.
describe('evidence 등급 파생 → 방출 (관측 계약, §6.M PR-C)', () => {
  const verified: EvidenceItem = { kind: 'command', status: 'passed', summary: 'ok', command: 'npm test' };
  const unverified: EvidenceItem = { kind: 'inspection', status: 'unverified', summary: 'self-reported' };

  // emitA2aTaskEvent 파생식과 동형: **종단 전이(completed/failed) + evidence** 일 때만
  // 파생(state 게이트 — 리뷰 Codex+GLM). 비종단 전이는 evidence가 있어도 등급 미방출.
  function emitFor(items: EvidenceItem[] | undefined, state: TaskState = 'completed'): Record<string, unknown> {
    const isTerminal = state === 'completed' || state === 'failed';
    const verifiedItemCount = isTerminal && items ? items.filter(isVerifiedItem).length : undefined;
    publishA2aTask('ws-from', 'ws-to', 't1', state, 'updated', undefined, verifiedItemCount);
    return published[published.length - 1];
  }

  it('verified 1 + unverified 1 → verifiedItemCount=1', () => {
    expect(emitFor([verified, unverified]).verifiedItemCount).toBe(1);
  });

  it('unverified만 → verifiedItemCount=0', () => {
    expect(emitFor([unverified]).verifiedItemCount).toBe(0);
  });

  it('evidence 부재(created/cancelled/working) → 필드 부재', () => {
    expect(emitFor(undefined)).not.toHaveProperty('verifiedItemCount');
  });

  it('working 전이 + evidence → 필드 부재 (종단 전이만 등급, 리뷰 Codex+GLM)', () => {
    // 데몬은 비종단 전이에도 evidence를 수용하지만(PR-B else-if), 등급은 completed/
    // failed 만 방출한다 — working 이벤트가 등급을 달고 나가면 계약 위반.
    expect(emitFor([verified], 'working')).not.toHaveProperty('verifiedItemCount');
  });

  it('failed 전이 + evidence → 등급 방출(종단 전이)', () => {
    expect(emitFor([unverified], 'failed').verifiedItemCount).toBe(0);
  });
});
