import { describe, it, expect } from 'vitest';
import { LAYOUT_PRESETS, getPresetById, type LayoutPreset } from '../layoutPresets';
import type { PaneBranch, PaneLeaf } from '../types';

describe('LAYOUT_PRESETS', () => {
  it('has exactly 6 presets', () => {
    expect(LAYOUT_PRESETS).toHaveLength(6);
  });

  it('each preset has id, name, description, and createRootPane', () => {
    for (const preset of LAYOUT_PRESETS) {
      expect(typeof preset.id).toBe('string');
      expect(preset.id.length).toBeGreaterThan(0);
      expect(typeof preset.name).toBe('string');
      expect(preset.name.length).toBeGreaterThan(0);
      expect(typeof preset.description).toBe('string');
      expect(preset.description.length).toBeGreaterThan(0);
      expect(typeof preset.createRootPane).toBe('function');
    }
  });

  it('all preset ids are unique', () => {
    const ids = LAYOUT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('single preset', () => {
  it('returns a leaf pane', () => {
    const preset = getPresetById('single')!;
    const root = preset.createRootPane();
    expect(root.type).toBe('leaf');
    const leaf = root as PaneLeaf;
    expect(leaf.surfaces).toEqual([]);
    expect(leaf.activeSurfaceId).toBe('');
  });
});

describe('hsplit preset', () => {
  it('returns a horizontal branch with 2 leaf children and sizes [50, 50]', () => {
    const preset = getPresetById('hsplit')!;
    const root = preset.createRootPane() as PaneBranch;
    expect(root.type).toBe('branch');
    expect(root.direction).toBe('horizontal');
    expect(root.children).toHaveLength(2);
    expect(root.sizes).toEqual([50, 50]);
    for (const child of root.children) {
      expect(child.type).toBe('leaf');
    }
  });
});

describe('vsplit preset', () => {
  it('returns a vertical branch with 2 leaf children and sizes [50, 50]', () => {
    const preset = getPresetById('vsplit')!;
    const root = preset.createRootPane() as PaneBranch;
    expect(root.type).toBe('branch');
    expect(root.direction).toBe('vertical');
    expect(root.children).toHaveLength(2);
    expect(root.sizes).toEqual([50, 50]);
    for (const child of root.children) {
      expect(child.type).toBe('leaf');
    }
  });
});

describe('three-col preset', () => {
  it('returns a horizontal branch with 3 leaf children', () => {
    const preset = getPresetById('three-col')!;
    const root = preset.createRootPane() as PaneBranch;
    expect(root.type).toBe('branch');
    expect(root.direction).toBe('horizontal');
    expect(root.children).toHaveLength(3);
    expect(root.sizes).toEqual([33, 34, 33]);
    for (const child of root.children) {
      expect(child.type).toBe('leaf');
    }
  });
});

describe('main-side preset', () => {
  it('returns a horizontal branch with sizes [70, 30]', () => {
    const preset = getPresetById('main-side')!;
    const root = preset.createRootPane() as PaneBranch;
    expect(root.type).toBe('branch');
    expect(root.direction).toBe('horizontal');
    expect(root.children).toHaveLength(2);
    expect(root.sizes).toEqual([70, 30]);
    for (const child of root.children) {
      expect(child.type).toBe('leaf');
    }
  });
});

describe('grid-4 preset', () => {
  it('returns a vertical branch with 2 horizontal branch children, totaling 4 leaves', () => {
    const preset = getPresetById('grid-4')!;
    const root = preset.createRootPane() as PaneBranch;
    expect(root.type).toBe('branch');
    expect(root.direction).toBe('vertical');
    expect(root.children).toHaveLength(2);
    expect(root.sizes).toEqual([50, 50]);

    for (const child of root.children) {
      const branch = child as PaneBranch;
      expect(branch.type).toBe('branch');
      expect(branch.direction).toBe('horizontal');
      expect(branch.children).toHaveLength(2);
      expect(branch.sizes).toEqual([50, 50]);
      for (const leaf of branch.children) {
        expect(leaf.type).toBe('leaf');
      }
    }
  });
});

describe('unique IDs on repeated calls', () => {
  it('each call to createRootPane produces unique pane IDs', () => {
    function collectIds(pane: PaneLeaf | PaneBranch): string[] {
      if (pane.type === 'leaf') return [pane.id];
      return [pane.id, ...pane.children.flatMap((c) => collectIds(c as PaneLeaf | PaneBranch))];
    }

    for (const preset of LAYOUT_PRESETS) {
      const root1 = preset.createRootPane();
      const root2 = preset.createRootPane();
      const ids1 = collectIds(root1 as PaneLeaf | PaneBranch);
      const ids2 = collectIds(root2 as PaneLeaf | PaneBranch);

      // No ID from call 1 should appear in call 2
      for (const id of ids1) {
        expect(ids2).not.toContain(id);
      }
    }
  });
});

describe('getPresetById', () => {
  it('returns the correct preset for a valid id', () => {
    const preset = getPresetById('hsplit');
    expect(preset).toBeDefined();
    expect(preset!.id).toBe('hsplit');
    expect(preset!.name).toBe('Horizontal Split');
  });

  it('returns undefined for a nonexistent id', () => {
    const result = getPresetById('nonexistent');
    expect(result).toBeUndefined();
  });
});
