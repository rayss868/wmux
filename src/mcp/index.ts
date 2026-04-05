#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sendRpc } from './wmux-client';
import type { RpcMethod } from '../shared/rpc';
import { PlaywrightEngine } from './playwright/PlaywrightEngine';
import { registerNavigationTools } from './playwright/tools/navigation';
import { registerInteractionTools } from './playwright/tools/interaction';
import { registerInspectionTools } from './playwright/tools/inspection';
import { registerStateTools } from './playwright/tools/state';
import { registerWaitTools } from './playwright/tools/wait';
import { registerFileTools } from './playwright/tools/file';
import { registerUtilityTools } from './playwright/tools/utility';
import { registerExtractionTools } from './playwright/tools/extraction';
import { readFileSync } from 'fs';
import { join } from 'path';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Workspace identity — set by PTY env var when running inside wmux.
// If empty, resolved lazily on first A2A call via a2a.whoami RPC.
let MY_WORKSPACE_ID = process.env.WMUX_WORKSPACE_ID || '';
let workspaceResolved = !!MY_WORKSPACE_ID;

const server = new McpServer({
  name: 'wmux',
  version: getVersion(),
});

// Helper: wrap an RPC call as an MCP tool result
async function callRpc(
  method: RpcMethod,
  params: Record<string, unknown> = {},
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const result = await sendRpc(method, params);
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: 'text', text }] };
}

/**
 * Resolve workspace identity by:
 * 1. Getting PID→workspaceId mappings from main process via RPC
 * 2. Walking our process tree upward to find a matching PTY PID
 *
 * Process chain: MCP server → Claude Code → shell(PTY)
 * The PTY shell PID is in the mapping, so we need to go up ~2 levels.
 */
async function resolveWorkspaceId(): Promise<string> {
  if (MY_WORKSPACE_ID && workspaceResolved) return MY_WORKSPACE_ID;

  try {
    // Get PID→workspaceId mappings from main process
    const result = await sendRpc('a2a.resolve.identity' as RpcMethod, {});
    const { mappings } = result as { mappings: Record<string, string> };
    if (!mappings || Object.keys(mappings).length === 0) return MY_WORKSPACE_ID;

    const knownPids = new Map<number, string>();
    for (const [pidStr, wsId] of Object.entries(mappings)) {
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) knownPids.set(pid, wsId);
    }

    // Walk process tree upward: MCP server → Claude Code → shell(PTY)
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
  } catch { /* resolve failed, fall through */ }

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

/**
 * Get workspace ID, requiring it for A2A operations.
 * Throws a user-friendly error if identity cannot be determined.
 */
async function requireWorkspaceId(): Promise<string> {
  const wsId = await resolveWorkspaceId();
  if (!wsId) {
    throw new Error(
      'Workspace identity unknown. This MCP server cannot determine which workspace it belongs to. ' +
      'Make sure you are running inside a wmux terminal workspace.'
    );
  }
  return wsId;
}

// === Browser tools (RPC-based: surface management stays in main process) ===

server.tool(
  'browser_open',
  'Open a new browser panel in the active pane. Use this when no browser surface exists yet.',
  {
    url: z.string().optional().describe('Initial URL to load (defaults to google.com)'),
  },
  async ({ url }) =>
    callRpc('browser.open', url ? { url } : {}),
);

server.tool(
  'browser_close',
  'Close the browser panel in the active pane',
  {
    surfaceId: z.string().optional().describe('Target a specific surface by ID. Omit to use the active surface.'),
  },
  async ({ surfaceId }) => callRpc('browser.close', surfaceId ? { surfaceId } : {}),
);

// === Playwright browser tools ===
registerNavigationTools(server);
registerInteractionTools(server);
registerInspectionTools(server);
registerStateTools(server);
registerWaitTools(server);
registerFileTools(server);
registerUtilityTools(server);
registerExtractionTools(server);

// === Browser session tools ===

