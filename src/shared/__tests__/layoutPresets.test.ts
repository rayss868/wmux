import { describe, it, expect } from 'vitest';
import { LAYOUT_PRESETS, getPresetById } from '../layoutPresets';
import type { PaneBranch, PaneLeaf } from '../types';

/** Recursively collect all leaf panes from a pane tree. */
function collectLeaves(pane: PaneBranch | PaneLeaf): PaneLeaf[] {
  if (pane.type === 'leaf') return [pane];
  return pane.children.flatMap((child) => collectLeaves(child));
}

/** Recursively collect all pane IDs from a pane tree. */
function collectIds(pane: PaneBranch | PaneLeaf): string[] {
  if (pane.type === 'leaf') return [pane.id];
  return [pane.id, ...pane.children.flatMap((child) => collectIds(child))];
}

describe('LAYOUT_PRESETS', () => {
  it('should contain exactly 4 presets', () => {
    expect(LAYOUT_PRESETS).toHaveLength(4);
  });

  it('should have unique preset IDs', () => {
    const ids = LAYOUT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('getPresetById', () => {
  it('should return a preset by ID', () => {
    expect(getPresetById('two-agent')?.id).toBe('two-agent');
    expect(getPresetById('three-agent')?.id).toBe('three-agent');
    expect(getPresetById('code-review')?.id).toBe('code-review');
    expect(getPresetById('browser-terminal')?.id).toBe('browser-terminal');
  });

  it('should return undefined for unknown ID', () => {
    expect(getPresetById('nonexistent')).toBeUndefined();
  });
});

describe('two-agent preset', () => {
  const preset = getPresetById('two-agent')!;

  it('should produce a horizontal branch with 2 leaves', () => {
    const root = preset.createRootPane() as PaneBranch;
    expect(root.type).toBe('branch');
    expect(root.direction).toBe('horizontal');
    expect(collectLeaves(root)).toHaveLength(2);
  });

  it('should have sizes [50, 50]', () => {
    const root = preset.createRootPane() as PaneBranch;
    expect(root.sizes).toEqual([50, 50]);
  });
});

describe('three-agent preset', () => {
  const preset = getPresetById('three-agent')!;

  it('should produce 3 leaves total', () => {
    const root = preset.createRootPane() as PaneBranch;
    expect(collectLeaves(root)).toHaveLength(3);
  });

  it('should have horizontal root with sizes [50, 50]', () => {
    const root = preset.createRootPane() as PaneBranch;
    expect(root.type).toBe('branch');
    expect(root.direction).toBe('horizontal');
    expect(root.sizes).toEqual([50, 50]);
  });

  it('should have a vertical sub-branch on the right', () => {
    const root = preset.createRootPane() as PaneBranch;
    const rightChild = root.children[1] as PaneBranch;
    expect(rightChild.type).toBe('branch');
    expect(rightChild.direction).toBe('vertical');
    expect(rightChild.sizes).toEqual([50, 50]);
    expect(rightChild.children).toHaveLength(2);
  });
});

describe('code-review preset', () => {
  const preset = getPresetById('code-review')!;

  it('should produce a horizontal branch with 2 leaves', () => {
    const root = preset.createRootPane() as PaneBranch;
    expect(root.type).toBe('branch');
    expect(root.direction).toBe('horizontal');
    expect(collectLeaves(root)).toHaveLength(2);
  });

  it('should have sizes [60, 40]', () => {
    const root = preset.createRootPane() as PaneBranch;
    expect(root.sizes).toEqual([60, 40]);
  });

  it('should have empty surfaces on both leaves (no pre-created surface)', () => {
    const root = preset.createRootPane() as PaneBranch;
    const leaves = collectLeaves(root);
    leaves.forEach((leaf) => {
      expect(leaf.surfaces).toHaveLength(0);
    });
  });
});

describe('browser-terminal preset', () => {
  const preset = getPresetById('browser-terminal')!;

  it('should produce a vertical branch with 2 leaves', () => {
    const root = preset.createRootPane() as PaneBranch;
    expect(root.type).toBe('branch');
    expect(root.direction).toBe('vertical');
    expect(collectLeaves(root)).toHaveLength(2);
  });

  it('should have sizes [60, 40]', () => {
    const root = preset.createRootPane() as PaneBranch;
    expect(root.sizes).toEqual([60, 40]);
  });
});

describe('ID uniqueness across calls', () => {
  it('should generate different IDs on each createRootPane call', () => {
    for (const preset of LAYOUT_PRESETS) {
      const rootA = preset.createRootPane();
      const rootB = preset.createRootPane();
      const idsA = collectIds(rootA as PaneBranch);
      const idsB = collectIds(rootB as PaneBranch);

      // No ID from call A should appear in call B
      for (const id of idsA) {
        expect(idsB).not.toContain(id);
      }
    }
  });

  it('should have unique IDs within a single tree', () => {
    for (const preset of LAYOUT_PRESETS) {
      const root = preset.createRootPane();
      const ids = collectIds(root as PaneBranch);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
