import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provisionAccountDir, HYBRID_SHARE } from '../accountProvision';

let root: string;
let source: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-prov-'));
  source = path.join(root, 'source');
  // Seed a source config dir with shared assets + rewritten files.
  fs.mkdirSync(path.join(source, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(source, 'skills', 'demo.md'), 'x');
  fs.mkdirSync(path.join(source, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(source, 'settings.json'), '{"a":1}');
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('provisionAccountDir hybrid share', () => {
  it('creates an empty profile when share=false', () => {
    const cfg = path.join(root, 'empty');
    const r = provisionAccountDir({ configDir: cfg, vendor: 'claude', share: false, sourceDir: source });
    expect(fs.existsSync(cfg)).toBe(true);
    expect(r.linked).toEqual([]);
    expect(r.copied).toEqual([]);
    expect(fs.existsSync(path.join(cfg, 'skills'))).toBe(false);
  });

  it('links read-mostly dirs and copies rewritten files when share=true', () => {
    const cfg = path.join(root, 'shared');
    const r = provisionAccountDir({ configDir: cfg, vendor: 'claude', share: true, sourceDir: source });
    // skills + plugins present in source → linked; commands/agents absent → skipped.
    expect(r.linked).toContain('skills');
    expect(r.linked).toContain('plugins');
    expect(r.copied).toContain('settings.json');
    // The linked skills dir resolves back to the source content (live share).
    expect(fs.existsSync(path.join(cfg, 'skills', 'demo.md'))).toBe(true);
    // settings.json is a COPY, not a link — editing the copy must not touch source.
    fs.writeFileSync(path.join(cfg, 'settings.json'), '{"a":2}');
    expect(fs.readFileSync(path.join(source, 'settings.json'), 'utf8')).toBe('{"a":1}');
  });

  it('skips assets that already exist in the target (idempotent-ish)', () => {
    const cfg = path.join(root, 'preexist');
    fs.mkdirSync(path.join(cfg, 'skills'), { recursive: true });
    const r = provisionAccountDir({ configDir: cfg, vendor: 'claude', share: true, sourceDir: source });
    expect(r.linked).not.toContain('skills'); // already there, not re-linked
  });

  it('exposes the share manifest', () => {
    expect(HYBRID_SHARE.SHARED_LINK_DIRS).toContain('skills');
    expect(HYBRID_SHARE.SHARED_COPY_FILES).toContain('settings.json');
  });
});