server.tool(
  'browser_session_start',
  'Start a browser session with the specified profile',
  {
    profile: z.string().optional().describe('Profile name to use (defaults to "default")'),
  },
  async ({ profile }) =>
    callRpc('browser.session.start', profile ? { profile } : {}),
);

server.tool(
  'browser_session_stop',
  'Stop the current browser session',
  {},
  async () => callRpc('browser.session.stop'),
);

server.tool(
  'browser_session_status',
  'Get current browser session status',
  {},
  async () => callRpc('browser.session.status'),
);

server.tool(
  'browser_session_list',
  'List available browser profiles',
  {},
  async () => callRpc('browser.session.list'),
);

// === Terminal tools ===

server.tool(
  'terminal_read',
  'Read the current visible text from the active terminal in wmux',
  {},
  async () => callRpc('input.readScreen'),
);

server.tool(
  'terminal_send',
  'Send text to YOUR OWN active terminal only. To send messages to OTHER workspaces, use a2a_task_send or a2a_broadcast instead.',
  { text: z.string().describe('Text to send to the terminal') },
  async ({ text }) => callRpc('input.send', { text }),
);

server.tool(
  'terminal_send_key',
  'Send a named key to the active terminal (enter, tab, ctrl+c, ctrl+d, ctrl+z, ctrl+l, escape, up, down, right, left)',
  {
    key: z.string().describe(
      'Key name: enter, tab, ctrl+c, ctrl+d, ctrl+z, ctrl+l, escape, up, down, right, left',
    ),
  },
  async ({ key }) => callRpc('input.sendKey', { key }),
);

// === Workspace tools ===

server.tool(
  'workspace_list',
  'List all workspaces in wmux',
  {},
  async () => callRpc('workspace.list'),
);

server.tool(
  'surface_list',
  'List all surfaces (terminals and browsers) in the active workspace',
  {},
  async () => callRpc('surface.list'),
);

server.tool(
  'pane_list',
  'List all panes in the current workspace',
  {},
  async () => callRpc('pane.list'),
);

// === A2A (Agent-to-Agent) tools ===

// 1. a2a_whoami — Identify this workspace
server.tool(
  'a2a_whoami',
  'Returns this workspace\'s identity (name, ID, metadata). Call this if you are unsure which workspace you are in.',
  {},
  async () => {
    const wsId = await requireWorkspaceId();
    return callRpc('a2a.whoami', { workspaceId: wsId });
  },
);

// 2. a2a_discover — Agent Card discovery
server.tool(
  'a2a_discover',
  'List all available workspaces/agents and their names. ALWAYS call this first when the user references a workspace by number or name (e.g. "3번", "Workspace 1") so you know valid targets.',
  {},
  async () => callRpc('a2a.discover'),
);

// 3. send_message — Primary tool for inter-workspace communication
const sendMessageHandler = async ({ to, title, task_id, message, execute, data, data_mime_type }: {
  to?: string; title?: string; task_id?: string; message: string; execute?: boolean;
  data?: Record<string, unknown>; data_mime_type?: string;
}) => {
  const wsId = await requireWorkspaceId();
  const params: Record<string, unknown> = {
    workspaceId: wsId,
    message,
  };
  if (task_id) params.taskId = task_id;
  if (to) params.to = to;
  if (title) params.title = title;
  if (execute) params.execute = true;
  if (data) {
    params.data = data;
    params.dataMimeType = data_mime_type || 'application/json';
  }
  return callRpc('a2a.task.send', params);
};

const sendMessageParams = {
  to: z.string().optional().describe('Target: workspace number (1, 2, 3), name ("Workspace 1"), or ID'),
  title: z.string().optional().describe('Short title for the message'),
  task_id: z.string().optional().describe('Reply to existing task ID'),
  message: z.string().describe('Message to send'),
  execute: z.boolean().optional().describe('Set true to run as background task (Claude executes the request). Default: false (just delivers the message)'),
  data: z.record(z.string(), z.unknown()).optional().describe('Optional structured data (JSON)'),
  data_mime_type: z.string().optional().describe('MIME type for data (default: application/json)'),
};

