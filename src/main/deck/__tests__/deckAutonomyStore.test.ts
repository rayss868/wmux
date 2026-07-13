// Unit tests for the per-workspace autonomy store: fail-closed resolution,
// round-trip persistence, sanitize-on-load (the file is hand-editable), the
// merge-write path, AND the agent-mode layer (mode ⇄ caps, legacy derivation).
// Security-load-bearing property: the DANGEROUS cap (approvalPress) is never
// on unless a workspace is explicitly `orchestrate`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_AUTONOMY,
  DEFAULT_MODE,
  modeToCaps,
  modeToWakePolicy,
  deriveMode,
  loadWorkspaceAutonomy,
  loadWorkspaceMode,
  loadDeckAutonomy,
  setWorkspaceAutonomy,
  setWorkspaceMode,
  getDeckAutonomyPath,
  type AgentMode,
} from '../deckAutonomyStore';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-deck-auto-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deckAutonomyStore — mode ⇄ caps', () => {
  it('modeToCaps: only orchestrate turns on the dangerous approvalPress cap', () => {
    expect(modeToCaps('off')).toEqual({ summarize: false, continueInstruction: false, approvalPress: false });
    expect(modeToCaps('manual')).toEqual({ summarize: false, continueInstruction: false, approvalPress: false });
    expect(modeToCaps('assist')).toEqual({ summarize: true, continueInstruction: true, approvalPress: false });
    expect(modeToCaps('orchestrate')).toEqual({ summarize: true, continueInstruction: true, approvalPress: true });
  });

  it('modeToWakePolicy maps each mode', () => {
    expect(modeToWakePolicy('off')).toBe('none');
    expect(modeToWakePolicy('manual')).toBe('none');
    expect(modeToWakePolicy('assist')).toBe('value-filtered');
    expect(modeToWakePolicy('orchestrate')).toBe('all');
  });

  it('deriveMode back-maps legacy caps by the dangerous caps', () => {
    expect(deriveMode({ summarize: true, continueInstruction: false, approvalPress: true })).toBe('orchestrate');
    expect(deriveMode({ summarize: true, continueInstruction: true, approvalPress: false })).toBe('assist');
    // all-off legacy (the pre-mode "report only" default) → the product default.
    expect(deriveMode({ summarize: true, continueInstruction: false, approvalPress: false })).toBe(DEFAULT_MODE);
  });

  it('DEFAULT is the product default mode (assist), dangerous cap off', () => {
    expect(DEFAULT_MODE).toBe('assist');
    expect(DEFAULT_AUTONOMY).toEqual({
      mode: 'assist',
      summarize: true,
      continueInstruction: true,
      approvalPress: false,
    });
  });
});

describe('deckAutonomyStore', () => {
  it('unknown workspace resolves to DEFAULT', () => {
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual({ ...DEFAULT_AUTONOMY });
    expect(loadWorkspaceMode('ws-1', dir)).toBe('assist');
  });

  it('setWorkspaceMode round-trips mode + derived caps', async () => {
    const next = await setWorkspaceMode('ws-1', 'orchestrate', dir);
    expect(next).toEqual({ mode: 'orchestrate', summarize: true, continueInstruction: true, approvalPress: true });
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual(next);
    expect(loadWorkspaceMode('ws-1', dir)).toBe('orchestrate');
  });

  it('setWorkspaceMode off writes the all-off caps', async () => {
    const next = await setWorkspaceMode('ws-1', 'off', dir);
    expect(next).toEqual({ mode: 'off', summarize: false, continueInstruction: false, approvalPress: false });
  });

  it('an unknown mode string is a no-op returning DEFAULT (never writes)', async () => {
    const r = await setWorkspaceMode('ws-1', 'bogus' as AgentMode, dir);
    expect(r).toEqual({ ...DEFAULT_AUTONOMY });
    expect(loadDeckAutonomy(dir)).toEqual({});
  });

  it('setWorkspaceAutonomy (cap-only patch) PRESERVES the stored mode', async () => {
    await setWorkspaceMode('ws-1', 'orchestrate', dir);
    // The loop cap-override path patches ONLY caps — the mode must survive.
    const next = await setWorkspaceAutonomy('ws-1', { continueInstruction: false }, dir);
    expect(next.mode).toBe('orchestrate');
    expect(next.continueInstruction).toBe(false);
  });

  it('missing / corrupt file fails closed to DEFAULT (never throws)', () => {
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual({ ...DEFAULT_AUTONOMY });
    fs.writeFileSync(getDeckAutonomyPath(dir), 'CORRUPT{', 'utf8');
    expect(loadWorkspaceAutonomy('ws-1', dir)).toEqual({ ...DEFAULT_AUTONOMY });
    expect(loadDeckAutonomy(dir)).toEqual({});
  });

  it('legacy entries with NO mode field back-derive one from caps', () => {
    fs.writeFileSync(
      getDeckAutonomyPath(dir),
      JSON.stringify({
        'ws-legacy-orch': { summarize: true, continueInstruction: true, approvalPress: true },
        'ws-legacy-assist': { summarize: true, continueInstruction: true, approvalPress: false },
        'ws-legacy-default': { summarize: true, continueInstruction: false, approvalPress: false },
      }),
      'utf8',
    );
    expect(loadWorkspaceMode('ws-legacy-orch', dir)).toBe('orchestrate');
    expect(loadWorkspaceMode('ws-legacy-assist', dir)).toBe('assist');
    // pre-mode "report only" default → the new product default (spam fix applied).
    expect(loadWorkspaceMode('ws-legacy-default', dir)).toBe('assist');
  });

  it('a stored valid mode field is used as-is', () => {
    fs.writeFileSync(
      getDeckAutonomyPath(dir),
      JSON.stringify({ 'ws-1': { mode: 'manual', summarize: false, continueInstruction: false, approvalPress: false } }),
      'utf8',
    );
    expect(loadWorkspaceMode('ws-1', dir)).toBe('manual');
  });

  it('an invalid stored mode string falls back to deriveMode(caps)', () => {
    fs.writeFileSync(
      getDeckAutonomyPath(dir),
      JSON.stringify({ 'ws-1': { mode: 'bogus', summarize: true, continueInstruction: false, approvalPress: true } }),
      'utf8',
    );
    // caps have approval on → derives orchestrate.
    expect(loadWorkspaceMode('ws-1', dir)).toBe('orchestrate');
  });

  it('a bad workspaceId never writes a key and returns DEFAULT', async () => {
    const r = await setWorkspaceMode('bad key!', 'orchestrate', dir);
    expect(r).toEqual({ ...DEFAULT_AUTONOMY });
    expect(loadDeckAutonomy(dir)).toEqual({});
  });
});
