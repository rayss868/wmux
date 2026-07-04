import { describe, it, expect } from 'vitest';
import { normalizeDevServerUrl } from '../createWindow';

// electron-forge injects the dev-server URL as http://localhost:5173/, but Vite
// binds 127.0.0.1 (IPv4). On macOS `localhost` resolves to ::1 (IPv6) first, so
// loading the localhost form gives a blank, flickering window. The normalizer
// rewrites the loopback host to 127.0.0.1 so the loaded URL matches the bind.
describe('normalizeDevServerUrl', () => {
  it('rewrites localhost to 127.0.0.1 (host + port + path preserved)', () => {
    expect(normalizeDevServerUrl('http://localhost:5173/')).toBe('http://127.0.0.1:5173/');
  });

  it('preserves a path and query on the dev URL', () => {
    expect(normalizeDevServerUrl('http://localhost:5173/index.html?x=1')).toBe(
      'http://127.0.0.1:5173/index.html?x=1',
    );
  });

  it('leaves an explicit 127.0.0.1 URL untouched', () => {
    expect(normalizeDevServerUrl('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173/');
  });

  it('leaves a real host / --host override untouched (only localhost is rewritten)', () => {
    expect(normalizeDevServerUrl('http://192.168.1.20:5173/')).toBe('http://192.168.1.20:5173/');
  });

  it('passes undefined through (production loadFile path)', () => {
    expect(normalizeDevServerUrl(undefined)).toBeUndefined();
  });

  it('returns an unparseable value unchanged instead of throwing', () => {
    expect(normalizeDevServerUrl('not a url')).toBe('not a url');
  });
});
