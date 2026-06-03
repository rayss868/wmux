import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level invariant lock for MCP workspace routing.
//
// Bug (2026-06-03 — "called browser_open in workspace 2, browser opened in
// workspace 1"): browser_open and browser_session_start used the weak
// resolveWorkspaceId(), which returns '' on a resolve miss instead of throwing.
// The empty id was then dropped by `...(workspaceId && { workspaceId })` across
// THREE layers — the MCP tool (src/mcp/index.ts), the main RPC handler
// (src/main/pipe/handlers/browser.rpc.ts), and finally the renderer
// (src/renderer/hooks/useRpcBridge.ts) fell back to `store.activeWorkspaceId`,
// opening the browser in the UI-active workspace rather than the calling one.
//
// Every OTHER workspace-routed tool uses requireWorkspaceId(), which THROWS on a
// miss, so it can never silently route to the wrong workspace. These invariants
// pin that contract: a future tool that reaches for the weak resolver breaks the
// build instead of the user's routing.
describe('MCP workspace routing (source-level invariants)', () => {
  const indexPath = path.join(__dirname, '..', 'index.ts');
  const src = fs.readFileSync(indexPath, 'utf-8');

  // Slice a single server.tool(...) block by its quoted name, bounded by the
  // next server.tool( call (or a fixed window for the last one).
  function toolBlock(toolName: string): string {
    const start = src.indexOf(`'${toolName}'`);
    expect(start).toBeGreaterThan(0);
    const next = src.indexOf('server.tool(', start + toolName.length);
    return src.slice(start, next > start ? next : start + 800);
  }

  it('only requireWorkspaceId() may CALL the weak resolveWorkspaceId() — exactly one call site', () => {
    // requireWorkspaceId is the single sanctioned caller: it throws when the
    // resolver returns falsy. Any tool handler that calls resolveWorkspaceId()
    // directly can silently fall back to the active workspace on a miss — the
    // exact bug. `resolveWorkspaceId` passed by REFERENCE (resolveDefaultPtyId
    // deps) has no parens and is intentionally excluded by the `()` in the regex.
    const directCalls = src.match(/resolveWorkspaceId\(\)/g) ?? [];
    expect(directCalls).toHaveLength(1);
  });

  it('browser_open routes through requireWorkspaceId, never the weak resolver', () => {
    const block = toolBlock('browser_open');
    expect(block).toMatch(/requireWorkspaceId\(\)/);
    expect(block).not.toMatch(/resolveWorkspaceId\(\)/);
  });

  it('browser_session_start routes through requireWorkspaceId, never the weak resolver', () => {
    const block = toolBlock('browser_session_start');
    expect(block).toMatch(/requireWorkspaceId\(\)/);
    expect(block).not.toMatch(/resolveWorkspaceId\(\)/);
  });
});
