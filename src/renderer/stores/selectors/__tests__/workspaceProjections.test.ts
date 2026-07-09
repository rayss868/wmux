/**
 * A1 투영 셀렉터의 참조 캐시 계약 (리뷰 반영 — 3모델 합의 급소).
 *
 * 초판 투영은 매 호출 새 원소 객체를 만들어 zustand useShallow(원소 Object.is
 * 비교)가 항상 실패했다 — 리렌더 감소가 무력화되는 결함. 이 테스트는 참조
 * 캐시 계약을 직접 고정한다:
 *   (1) 관심 필드 무변경 → **배열 참조 자체가 동일**(리렌더 0의 전제),
 *   (2) 일부 항목만 변경 → 새 배열이되 미변경 원소는 **이전 참조 재사용**,
 *   (3) 관심 밖 필드 변경(cwd 등)에는 배열 참조 불변.
 * 컴포넌트 마운트 프로브(rerenderRegression.dynamic)와 상보 — 여기는 셀렉터
 * 계층의 계약을 마운트 마찰 없이 검증한다.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../index';
import {
  selectWorkspaceIdName,
  selectWorkspaceRailSummary,
  selectWorkspaceMuteRows,
} from '../workspaceProjections';
import type { SessionData } from '../../../../shared/types';

function makeWorkspace(id: string, name: string): SessionData['workspaces'][number] {
  return {
    id,
    name,
    rootPane: {
      id: `${id}-pane`,
      type: 'leaf',
      surfaces: [{ id: `${id}-surf`, ptyId: `${id}-pty`, title: 't', shell: 'zsh', cwd: '/x' }],
      activeSurfaceId: `${id}-surf`,
    },
    activePaneId: `${id}-pane`,
  } as SessionData['workspaces'][number];
}

beforeEach(() => {
  useStore.getState().loadSession({
    workspaces: [makeWorkspace('ws-1', 'Alpha'), makeWorkspace('ws-2', 'Bravo')],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  });
});

describe('workspaceProjections — 참조 캐시 계약', () => {
  it('관심 밖 변경(surface title)에는 IdName 배열 참조가 그대로다', () => {
    const before = selectWorkspaceIdName(useStore.getState());
    useStore.getState().updateSurfaceTitleByPty('ws-2-pty', 'changed');
    const after = selectWorkspaceIdName(useStore.getState());
    // workspaces 통트리 참조는 바뀌지만(immer), name이 불변이므로 투영은 캐시 히트.
    expect(after).toBe(before);
  });

  it('이름 변경 시 새 배열 — 단 미변경 원소는 이전 참조를 재사용한다', () => {
    const before = selectWorkspaceIdName(useStore.getState());
    useStore.getState().renameWorkspace('ws-2', 'Bravo2');
    const after = selectWorkspaceIdName(useStore.getState());
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]); // ws-1 원소 참조 재사용.
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].name).toBe('Bravo2');
  });

  it('RailSummary는 cwd/git 변경에 불변, agentStatus 변경에만 반응한다', () => {
    const s0 = selectWorkspaceRailSummary(useStore.getState());
    useStore.getState().updateWorkspaceMetadata('ws-2', { cwd: '/new', gitBranch: 'feat' });
    const s1 = selectWorkspaceRailSummary(useStore.getState());
    expect(s1).toBe(s0); // 레일 관심 필드 아님 — 배열 참조 유지.
    useStore.getState().updateWorkspaceMetadata('ws-2', { agentStatus: 'running' });
    const s2 = selectWorkspaceRailSummary(useStore.getState());
    expect(s2).not.toBe(s1);
    expect(s2[0]).toBe(s1[0]); // ws-1 원소는 재사용.
    expect(s2[1].agentStatus).toBe('running');
  });

  it('MuteRows는 뮤트 토글에만 반응한다', () => {
    const m0 = selectWorkspaceMuteRows(useStore.getState());
    useStore.getState().updateSurfaceTitleByPty('ws-1-pty', 'noise');
    expect(selectWorkspaceMuteRows(useStore.getState())).toBe(m0);
    useStore.getState().updateWorkspaceMetadata('ws-1', { notificationsMuted: true });
    const m1 = selectWorkspaceMuteRows(useStore.getState());
    expect(m1).not.toBe(m0);
    expect(m1[0].notificationsMuted).toBe(true);
    expect(m1[1]).toBe(m0[1]);
  });

  it('추가/삭제는 배열을 갱신한다(구조 변경 반영 — 캐시가 삭제를 은폐하지 않음)', () => {
    const before = selectWorkspaceIdName(useStore.getState());
    useStore.getState().loadSession({
      workspaces: [makeWorkspace('ws-1', 'Alpha')],
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
    });
    const after = selectWorkspaceIdName(useStore.getState());
    expect(after).not.toBe(before);
    expect(after).toHaveLength(1);
  });
});
