import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PluginHostLoader } from '../PluginHostLoader';
import type { PluginTrustStore } from '../../mcp/PluginTrustStore';
import type { PluginIdentityRecord } from '../../../shared/rpc';

function makeTrustStore(records: Record<string, Partial<PluginIdentityRecord>> = {}) {
  return {
    upsertDeclaration: vi.fn(async (name: string) => ({ name, status: 'unconfirmed' })),
    get: vi.fn(async (name: string) =>
      records[name] ? ({ name, status: 'unconfirmed', ...records[name] } as PluginIdentityRecord) : undefined),
  } as unknown as PluginTrustStore;
}

function writeBundle(root: string, name: string, manifest: unknown, files: Record<string, string> = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

const MANIFEST = (name: string) => ({
  name,
  version: '1.0.0',
  capabilities: ['ui.sidebar', 'workspace.read'],
  activationEvents: ['onStartup'],
  contributes: { sidebar: { title: 'Demo', entry: 'panel.html' } },
});

describe('PluginHostLoader', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pluginloader-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns empty when the plugins dir is missing', async () => {
    const loader = new PluginHostLoader(makeTrustStore(), path.join(root, 'nope'));
    expect(await loader.loadAll()).toEqual([]);
    expect(loader.listFailures()).toEqual([]);
  });

  it('loads a valid bundle and registers its declaration', async () => {
    const store = makeTrustStore();
    writeBundle(root, 'demo', MANIFEST('demo'), { 'panel.html': '<html></html>' });
    const loader = new PluginHostLoader(store, root);
    const loaded = await loader.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].manifest.name).toBe('demo');
    expect(store.upsertDeclaration).toHaveBeenCalledWith(
      'demo', ['ui.sidebar', 'workspace.read'], undefined, '1.0.0',
    );
  });

  it('skips bundles whose manifest name mismatches the directory', async () => {
    writeBundle(root, 'dir-name', MANIFEST('other-name'), { 'panel.html': 'x' });
    const loader = new PluginHostLoader(makeTrustStore(), root);
    expect(await loader.loadAll()).toEqual([]);
    expect(loader.listFailures()[0].errors[0]).toMatch(/does not match directory/);
  });

  it('rejects unknown capabilities through the shared grammar', async () => {
    writeBundle(root, 'bad-cap', {
      ...MANIFEST('bad-cap'),
      capabilities: ['ui.sidebar', 'filesystem.everything'],
    }, { 'panel.html': 'x' });
    const loader = new PluginHostLoader(makeTrustStore(), root);
    expect(await loader.loadAll()).toEqual([]);
    expect(loader.listFailures()[0].errors[0]).toMatch(/unknown capability/);
  });

  it('rejects contributions whose ui capability was not declared', async () => {
    writeBundle(root, 'no-cap', {
      ...MANIFEST('no-cap'),
      capabilities: ['workspace.read'],
    }, { 'panel.html': 'x' });
    const loader = new PluginHostLoader(makeTrustStore(), root);
    expect(await loader.loadAll()).toEqual([]);
    expect(loader.listFailures()[0].errors[0]).toMatch(/undeclared capabilities: ui\.sidebar/);
  });

  it('rejects bundles whose contribution entry file is missing', async () => {
    writeBundle(root, 'no-entry', MANIFEST('no-entry')); // panel.html absent
    const loader = new PluginHostLoader(makeTrustStore(), root);
    expect(await loader.loadAll()).toEqual([]);
    expect(loader.listFailures()[0].errors[0]).toMatch(/entry not found/);
  });

  it('one broken bundle does not block the others', async () => {
    writeBundle(root, 'good', MANIFEST('good'), { 'panel.html': 'x' });
    fs.mkdirSync(path.join(root, 'broken'));
    fs.writeFileSync(path.join(root, 'broken', 'manifest.json'), '{not json');
    const loader = new PluginHostLoader(makeTrustStore(), root);
    const loaded = await loader.loadAll();
    expect(loaded.map((p) => p.manifest.name)).toEqual(['good']);
    expect(loader.listFailures().map((f) => f.name)).toEqual(['broken']);
  });

  describe('resolveBundlePath (protocol containment gate)', () => {
    it('resolves files inside the bundle and rejects escapes', async () => {
      writeBundle(root, 'demo', MANIFEST('demo'), {
        'panel.html': 'x',
        'assets/app.js': 'x',
      });
      fs.writeFileSync(path.join(root, 'outside.txt'), 'secret');
      const loader = new PluginHostLoader(makeTrustStore(), root);
      await loader.loadAll();

      const ok = loader.resolveBundlePath('demo', '/assets/app.js');
      expect(ok && fs.existsSync(ok)).toBe(true);

      expect(loader.resolveBundlePath('demo', '/../outside.txt')).toBeNull();
      expect(loader.resolveBundlePath('demo', '/a/../../outside.txt')).toBeNull();
      expect(loader.resolveBundlePath('demo', '/a\0b')).toBeNull();
      expect(loader.resolveBundlePath('demo', '/')).toBeNull();
      // Unknown plugin name never resolves, even to a real directory.
      expect(loader.resolveBundlePath('outside.txt', '/panel.html')).toBeNull();
    });
  });

  it('summaries carry the live trust status', async () => {
    const store = makeTrustStore({ demo: { status: 'trusted' } });
    writeBundle(root, 'demo', MANIFEST('demo'), { 'panel.html': 'x' });
    const loader = new PluginHostLoader(store, root);
    await loader.loadAll();
    const summaries = await loader.summaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].trustStatus).toBe('trusted');
    expect(summaries[0].contributes.sidebar?.title).toBe('Demo');
  });
});
