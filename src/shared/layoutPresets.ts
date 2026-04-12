import { createLeafPane, generateId } from './types';
import type { Pane, PaneBranch } from './types';

export interface LayoutPreset {
  id: string;
  name: string;
  description: string;
  icon?: string;
  createRootPane: () => Pane;
}

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'two-agent',
    name: '2-Agent 모드',
    description: '좌우 수평 분할 (50:50)',
    icon: 'columns',
    createRootPane(): PaneBranch {
      return {
        id: generateId('pane'),
        type: 'branch',
        direction: 'horizontal',
        children: [createLeafPane(), createLeafPane()],
        sizes: [50, 50],
      };
    },
  },
  {
    id: 'three-agent',
    name: '3-Agent 모드',
    description: '좌측 50% + 우측 상하 분할 (50:50)',
    icon: 'layout',
    createRootPane(): PaneBranch {
      const rightBranch: PaneBranch = {
        id: generateId('pane'),
        type: 'branch',
        direction: 'vertical',
        children: [createLeafPane(), createLeafPane()],
        sizes: [50, 50],
      };
      return {
        id: generateId('pane'),
        type: 'branch',
        direction: 'horizontal',
        children: [createLeafPane(), rightBranch],
        sizes: [50, 50],
      };
    },
  },
  {
    id: 'code-review',
    name: '코드리뷰 모드',
    description: '좌측 60% 터미널 + 우측 40% 브라우저',
    icon: 'code',
    createRootPane(): PaneBranch {
      return {
        id: generateId('pane'),
        type: 'branch',
        direction: 'horizontal',
        children: [createLeafPane(), createLeafPane()],
        sizes: [60, 40],
      };
    },
  },
  {
    id: 'browser-terminal',
    name: '브라우저+터미널',
    description: '상단 60% 브라우저 + 하단 40% 터미널',
    icon: 'globe',
    createRootPane(): PaneBranch {
      return {
        id: generateId('pane'),
        type: 'branch',
        direction: 'vertical',
        children: [createLeafPane(), createLeafPane()],
        sizes: [60, 40],
      };
    },
  },
];

export function getPresetById(id: string): LayoutPreset | undefined {
  return LAYOUT_PRESETS.find((preset) => preset.id === id);
}
