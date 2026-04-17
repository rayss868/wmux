import { app } from 'electron';
import path from 'node:path';
import type { SessionData } from '../../shared/types';
import {
  atomicReadJSONSync,
  atomicWriteJSONSync,
} from '../../daemon/util/atomicWrite';

export class SessionManager {
  private filePath: string;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'session.json');
  }

  /**
   * Atomic save: delegates to the shared atomic-write helper which
   * writes to .tmp, backs up the existing file to .bak, then renames
   * .tmp → session.json. If the process crashes mid-write, only the
   * .tmp file is corrupted; the original session.json (or .bak)
   * remains intact.
   */
  save(data: SessionData): void {
    try {
      atomicWriteJSONSync(this.filePath, data);
    } catch (err) {
      console.error('[SessionManager] Failed to save session:', err);
    }
  }

  load(): SessionData | null {
    try {
      return atomicReadJSONSync<SessionData>(this.filePath, {
        validate: SessionManager.isSessionData,
      });
    } catch (err) {
      console.error('[SessionManager] Failed to load session:', err);
      return null;
    }
  }

  /**
   * Type guard passed to the shared atomic-read helper. Mirrors the
   * validation previously inlined in this module.
   */
  private static isSessionData(parsed: unknown): parsed is SessionData {
    if (typeof parsed !== 'object' || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj['workspaces'])) return false;
    if (typeof obj['activeWorkspaceId'] !== 'string') return false;
    return true;
  }
}
