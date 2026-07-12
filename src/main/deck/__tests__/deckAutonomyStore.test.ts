// Unit tests for the per-workspace autonomy store: fail-closed resolution,
// round-trip persistence, sanitize-on-load (the file is hand-editable), and the
// merge-write path. The security-load-bearing property: ANY doubt resolves to
// DEFAULT (summarize on, the two dangerous caps off).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_AUTONOMY,
  loadWorkspaceAutonomy,
  loadDeckAutonomy,
  setWorkspaceAutonomy,
  getDeckAutonomyPath,
} from '../deckAutonomyStore';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-deck-auto-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deckAutonomyStore', () => {
  it('unknown workspace resolves to DEFAULT (summarize on, dangerous off)', () => {
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual({ ...DEFAULT_AUTONOMY });
    expect(DEFAULT_AUTONOMY).toEqual({
      summarize: true,
      continueInstruction: false,
      approvalPress: false,
    });
  });

  it('round-trips a merged update through the file', async () => {
    const next = await setWorkspaceAutonomy('ws-1', { continueInstruction: true }, dir);
    expect(next).toEqual({ summarize: true, continueInstruction: true, approvalPress: false });
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual(next);
    // A second workspace is untouched (per-ws map).
    expect(loadWorkspaceAutonomy('ws-2', dir)).toEqual({ ...DEFAULT_AUTONOMY });
  });

  it('merge preserves prior caps and only overwrites the patched field', async () => {
    await setWorkspaceAutonomy('ws-1', { approvalPress: true, continueInstruction: true }, dir);
    const next = await setWorkspaceAutonomy('ws-1', { approvalPress: false }, dir);
    expect(next).toEqual({ summarize: true, continueInstruction: true, approvalPress: false });
  });

  it('missing / corrupt file fails closed to DEFAULT (never throws)', () => {
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual({ ...DEFAULT_AUTONOMY });
    fs.writeFileSync(getDeckAutonomyPath(dir), 'CORRUPT{', 'utf8');
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual({ ...DEFAULT_AUTONOMY });
    expect(loadDeckAutonomy(dir)).toEqual({});
  });

  it('sanitizes hand-edited entries: dangerous caps only true when EXACTLY true', () => {
    fs.writeFileSync(
      getDeckAutonomyPath(dir),
      JSON.stringify({
        'ws-1': { summarize: false, continueInstruction: 'yes', approvalPress: 1 },
        'ws-2': { approvalPress: true },
        'bad key!': { approvalPress: true },
      }),
      'utf8',
    );
    // ws-1: summarize explicitly false; the two dangerous caps were non-boolean
    // truthy → coerced OFF (fail-closed).
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual({
      summarize: false,
      continueInstruction: false,
      approvalPress: false,
    });
    // ws-2: an explicit true is honored.
    expect(loadWorkspaceAutonomy('ws-2', dir)).toEqual({
      summarize: true,
      continueInstruction: false,
      approvalPress: true,
    });
    // Bad workspace key dropped entirely → DEFAULT.
    expect(loadWorkspaceAutonomy('bad key!', dir)).toEqual({ ...DEFAULT_AUTONOMY });
  });

  it('a bad workspaceId never writes a key and returns DEFAULT', async () => {
    const r = await setWorkspaceAutonomy('bad key!', { approvalPress: true }, dir);
    expect(r).toEqual({ ...DEFAULT_AUTONOMY });
    expect(loadDeckAutonomy(dir)).toEqual({});
  });
});