server.tool(
  'send_message',
  'Send a message to another workspace. Use when asked to talk to, greet, or send anything to workspace 1/2/3 etc. Accepts number ("1", "3번"), name ("Workspace 2"), or ID.',
  sendMessageParams,
  sendMessageHandler,
);

// Keep a2a_task_send as alias for backward compatibility
server.tool('a2a_task_send', 'Alias for send_message.', sendMessageParams, sendMessageHandler);

// 4. a2a_task_query — Query tasks by status/role
server.tool(
  'a2a_task_query',
  'Query tasks assigned to you or sent by you. Filter by status and role.',
  {
    status: z.enum(['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled']).optional().describe('Filter by task status'),
    role: z.enum(['user', 'agent']).optional().describe('Filter: "user" = tasks you sent, "agent" = tasks assigned to you'),
  },
  async ({ status, role }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('a2a.task.query', { workspaceId: wsId, status, role });
  },
);

// 5. a2a_task_update — Update task status
server.tool(
  'a2a_task_update',
  'Update a task\'s status. Only the receiver can change to working/completed/failed/input-required. Optionally attach artifacts on completion.',
  {
    task_id: z.string().describe('Task ID to update'),
    status: z.enum(['working', 'completed', 'failed', 'input-required']).describe('New status'),
    message: z.string().optional().describe('Optional status message'),
    artifact_name: z.string().optional().describe('Artifact name (for completed tasks)'),
    artifact_data: z.record(z.string(), z.unknown()).optional().describe('Artifact data payload'),
  },
  async ({ task_id, status, message, artifact_name, artifact_data }) => {
    const wsId = await requireWorkspaceId();
    const params: Record<string, unknown> = { workspaceId: wsId, taskId: task_id, status };
    if (message) params.message = message;
    if (artifact_name) {
      params.artifact = {
        name: artifact_name,
        parts: artifact_data ? [{ kind: 'data', data: artifact_data, metadata: { mimeType: 'application/json' } }] : [],
      };
    }
    return callRpc('a2a.task.update', params);
  },
);

// 6. a2a_task_cancel — Cancel a task you sent
server.tool(
  'a2a_task_cancel',
  'Cancel a task you previously sent. Only the original sender can cancel.',
  {
    task_id: z.string().describe('Task ID to cancel'),
    reason: z.string().optional().describe('Cancellation reason'),
  },
  async ({ task_id, reason }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('a2a.task.cancel', { workspaceId: wsId, taskId: task_id, reason });
  },
);

// 7. a2a_broadcast — Broadcast notification to all workspaces
server.tool(
  'a2a_broadcast',
  'Send a message to ALL other workspaces at once (e.g. announcements, greetings). For targeted messages, use a2a_task_send instead.',
  {
    message: z.string().describe('Broadcast message'),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('Priority level'),
  },
  async ({ message, priority }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('a2a.broadcast', { message, priority: priority || 'normal', workspaceId: wsId });
  },
);

// 8. a2a_set_skills — Register agent capabilities
server.tool(
  'a2a_set_skills',
  'Register your agent capabilities/skills so other agents can discover you via a2a_discover.',
  {
    skills: z.array(z.string()).describe('List of skill tags (e.g., ["frontend", "testing", "devops"])'),
    description: z.string().optional().describe('Short description of what this agent does'),
  },
  async ({ skills, description }) => {
    const wsId = await requireWorkspaceId();
    return callRpc('meta.setSkills', { workspaceId: wsId, skills, description });
  },
);

// === Start server ===

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Clean up Playwright connection when transport closes
  transport.onclose = async () => {
    console.log('[wmux-mcp] Transport closed, disconnecting Playwright');
    await PlaywrightEngine.getInstance().disconnect();
  };

  // Graceful shutdown
  const shutdown = async () => {
    await PlaywrightEngine.getInstance().disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('wmux MCP server failed to start:', err);
  process.exit(1);
});
