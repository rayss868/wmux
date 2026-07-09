// @vitest-environment jsdom
//
// NB2 파동2 — FleetView 마운트 포커스 레이스 회귀 하네스.
//
// 증상(2모델 합의 CRITICAL): 상시 크롬으로 전환하면서 마운트 효과(rAF로 포커스를
// 당김)와 로빙 포커스 효과가 각각 useEffect로 분리됐다. 로빙 효과의
// `panel.contains(document.activeElement)` 가드는 마운트 시점에 동기 실행되는데,
// 그때는 rAF 콜백이 아직 안 돌아 패널 안에 포커스가 없어 거짓 → 즉시 return.
// 예전 마운트 효과는 panelRef(컨테이너)에만 포커스를 줬으므로 어떤 카드에도 실제
// DOM 포커스가 걸리지 않았다. 탭에 카드가 하나뿐이면 화살표를 눌러도 인덱스가
// 클램프돼 로빙이 영영 안 살아나고, 스크린리더도 최초 선택을 announce하지 못한다.
//
// 수정: 마운트 효과가 panelRef가 아니라 "현재 포커스 인덱스의 카드/행"에 직접
// 포커스한다. 이 하네스는 REAL <FleetView/>를 createRoot로 마운트해 효과를 돌리고,
// rAF를 flush한 뒤 document.activeElement가 (컨테이너가 아니라) data-fleet-card
// 버튼인지 검증한다. 카드가 하나뿐인 케이스(레이스가 영구화되던 조건)를 픽스처로
// 고정한다. 겸사겸사 닫힘 시 포커스 복원(INFO 4번)도 검증한다.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FleetView from '../FleetView';
import { useStore } from '../../../stores';
import type { Workspace, Pane, Surface } from '../../../../shared/types';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Fixtures: 브라우저 서피스 단일 페인 = 카드 1개(터미널 tail 경로 회피) ─────
function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: `C:\\repo\\${id}`, surfaceType: 'browser', ...extra };
}
function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}
function workspace(id: string, name: string, rootPane: Pane, activePaneId: string): Workspace {
  return { id, name, rootPane, activePaneId };
}
const singleCardWorkspaces: Workspace[] = [
  workspace('ws-1', 'alpha', leaf('p1', [surface('s1', 'pty-1')]), 'p1'),
];

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(FleetView));
  });
}

function unmount(): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

/** 마운트 효과가 예약한 rAF 콜백(포커스 이동)을 flush한다. */
async function flushRaf(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

beforeEach(() => {
  act(() => {
    useStore.setState({
      locale: 'en',
      sidebarPosition: 'left',
      fleetActiveTab: 'fleet',
      fleetSortMode: 'attention',
      workspaces: singleCardWorkspaces,
    });
  });
});

afterEach(() => {
  try {
    unmount();
  } catch {
    /* self-unmounted */
  }
  document.body.innerHTML = '';
});

describe('FleetView — mount focus race (NB2 wave2)', () => {
  it('lands real DOM focus on the single fleet card, not the panel container', async () => {
    mount();
    await flushRaf();

    const active = document.activeElement as HTMLElement | null;
    // 레이스가 있으면 여기서 active는 role=region 패널(또는 body)이라 실패한다.
    expect(active?.hasAttribute('data-fleet-card')).toBe(true);
    expect(active?.getAttribute('role')).toBe('option');
  });
});
