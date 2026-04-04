// ─── Company Agent Provisioner ────────────────────────────────────────────────
// Ported from wmux-max: spawnAgentWorkspace, waitForClaudeReady, prompt injection.
// Creates workspace → PTY → runs Claude → waits for ready → injects role prompt.

import { useStore } from '../../renderer/stores';
import { createSurface, createLeafPane, generateId, sanitizePtyText } from '../../shared/types';
import type { AgentPreset } from '../types';

// ─── Wait for Claude CLI ready ───────────────────────────────────────────────

function waitForClaudeReady(ptyId: string, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    let cleanup: (() => void) | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let dataReceived = 0;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (cleanup) cleanup();
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    };

    cleanup = window.electronAPI.pty.onData((id, data) => {
      if (id !== ptyId || resolved) return;
      dataReceived++;
      // Skip first few data chunks (shell startup, PS1 prompt containing ">")
      // Claude's ready indicator appears after the CLI banner/loading
      if (dataReceived <= 2) return;
      if (data.includes('\u276F') || data.includes('Claude') || data.includes('claude') || data.includes('>')) {
        finish();
        setTimeout(resolve, 500);
      }
    });

    fallbackTimer = setTimeout(() => {
      finish();
      resolve();
    }, timeoutMs);
  });
}

// ─── Core: spawn a single agent workspace ────────────────────────────────────

export async function spawnAgentWorkspace(
  label: string,
  command?: string,
  companyRole?: 'ceo' | 'lead' | 'member',
  companyDeptName?: string,
  initialPrompt?: string,
  cwd?: string,
  workUnit?: import('../types').WorkUnit,
): Promise<{ workspaceId: string; ptyId: string; paneId: string }> {
  // 1. Create PTY
  const { id: ptyId } = await window.electronAPI.pty.create(cwd ? { cwd } : undefined);

  // 2. Build workspace with surface
  const surface = createSurface(ptyId, 'Terminal', cwd || '');
  const rootPane = createLeafPane(surface);
  const workspaceId = generateId('ws');

  // 3. Add workspace to store
  useStore.setState((state) => {
    state.workspaces.push({
      id: workspaceId,
      name: label,
      rootPane,
      activePaneId: rootPane.id,
      companyRole,
      companyDeptName,
    });
  });

  // 4. Send startup command
  if (command) {
    await window.electronAPI.pty.write(ptyId, sanitizePtyText(command) + '\r');
  }

  // 5. Wait for Claude ready, then inject prompt (with optional scope enforcement)
  if (initialPrompt) {
    let prompt = initialPrompt;
    if (workUnit) {
      const scopeLines = [
        `\n[FILE SCOPE ENFORCEMENT]`,
        `You may ONLY modify these files: ${workUnit.ownedFiles.join(', ')}`,
        workUnit.forbiddenFiles.length > 0
          ? `You must NOT modify these files: ${workUnit.forbiddenFiles.join(', ')}`
          : '',
        `All other files are read-only. Violations will be caught by pre-commit hook.`,
      ].filter(Boolean);
      prompt += scopeLines.join('\n');
    }
    await waitForClaudeReady(ptyId);
    await window.electronAPI.pty.write(ptyId, sanitizePtyText(prompt) + '\r');
  }

  return { workspaceId, ptyId, paneId: rootPane.id };
}

// ─── Spawn entire company from template ──────────────────────────────────────

export interface SpawnCompanyOpts {
  companyName: string;
  skipPermissions: boolean;
  workDir?: string;
  departments: {
    name: string;
    leadName: string;
    members: { name: string; preset: AgentPreset | string; customAgentPath?: string }[];
  }[];
}

