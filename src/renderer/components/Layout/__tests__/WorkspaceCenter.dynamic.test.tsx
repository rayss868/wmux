// @vitest-environment jsdom
//
// IA 결정(2026-07-20): Git·Review는 워크스페이스 헤더 탭 + 중앙 표면.
// 검증:
//  1. 헤더 탭(WorkspaceUtilityBar) 렌더 + 클릭 토글 → workspaceUtilityView set/null.
//  2. 유틸 뷰 열림 시 GitTab이 렌더되고 페인 그리드는 display:none으로 숨김
//     (언마운트 아님 — DOM에 그대로 남아 xterm/PTY 유지).
//
// WorkspaceViewport/GitTab/ReviewTab은 xterm·rpc 등 무거운 트리를 끌고 오므로
// 가벼운 센티넬로 목킹한다 — 이 테스트가 검증하는 건 배선(구독·display 토글)이다.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../WorkspaceViewport', () => ({
  WorkspaceViewport: () =>
    React.createElement('div', { 'data-pane-grid-sentinel': 'true' }, 'PANES'),
}));
vi.mock('../../Deck/GitTab', () => ({
  GitTab: () => React.createElement('div', { 'data-git-tab-sentinel': 'true' }, 'GIT'),
}));
vi.mock('../../Deck/ReviewTab', () => ({
  ReviewTab: () => React.createElement('div', { 'data-review-tab-sentinel': 'true' }, 'REVIEW'),
}));

import { WorkspaceCenter } from '../WorkspaceCenter';
import { useStore } from '../../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(WorkspaceCenter));
  });
}

function click(sel: string): void {
  const el = container.querySelector<HTMLElement>(sel);
  expect(el, `${sel} should exist`).not.toBeNull();
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  state.setWorkspaceUtilityView(null);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useStore.getState().setWorkspaceUtilityView(null);
});

describe('WorkspaceUtilityBar — 헤더 탭 토글', () => {
  it('Git·Review 탭을 렌더한다', () => {
    mount();
    expect(container.querySelector('[data-ws-utility-tab="git"]')).not.toBeNull();
    expect(container.querySelector('[data-ws-utility-tab="review"]')).not.toBeNull();
  });

  it('Git 탭 클릭 → workspaceUtilityView="git", 다시 클릭 → null(토글 닫기)', () => {
    mount();
    click('[data-ws-utility-tab="git"]');
    expect(useStore.getState().workspaceUtilityView).toBe('git');
    click('[data-ws-utility-tab="git"]');
    expect(useStore.getState().workspaceUtilityView).toBeNull();
  });

  it('다른 탭 클릭 → 해당 값으로 전환(닫기 아님)', () => {
    mount();
    click('[data-ws-utility-tab="git"]');
    click('[data-ws-utility-tab="review"]');
    expect(useStore.getState().workspaceUtilityView).toBe('review');
  });
});

describe('WorkspaceCenter — 유틸 뷰 열림 시 중앙 표면 + 페인 그리드 숨김', () => {
  it('뷰가 null이면 페인 그리드 보임, GitTab 없음', () => {
    mount();
    const wrapper = container.querySelector<HTMLElement>('[data-pane-grid-wrapper]');
    expect(wrapper).not.toBeNull();
    // display:none이 아니어야 한다(style.display는 빈 문자열 = 기본값).
    expect(wrapper!.style.display).not.toBe('none');
    expect(container.querySelector('[data-git-tab-sentinel]')).toBeNull();
  });

  it('Git 뷰 열면 GitTab 렌더 + 페인 그리드는 display:none(언마운트 아님)', () => {
    mount();
    click('[data-ws-utility-tab="git"]');

    // GitTab 표면이 렌더된다.
    expect(container.querySelector('[data-git-tab-sentinel]')).not.toBeNull();
    expect(container.querySelector('[data-ws-utility-surface="git"]')).not.toBeNull();

    // 페인 그리드는 언마운트되지 않고(센티넬 여전히 DOM에 존재) display:none으로 숨음.
    const wrapper = container.querySelector<HTMLElement>('[data-pane-grid-wrapper]');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.style.display).toBe('none');
    expect(container.querySelector('[data-pane-grid-sentinel]')).not.toBeNull();
  });

  it('✕ 버튼으로 닫으면 표면이 사라지고 페인 그리드가 다시 보인다', () => {
    mount();
    click('[data-ws-utility-tab="git"]');
    click('[data-ws-utility-close]');
    expect(useStore.getState().workspaceUtilityView).toBeNull();
    expect(container.querySelector('[data-git-tab-sentinel]')).toBeNull();
    const wrapper = container.querySelector<HTMLElement>('[data-pane-grid-wrapper]');
    expect(wrapper!.style.display).not.toBe('none');
  });
});
