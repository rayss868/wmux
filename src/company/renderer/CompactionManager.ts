/**
 * CompactionManager — detects when agent sessions need context compaction
 * and generates state snapshots for recovery after compaction.
 * Runs in the renderer process, evaluates triggers periodically.
 */

import type { CompactionSnapshot, TeamMember } from '../types';

// ── Trigger thresholds ──
const TURN_THRESHOLD = 40;
const SUSTAINED_WORK_MS = 20 * 60 * 1000; // 20 minutes

export interface CompactionTrigger {
  memberId: string;
  memberName: string;
  reason: 'turn_count' | 'sustained_work' | 'phase_transition';
}

export interface CompactionCallbacks {
  /** Called when compaction is needed for a member */
  onCompactionNeeded?: (trigger: CompactionTrigger) => void;
}

export class CompactionManager {
  private intervalId: NodeJS.Timeout | null = null;
  private callbacks: CompactionCallbacks = {};
  private checkCount = 0;

  constructor(private readonly checkIntervalMs: number = 30_000) {}

  setCallbacks(callbacks: CompactionCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Start periodic compaction checks.
   * getMembers returns the current list of active team members.
   */
  start(getMembers: () => TeamMember[]): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      try {
        const members = getMembers();
        this.checkCount++;

        for (const member of members) {
          if (member.status !== 'running' && member.status !== 'idle') continue;

          const trigger = this.evaluateTrigger(member);
          if (trigger) {
            this.callbacks.onCompactionNeeded?.(trigger);
          }
        }
      } catch (err) {
        console.log('[CompactionManager] Check failed:', err);
      }
    }, this.checkIntervalMs);

    if (this.intervalId.unref) {
      this.intervalId.unref();
    }
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Evaluate whether a member needs compaction.
   */
  private evaluateTrigger(member: TeamMember): CompactionTrigger | null {
    // Trigger 1: Turn count exceeds threshold
    if ((member.turnCount ?? 0) >= TURN_THRESHOLD) {
      return {
        memberId: member.id,
        memberName: member.name,
        reason: 'turn_count',
      };
    }

    // Trigger 2: Sustained work without compaction
    const lastCompacted = member.lastCompactedAt ?? 0;
    const lastActivity = member.lastActivity ?? 0;
    if (lastActivity > 0 && lastCompacted > 0) {
      const timeSinceCompaction = Date.now() - lastCompacted;
      if (timeSinceCompaction >= SUSTAINED_WORK_MS) {
        return {
          memberId: member.id,
          memberName: member.name,
          reason: 'sustained_work',
        };
      }
    } else if (lastActivity > 0 && lastCompacted === 0) {
      // Never compacted — check time since first activity (approximated by turnCount > threshold)
      if ((member.turnCount ?? 0) > 10) {
        // Use a conservative heuristic: if enough turns have passed, trigger regardless
        return {
          memberId: member.id,
          memberName: member.name,
          reason: 'sustained_work',
        };
      }
    }

    return null;
  }

  /**
   * Generate a compaction snapshot for a member.
   * The snapshot preserves critical state that must survive compaction.
   */
  static generateSnapshot(
    member: TeamMember,
    opts: {
      role: string;
      currentTask?: string;
      decisions?: string[];
      modifiedFiles?: string[];
      pendingInbox?: number;
    },
  ): CompactionSnapshot {
    return {
      memberId: member.id,
      memberName: member.name,
      role: opts.role,
      currentTask: opts.currentTask,
      decisions: opts.decisions ?? [],
      modifiedFiles: opts.modifiedFiles ?? [],
      pendingInbox: opts.pendingInbox ?? 0,
      timestamp: Date.now(),
    };
  }

  /**
   * Format a CompactionSnapshot as markdown for file persistence.
   */
  static formatSnapshotMarkdown(snapshot: CompactionSnapshot): string {
    const lines = [
      `# Agent State: ${snapshot.memberName}`,
      ``,
      `## Role`,
      snapshot.role,
      ``,
    ];

    if (snapshot.currentTask) {
      lines.push(`## Current Task`, snapshot.currentTask, ``);
    }

    if (snapshot.decisions.length > 0) {
      lines.push(`## Decisions Log`);
      for (const d of snapshot.decisions) {
        lines.push(`- ${d}`);
      }
      lines.push(``);
    }

    if (snapshot.modifiedFiles.length > 0) {
      lines.push(`## Modified Files`);
      for (const f of snapshot.modifiedFiles) {
        lines.push(`- ${f}`);
      }
      lines.push(``);
    }

    lines.push(`## Pending Inbox: ${snapshot.pendingInbox} unread messages`);
    lines.push(``);
    lines.push(`## Timestamp: ${new Date(snapshot.timestamp).toISOString()}`);

    return lines.join('\n');
  }

  /**
   * Trigger a phase transition compaction for a specific member.
   * Called externally when a workflow phase changes.
   */
  triggerPhaseTransition(memberId: string, memberName: string): CompactionTrigger {
    const trigger: CompactionTrigger = {
      memberId,
      memberName,
      reason: 'phase_transition',
    };
    this.callbacks.onCompactionNeeded?.(trigger);
    return trigger;
  }
}