export async function spawnCompany(opts: SpawnCompanyOpts): Promise<void> {
  const { companyName, skipPermissions, workDir, departments } = opts;
  const permFlag = skipPermissions ? ' --dangerously-skip-permissions' : '';
  const cwdArg = workDir || undefined;

  // Store is already populated by the caller (handleConfirm).
  // This function only spawns PTYs and injects prompts.
  const g = useStore.getState;

  // ── Build org chart for prompts ──
  const orgLines = departments.map(
    (d) => `[${d.name}] Lead: ${d.leadName} / Members: ${d.members.map((m) => `${m.name}(${m.preset})`).join(', ')}`,
  );
  const orgChart = orgLines.join(' | ') || 'No departments yet';

  // ── Phase 3: Spawn CEO ──
  try {
    const ceoPrompt = [
      `You are the CEO of "${companyName}".`,
      `Organization: ${orgChart}.`,
      `Your job: 1) Assign tasks to department leads. 2) Review results from leads. 3) Make final decisions.`,
      `Communication: Use the wmux CLI tool (Bash) to send messages:`,
      `- Send task: wmux company message --from "CEO" --to "DeptName" "task description"`,
      `- Broadcast: wmux company message --from "CEO" --broadcast "announcement"`,
      `- You will RECEIVE messages in your terminal as "━━━ WMUX MESSAGE ━━━" blocks.`,
      `- When leads request approval, respond via: wmux company message --from "CEO" --to "DeptName" "APPROVED" or "REJECTED: reason"`,
      `IMPORTANT: Always use the wmux CLI to send messages. Do NOT output [WMUX-MSG] text directly.`,
    ].join(' ');

    const { workspaceId: ceoWsId } = await spawnAgentWorkspace(
      `${companyName} — CEO`, `claude${permFlag}`, 'ceo', undefined, ceoPrompt, cwdArg,
    );
    g().setCeoWorkspace(ceoWsId);
  } catch (err) {
    console.error('[company] Failed to spawn CEO:', err);
  }

  // ── Phase 4: Spawn leads and members (each wrapped in try-catch) ──
  for (const dept of departments) {
    const memberNames = dept.members.map((m) => `${m.name}(${m.preset})`).join(', ');
    const otherDepts = departments.filter((d) => d.name !== dept.name).map((d) => d.name).join(', ') || 'none';

    // Find the stored department
    const deptObj = g().company?.departments.find((d) => d.name === dept.name);
    if (!deptObj) continue;

    // ── Spawn Lead ──
    try {
      const leadPrompt = [
        `You are the ${dept.leadName.replace(/-/g, ' ')}, leading the ${dept.name} department of "${companyName}".`,
        `Your team members: ${memberNames}.`,
        `Other departments: ${otherDepts}.`,
        `Communication: Use the wmux CLI tool (Bash) to send messages:`,
        `- Assign task to member: wmux company message --from "${dept.name} Lead" --to "MemberName" "task"`,
        `- Report to CEO: wmux company message --from "${dept.name}" --to "CEO" "result summary"`,
        `- You RECEIVE messages as "━━━ WMUX MESSAGE ━━━" blocks in your terminal.`,
        `Members run in plan mode — review their plans and approve before they execute.`,
        `Workflow: 1) Receive CEO task. 2) Decompose into subtasks. 3) Assign via wmux CLI. 4) Review member plans. 5) Consolidate and report to CEO.`,
        `IMPORTANT: Always use the wmux CLI to send messages. Do NOT output [WMUX-MSG] text directly.`,
      ].join(' ');

      const { workspaceId: leadWsId, ptyId: leadPtyId } = await spawnAgentWorkspace(
        `${dept.name} — ${dept.leadName}`, `claude --teammate-mode auto${permFlag}`, 'lead', dept.name, leadPrompt, cwdArg,
      );

      const lead = g().company?.departments.find((d) => d.id === deptObj.id)?.members.find((m) => m.id === deptObj.leadId);
      if (lead) {
        g().setMemberWorkspace(lead.id, leadWsId);
        g().setMemberPty(lead.id, leadPtyId);
      }
    } catch (err) {
      console.error(`[company] Failed to spawn lead for ${dept.name}:`, err);
      const lead = g().company?.departments.find((d) => d.id === deptObj.id)?.members.find((m) => m.id === deptObj.leadId);
      if (lead) g().updateMemberStatus(lead.id, 'error', String(err));
    }

    // ── Spawn Members (match by name, not index) ──
    for (const mem of dept.members) {
      const freshDept = g().company?.departments.find((d) => d.id === deptObj.id);
      const storedMember = freshDept?.members.find((m) => m.name === mem.name && m.id !== freshDept.leadId);
      if (!storedMember) { console.warn(`Member "${mem.name}" not found in store, skipping spawn`); continue; }

      try {
        const teammates = dept.members.filter((m2) => m2.name !== mem.name).map((m2) => `${m2.name}(${m2.preset})`).join(', ') || 'none';
        const memPrompt = [
          `You are ${mem.name}, the ${mem.preset.replace(/-/g, ' ')} in the ${dept.name} department of "${companyName}".`,
          `Your lead: ${dept.leadName}. Your teammates: ${teammates}.`,
          `Communication: Use the wmux CLI tool (Bash) to send messages:`,
          `- Report completion: wmux company message --from "${mem.name}" --to "${dept.name} Lead" "DONE: summary"`,
          `- Report blockers: wmux company message --from "${mem.name}" --to "${dept.name} Lead" "BLOCKED: reason"`,
          `- You RECEIVE tasks as "━━━ WMUX MESSAGE ━━━" blocks in your terminal.`,
          `You are in PLAN MODE. Create a plan first, then wait for your lead to approve before executing.`,
          `IMPORTANT: Always use the wmux CLI to send messages. Do NOT output [WMUX-MSG] text directly.`,
        ].join(' ');

        const { workspaceId: memWsId, ptyId: memPtyId } = await spawnAgentWorkspace(
          `${dept.name} — ${mem.name}`, `claude --teammate-mode auto${permFlag}`, 'member', dept.name, memPrompt, cwdArg,
        );

        g().setMemberWorkspace(storedMember.id, memWsId);
        g().setMemberPty(storedMember.id, memPtyId);

        setTimeout(() => {
          void window.electronAPI.pty.write(memPtyId, '/plan\r');
        }, 8000);
      } catch (err) {
        console.error(`[company] Failed to spawn member ${mem.name}:`, err);
        g().updateMemberStatus(storedMember.id, 'error', String(err));
      }
    }
  }
}

