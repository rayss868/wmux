// @vitest-environment jsdom
//
// 에이전트 툴바의 Multi Task(fan-out) 버튼 동적 테스트. fan-out은 덱 컨트롤 바에서
// 툴바로 복귀했다(DESIGN.md Decisions Log 2026-07-20) — 예전 컨트롤 바 빈-함대
// 테스트를 여기로 옮겼다. 실제 <AgentToolbar/>를 react-dom/client로 마운트해
// fanout-button이 렌더되고, 클릭 시 FanOutDialog가 툴바 위로 토글되는지 검증한다.
// 패키징된 Electron UI는 자동화 불가라 이 jsdom 하네스가 검증면이다.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// pty write 경로는 스텁(마운트/토글만 검증 — 발사는 하지 않는다).
vi.mock('../inject', () => ({
  injectText: () => Promise.resolve(),
  quotePathsForPrompt: (paths: string[]) => paths.join(' '),
}));

import { useStore } from '../../../stores';
import AgentToolbar from '../AgentToolbar';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => useStore.setState({ toolbarPopover: null }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(): void {
  act(() => root.render(createElement(AgentToolbar)));
}

const fanoutButton = (): HTMLButtonElement =>
  container.querySelector('[data-testid="fanout-button"]') as HTMLButtonElement;

describe('AgentToolbar — fan-out', () => {
  it('renders the fan-out button even with no active workspace (spawn a fleet from zero)', () => {
    mount();
    expect(fanoutButton()).not.toBeNull();
    // 다이얼로그는 닫힌 상태로 시작한다.
    expect(container.querySelector('[data-testid="fanout-dialog"]')).toBeNull();
  });

  it('toggles the FanOutDialog open and closed on click', () => {
    mount();
    act(() => {
      fanoutButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="fanout-dialog"]')).not.toBeNull();
    act(() => {
      fanoutButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="fanout-dialog"]')).toBeNull();
  });
});
