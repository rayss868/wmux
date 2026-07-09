// Pure-logic tests for the W2 gate additions to scripts/perf-compare.mjs:
//   - BOOL_GATES + compareBoolGates() (baseline-independent consistency check)
//   - the three frameBudget numeric GATES (ratio 2.0 regression check)
// No packaged app / CDP / pipes — safe on every CI runner.
import { describe, it, expect } from 'vitest';
import {
  compareBoolGates,
  compareResults,
  hasFailure,
  BOOL_GATES,
  GATES,
} from '../perf-compare.mjs';

function verdictFor(results, key) {
  const r = results.find((x) => x.key === key);
  if (!r) throw new Error(`no result for ${key}`);
  return r;
}

describe('BOOL_GATES / compareBoolGates', () => {
  it('registers exactly the ime + webglContextLoss consistency gates', () => {
    expect(BOOL_GATES.map((g) => g.key)).toEqual(['imePass', 'webglContextLossPass']);
  });

  it('PASS when the scenario is present and pass === true', () => {
    const current = {
      scenarios: {
        ime: { pass: true },
        webglContextLoss: { pass: true },
      },
    };
    const results = compareBoolGates(current);
    expect(verdictFor(results, 'imePass').status).toBe('PASS');
    expect(verdictFor(results, 'webglContextLossPass').status).toBe('PASS');
    expect(hasFailure(results)).toBe(false);
  });

  it('FAIL when the scenario is present but pass !== true (baseline-independent)', () => {
    const current = {
      scenarios: {
        ime: { pass: false },
        webglContextLoss: { pass: true },
      },
    };
    const results = compareBoolGates(current);
    expect(verdictFor(results, 'imePass').status).toBe('FAIL');
    expect(verdictFor(results, 'webglContextLossPass').status).toBe('PASS');
    expect(hasFailure(results)).toBe(true);
  });

  it('FAIL when pass is missing but the scenario object exists (e.g. it threw)', () => {
    const current = { scenarios: { ime: { error: 'boom' }, webglContextLoss: { pass: true } } };
    expect(verdictFor(compareBoolGates(current), 'imePass').status).toBe('FAIL');
  });

  it('SKIP when the scenario is absent (skipped by a flag)', () => {
    const current = { scenarios: {} };
    const results = compareBoolGates(current);
    expect(verdictFor(results, 'imePass').status).toBe('SKIP');
    expect(verdictFor(results, 'webglContextLossPass').status).toBe('SKIP');
    expect(hasFailure(results)).toBe(false);
  });
});

describe('frameBudget numeric gates', () => {
  const frameBudgetKeys = ['frameBudgetP95Ms_N4', 'frameBudgetP95Ms_N8', 'frameBudgetP95Ms_N16'];

  it('are registered with ratio 2.0', () => {
    for (const key of frameBudgetKeys) {
      const gate = GATES.find((g) => g.key === key);
      expect(gate).toBeDefined();
      expect(gate.ratio).toBe(2.0);
      expect(gate.unit).toBe('ms');
    }
  });

  function withFrameBudget(baseP95, curP95) {
    const scenario = (p95) => ({ N4: { frameDeltaMs: { p95 } }, N8: { frameDeltaMs: { p95 } }, N16: { frameDeltaMs: { p95 } } });
    return {
      baseline: { scenarios: { frameBudget: scenario(baseP95) } },
      current: { scenarios: { frameBudget: scenario(curP95) } },
    };
  }

  it('PASS when within 2x (no regression)', () => {
    const { baseline, current } = withFrameBudget(20, 35); // 1.75x
    const results = compareResults(current, baseline, GATES);
    for (const key of frameBudgetKeys) expect(verdictFor(results, key).status).toBe('PASS');
  });

  it('FAIL when past 2x AND the absolute margin', () => {
    const { baseline, current } = withFrameBudget(20, 60); // 3x, +40ms > 8ms
    const results = compareResults(current, baseline, GATES);
    for (const key of frameBudgetKeys) expect(verdictFor(results, key).status).toBe('FAIL');
    expect(hasFailure(results)).toBe(true);
  });

  it('does NOT fail on a tiny baseline blip under the absolute margin', () => {
    const { baseline, current } = withFrameBudget(2, 6); // 3x but +4ms < 8ms margin
    const results = compareResults(current, baseline, GATES);
    for (const key of frameBudgetKeys) expect(verdictFor(results, key).status).toBe('PASS');
  });

  it('is NEW (informational) when the baseline lacks frameBudget', () => {
    const current = { scenarios: { frameBudget: { N4: { frameDeltaMs: { p95: 30 } } } } };
    const results = compareResults(current, { scenarios: {} }, GATES);
    expect(verdictFor(results, 'frameBudgetP95Ms_N4').status).toBe('NEW');
  });
});
