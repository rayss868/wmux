import { describe, expect, it } from 'vitest';
import type { SessionData } from '../../../shared/types';
import { collectLegacyMetadata } from '../legacyMigration';

// === M0-f follow-up (codex P2) — v2.8.x → v2.9.0 PaneLeaf.metadata → MetadataStore migration ===
//
// `metadata.json` doesn't exist on the first boot after upgrade. The boot
// path calls `collectLegacyMetadata` to lift `PaneLeaf.metadata` into the
// store before any RPC handler reads from it. This suite locks the
// migration shape so the lift never silently drops fields.

describe('M0-f follow-up (codex P2) — collectLegacyMetadata', () => {
  it('collects every leaf with metadata across all workspaces', () => {
    const session = {
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
      workspaces: [
        {
          id: 'ws-1',
          name: 'ws-1',
          activePaneId: 'p1',
          rootPane: {
            type: 'leaf',
            id: 'p1',
            surfaces: [],
            activeSurfaceId: '',
            metadata: { label: 'Backend', role: 'svc' },
          },
        },
        {
          id: 'ws-2',
          name: 'ws-2',
          activePaneId: 'p2',
          rootPane: {
            type: 'branch',
            id: 'branch-1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              {
                type: 'leaf',
                id: 'p2',
                surfaces: [],
                activeSurfaceId: '',
                metadata: { label: 'API' },
              },
              {
                type: 'leaf',
                id: 'p3',
                surfaces: [],
                activeSurfaceId: '',
                metadata: undefined,
              },
            ],
          },
        },
      ],
    } as unknown as SessionData;

    const result = collectLegacyMetadata(session);
    expect(result).toHaveLength(2);

    const p1 = result.find((e) => e.paneId === 'p1');
    expect(p1).toBeDefined();
    expect(p1?.workspaceId).toBe('ws-1');
    expect(p1?.metadata.label).toBe('Backend');
    expect(p1?.metadata.role).toBe('svc');
    // Version starts at 1 — MetadataStore treats 0 as "never written".
    expect(p1?.version).toBe(1);

    const p2 = result.find((e) => e.paneId === 'p2');
    expect(p2).toBeDefined();
    expect(p2?.workspaceId).toBe('ws-2');
    expect(p2?.metadata.label).toBe('API');
    expect(p2?.version).toBe(1);

    // p3 has no metadata — must be skipped, not migrated with empty data.
    expect(result.find((e) => e.paneId === 'p3')).toBeUndefined();
  });

  it('returns empty array when no leaf has metadata', () => {
    const session = {
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
      workspaces: [
        {
          id: 'ws-1',
          name: 'ws-1',
          activePaneId: 'p1',
          rootPane: {
            type: 'leaf',
            id: 'p1',
            surfaces: [],
            activeSurfaceId: '',
          },
        },
        {
          id: 'ws-2',
          name: 'ws-2',
          activePaneId: 'p2',
          rootPane: {
            type: 'leaf',
            id: 'p2',
            surfaces: [],
            activeSurfaceId: '',
            metadata: undefined,
          },
        },
      ],
    } as unknown as SessionData;

    const result = collectLegacyMetadata(session);
    expect(result).toEqual([]);
  });

  it('treats empty metadata object as "no metadata"', () => {
    // Some tooling wrote `{}` instead of clearing the field; we must not
    // migrate those as no-op entries because serialize() would drop them
    // anyway on the next persist and we'd be churning the store for
    // nothing.
    const session = {
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
      workspaces: [
        {
          id: 'ws-1',
          name: 'ws-1',
          activePaneId: 'p1',
          rootPane: {
            type: 'leaf',
            id: 'p1',
            surfaces: [],
            activeSurfaceId: '',
            metadata: {},
          },
        },
        {
          id: 'ws-2',
          name: 'ws-2',
          activePaneId: 'p2',
          rootPane: {
            type: 'leaf',
            id: 'p2',
            surfaces: [],
            activeSurfaceId: '',
            // Only `custom: {}` — also empty.
            metadata: { custom: {} },
          },
        },
      ],
    } as unknown as SessionData;

    const result = collectLegacyMetadata(session);
    expect(result).toEqual([]);
  });

  it('preserves custom map and updatedAt timestamp', () => {
    const now = Date.now();
    const session = {
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
      workspaces: [
        {
          id: 'ws-1',
          name: 'ws-1',
          activePaneId: 'p1',
          rootPane: {
            type: 'leaf',
            id: 'p1',
            surfaces: [],
            activeSurfaceId: '',
            metadata: {
              label: 'X',
              custom: { 'tool.namespace.key': 'value' },
              updatedAt: now,
            },
          },
        },
      ],
    } as unknown as SessionData;

    const result = collectLegacyMetadata(session);
    expect(result).toHaveLength(1);
    expect(result[0].metadata.custom?.['tool.namespace.key']).toBe('value');
    expect(result[0].metadata.updatedAt).toBe(now);
  });

  it('walks nested branches to find deep leaves', () => {
    // Branch → Branch → Leaf — make sure the recursion doesn't stop at
    // the first level.
    const session = {
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
      workspaces: [
        {
          id: 'ws-1',
          name: 'ws-1',
          activePaneId: 'p-deep',
          rootPane: {
            type: 'branch',
            id: 'b1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              {
                type: 'leaf',
                id: 'p-shallow',
                surfaces: [],
                activeSurfaceId: '',
                metadata: { label: 'Shallow' },
              },
              {
                type: 'branch',
                id: 'b2',
                direction: 'vertical',
                sizes: [50, 50],
                children: [
                  {
                    type: 'leaf',
                    id: 'p-deep',
                    surfaces: [],
                    activeSurfaceId: '',
                    metadata: { label: 'Deep' },
                  },
                ],
              },
            ],
          },
        },
      ],
    } as unknown as SessionData;

    const result = collectLegacyMetadata(session);
    expect(result).toHaveLength(2);
    expect(result.find((e) => e.paneId === 'p-shallow')?.metadata.label).toBe('Shallow');
    expect(result.find((e) => e.paneId === 'p-deep')?.metadata.label).toBe('Deep');
  });

  it('clones metadata so post-migration mutations on SessionData do not bleed into the snapshot', () => {
    const session = {
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
      workspaces: [
        {
          id: 'ws-1',
          name: 'ws-1',
          activePaneId: 'p1',
          rootPane: {
            type: 'leaf',
            id: 'p1',
            surfaces: [],
            activeSurfaceId: '',
            metadata: { label: 'Original', custom: { k: 'v' } },
          },
        },
      ],
    } as unknown as SessionData;

    const result = collectLegacyMetadata(session);
    // Mutate the source after migration — snapshot must be unaffected.
    const leaf = session.workspaces[0].rootPane as { metadata: { label?: string; custom?: Record<string, string> } };
    leaf.metadata.label = 'Tampered';
    if (leaf.metadata.custom) leaf.metadata.custom.k = 'tampered';

    expect(result[0].metadata.label).toBe('Original');
    expect(result[0].metadata.custom?.['k']).toBe('v');
  });
});