// ─── Spawn a single member (for adding after company creation) ───────────────

export async function spawnMember(
  companyName: string,
  deptName: string,
  leadName: string,
  memberName: string,
  preset: string,
  skipPermissions: boolean,
  workDir?: string,
): Promise<{ workspaceId: string; ptyId: string }> {
  const permFlag = skipPermissions ? ' --dangerously-skip-permissions' : '';
  const cwdArg = workDir || undefined;

  const s = useStore.getState();
  const dept = s.company?.departments.find((d) => d.name === deptName);
  const teammates = dept?.members
    .filter((m) => m.name !== memberName && m.id !== dept?.leadId)
    .map((m) => m.name).join(', ') || 'none';

  const rolePrompt = [
    `You are ${memberName}, the ${preset.replace(/-/g, ' ')} in the ${deptName} department of "${companyName}".`,
    `Your lead: ${leadName}. Your teammates: ${teammates}.`,
    `Communication: Use the wmux CLI tool (Bash) to send messages:`,
    `- Report completion: wmux company message --from "${memberName}" --to "${leadName}" "DONE: summary"`,
    `- Report blockers: wmux company message --from "${memberName}" --to "${leadName}" "BLOCKED: reason"`,
    `- You RECEIVE tasks as "━━━ WMUX MESSAGE ━━━" blocks in your terminal.`,
    `You are in PLAN MODE. Create a plan first, then wait for your lead to approve before executing.`,
    `IMPORTANT: Always use the wmux CLI. Do NOT output [WMUX-MSG] text directly.`,
  ].join(' ');

  const { workspaceId, ptyId } = await spawnAgentWorkspace(
    `${deptName} — ${memberName}`, `claude --teammate-mode auto${permFlag}`, 'member', deptName, rolePrompt, cwdArg,
  );

  // Enter plan mode after 8s
  setTimeout(() => {
    void window.electronAPI.pty.write(ptyId, '/plan\r');
  }, 8000);

  return { workspaceId, ptyId };
}

// ─── Destroy company: dispose all PTYs then clean store ──────────────────────

export function destroyCompanyWithCleanup(): void {
  const state = useStore.getState();
  const company = state.company;
  if (!company) return;

  // Collect all PTY IDs (members + CEO workspace)
  const ptyIds: string[] = [];
  for (const dept of company.departments) {
    for (const m of dept.members) {
      if (m.ptyId) ptyIds.push(m.ptyId);
    }
  }

  // Also dispose CEO workspace PTY
  if (company.ceoWorkspaceId) {
    const ceoWs = state.workspaces.find((ws) => ws.id === company.ceoWorkspaceId);
    if (ceoWs) {
      const leaves = collectLeafSurfaces(ceoWs.rootPane);
      for (const ptyId of leaves) {
        if (!ptyIds.includes(ptyId)) ptyIds.push(ptyId);
      }
    }
  }

  // Dispose all PTYs (fire-and-forget, errors ignored)
  for (const ptyId of ptyIds) {
    window.electronAPI.pty.dispose(ptyId).catch(() => { /* ignore dispose errors */ });
  }
  console.log(`[company] Destroyed: disposed ${ptyIds.length} PTYs`);

  // Clean store
  state.destroyCompany();
}

/** Collect all ptyIds from a pane tree. */
function collectLeafSurfaces(pane: import('../../shared/types').Pane): string[] {
  if (pane.type === 'leaf') return pane.surfaces.map((s) => s.ptyId).filter(Boolean);
  return pane.children.flatMap(collectLeafSurfaces);
}
