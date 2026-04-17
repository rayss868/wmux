#!/usr/bin/env node
/**
 * wmux-a2a — Agent-to-Agent MCP Server
 *
 * Provides structured inter-agent communication for wmux Company Mode.
 * Agents use MCP tool calls instead of text pattern matching.
 *
 * Tools:
 *   a2a_whoami    — Identify this agent (workspace → member)
 *   a2a_send      — Send a message to another agent by name
 *   a2a_broadcast — Broadcast to all agents
 *   a2a_inbox     — Read incoming messages (poll)
 *   a2a_ack       — Acknowledge (mark read) inbox messages
 *   a2a_status    — Get company-wide agent status
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sendRpc } from '../../mcp/wmux-client';
import type { RpcMethod } from '../../shared/rpc';
import { readFileSync } from 'fs';
import { join } from 'path';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Workspace identity — set by PTY env var when running inside wmux.
// If empty, resolved lazily on first A2A call via a2a.resolve.identity RPC.
let MY_WORKSPACE_ID = process.env.WMUX_WORKSPACE_ID || '';
let workspaceResolved = !!MY_WORKSPACE_ID;

const server = new McpServer({
  name: 'wmux-a2a',
  version: getVersion(),
});

async function callRpc(
  method: RpcMethod,
  params: Record<string, unknown> = {},
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const result = await sendRpc(method, params);
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: 'text', text }] };
}

async function resolveWorkspaceId(): Promise<string> {
  if (MY_WORKSPACE_ID && workspaceResolved) return MY_WORKSPACE_ID;

  try {
    const result = await sendRpc('a2a.resolve.identity' as RpcMethod, {});
    const { mappings } = result as { mappings: Record<string, string> };
    if (!mappings || Object.keys(mappings).length === 0) return MY_WORKSPACE_ID;

    const knownPids = new Map<number, string>();
    for (const [pidStr, wsId] of Object.entries(mappings)) {
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) knownPids.set(pid, wsId);
    }

    let currentPid = process.ppid;
    for (let depth = 0; depth < 10; depth++) {
      const wsId = knownPids.get(currentPid);
      if (wsId) {
        MY_WORKSPACE_ID = wsId;
        workspaceResolved = true;
        return MY_WORKSPACE_ID;
      }
      const parentPid = await getParentPid(currentPid);
      if (!parentPid || parentPid === currentPid || parentPid <= 1) break;
      currentPid = parentPid;
    }
  } catch { /* resolve failed */ }

  return MY_WORKSPACE_ID;
}

async function getParentPid(pid: number): Promise<number | null> {
  try {
    const { execFileSync } = await import('child_process');
    if (process.platform === 'win32') {
      const path = await import('path');
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const out = execFileSync(ps, [
        '-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const parsed = parseInt(out.trim(), 10);
      return isNaN(parsed) ? null : parsed;
    } else {
      const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
      return parseInt(out.trim(), 10) || null;
    }
  } catch {
    return null;
  }
}

async function requireWorkspaceId(): Promise<string> {
  const wsId = await resolveWorkspaceId();
  if (!wsId) {
    throw new Error(
      'Workspace identity unknown. Make sure you are running inside a wmux terminal workspace.'
    );
  }
  return wsId;
}

// ── a2a_whoami ──────────────────────────────────────────────────────────────

server.tool(
  'a2a_whoami',
  'Identify who you are in the company hierarchy. Returns your name, role, department, and status.',
  {},
  async () => {
    const wsId = await requireWorkspaceId();
    return callRpc('company.a2a.whoami', { workspaceId: wsId });
  },
);

// ── a2a_send ────────────────────────────────────────────────────────────────

server.tool(
  'a2a_send',
  'Send a structured message to another agent by name. ' +
  'Resolves target by: department name → lead, exact member name, or "CEO". ' +
  'Returns delivery status (delivered/queued).',
  {
    to: z.string().describe('Target agent name, department name, or "CEO"'),
    message: z.string().describe('Message content'),
    from: z.string().optional().describe('Sender name (auto-detected if omitted)'),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('Message priority (default: normal)'),
  },
  async ({ to, message, from, priority }) => {
    const wsId = await requireWorkspaceId();
    let senderName = from;
    if (!senderName) {
      try {
        const whoami = await sendRpc('company.a2a.whoami', { workspaceId: wsId }) as { name?: string } | null;
        senderName = whoami?.name;
      } catch { /* use fallback */ }
    }
    return callRpc('company.a2a.send', {
      from: senderName || 'Agent',
      to,
      message,
      priority: priority || 'normal',
      workspaceId: wsId,
    });
  },
);

// ── a2a_broadcast ───────────────────────────────────────────────────────────

server.tool(
  'a2a_broadcast',
  'Broadcast a message to ALL agents in the company. Use sparingly.',
  {
    message: z.string().describe('Broadcast message content'),
    from: z.string().optional().describe('Sender name (auto-detected if omitted)'),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('Message priority'),
  },
  async ({ message, from, priority }) => {
    const wsId = await requireWorkspaceId();
    let senderName = from;
    if (!senderName) {
      try {
        const whoami = await sendRpc('company.a2a.whoami', { workspaceId: wsId }) as { name?: string } | null;
        senderName = whoami?.name;
      } catch { /* use fallback */ }
    }
    return callRpc('company.a2a.broadcast', {
      from: senderName || 'Agent',
      message,
      priority: priority || 'normal',
      workspaceId: wsId,
    });
  },
);

// ── a2a_inbox ───────────────────────────────────────────────────────────────

server.tool(
  'a2a_inbox',
  'Check your inbox for incoming messages from other agents. ' +
  'Returns messages with IDs — use a2a_ack to mark them as read.',
  {
    unread_only: z.boolean().optional().describe('Only return unread messages (default: true)'),
  },
  async ({ unread_only }) =>
    callRpc('company.a2a.inbox', {
      workspaceId: await requireWorkspaceId(),
      unreadOnly: unread_only !== false,
    }),
);

// ── a2a_ack ─────────────────────────────────────────────────────────────────

server.tool(
  'a2a_ack',
  'Acknowledge (mark as read) inbox messages by their IDs.',
  {
    message_ids: z.array(z.string()).describe('Array of message IDs to acknowledge'),
  },
  async ({ message_ids }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('company.a2a.ack', {
      workspaceId: wsId,
      messageIds: message_ids,
    });
  },
);

// ── a2a_status ──────────────────────────────────────────────────────────────

server.tool(
  'a2a_status',
  'Get the current company status: all departments, members, their roles, and online status. ' +
  'Use this to discover who you can communicate with.',
  {},
  async () => callRpc('company.a2a.status'),
);

// ── Start server ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => { process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('wmux-a2a MCP server failed to start:', err);
  process.exit(1);
});
