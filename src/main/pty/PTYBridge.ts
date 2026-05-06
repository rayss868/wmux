import { BrowserWindow } from 'electron';
import { PTYManager } from './PTYManager';
import { OscParser } from './OscParser';
import { AgentDetector } from './AgentDetector';
import { TokenTracker } from './TokenTracker';
import { ActivityMonitor } from './ActivityMonitor';
import { toastManager } from '../pipe/handlers/notify.rpc';
import { IPC } from '../../shared/constants';
import { updateCwd, removeCwd, updateBranch, removeBranch } from '../ipc/handlers/metadata.handler';

/**
 * A middleware handler receives raw data from a PTY process.
 * Each middleware is executed in registration order, wrapped in try-catch
 * so that a failure in one does not block subsequent middleware or data forwarding.
 */
export type PTYDataMiddleware = (data: string) => void;

export class PTYBridge {
  private oscParsers = new Map<string, OscParser>();
  private agentDetectors = new Map<string, AgentDetector>();
  private tokenTrackers = new Map<string, TokenTracker>();
  private activityMonitor = new ActivityMonitor();
  private ptyCreatedAt = new Map<string, number>();
  private middlewareStacks = new Map<string, PTYDataMiddleware[]>();

  // Micro-batch buffers for the data hot-path. Chunks are accumulated and
  // flushed every BATCH_INTERVAL_MS so middlewares + IPC send each fire once
  // per flush instead of once per chunk. Pending buffers are drained on
  // dispose to avoid losing trailing output.
  private pendingData = new Map<string, string[]>();
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static BATCH_INTERVAL_MS = 8;

  constructor(
    private ptyManager: PTYManager,
    private getWindow: () => BrowserWindow | null,
  ) {
    this.ptyManager.onDispose((ptyId) => this.cleanupInstance(ptyId));
    // Activity-based notification: fires when sustained output drops to idle
    this.activityMonitor.onActiveToIdle((ptyId) => {
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;
      const notification = {
        type: 'agent' as const,
        title: 'Task may have finished',
        body: 'Terminal output stopped after active period',
      };
      win.webContents.send(IPC.NOTIFICATION, ptyId, notification);
      toastManager.show(notification.title, notification.body);
    });
  }

  /**
   * Register a data middleware for a specific PTY instance.
   * Middlewares are executed in registration order, each wrapped in try-catch.
   */
  addMiddleware(ptyId: string, handler: PTYDataMiddleware): void {
    let stack = this.middlewareStacks.get(ptyId);
    if (!stack) {
      stack = [];
      this.middlewareStacks.set(ptyId, stack);
    }
    stack.push(handler);
  }

  /**
   * Execute all registered middlewares for a PTY instance.
   * Each middleware is isolated — a failure in one does not block others.
   */
  private runMiddlewares(ptyId: string, data: string): void {
    const stack = this.middlewareStacks.get(ptyId);
    if (!stack) return;
    for (const mw of stack) {
      try {
        mw(data);
      } catch (err) {
        console.error('[PTYBridge] Middleware error:', err);
      }
    }
  }

  /**
   * Clean up all Bridge-side resources for a PTY instance.
   * Called automatically on process exit, but can also be called externally
   * (e.g. from PTYManager.dispose()) to ensure cleanup when onExit is not fired.
   */
  cleanupInstance(ptyId: string): void {
    // Drain any buffered data before tearing down — preserves trailing output
    // (e.g. final exit lines) that arrived between the last flush and dispose.
    this.flushPending(ptyId);
    const timer = this.pendingTimers.get(ptyId);
    if (timer) clearTimeout(timer);
    this.pendingTimers.delete(ptyId);
    this.pendingData.delete(ptyId);

    this.oscParsers.delete(ptyId);
    this.agentDetectors.delete(ptyId);
    this.tokenTrackers.delete(ptyId);
    this.ptyCreatedAt.delete(ptyId);
    this.activityMonitor.stop(ptyId);
    this.middlewareStacks.delete(ptyId);
    removeCwd(ptyId);
    removeBranch(ptyId);
    this.ptyManager.remove(ptyId);
  }

  /**
   * Flush all pending chunks for `ptyId`: run middlewares once and send a
   * single IPC frame to the renderer. Safe to call when there is nothing
   * pending.
   */
  private flushPending(ptyId: string): void {
    const chunks = this.pendingData.get(ptyId);
    if (!chunks || chunks.length === 0) return;
    const joined = chunks.length === 1 ? chunks[0] : chunks.join('');
    chunks.length = 0;

    try {
      this.runMiddlewares(ptyId, joined);
    } finally {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.PTY_DATA, ptyId, joined);
      }
    }
  }

  setupDataForwarding(ptyId: string): void {
    const instance = this.ptyManager.get(ptyId);
    if (!instance) return;
    if (this.oscParsers.has(ptyId)) {
      console.warn(`[PTYBridge] setupDataForwarding already active for ${ptyId} — skipping`);
      return;
    }

    this.ptyCreatedAt.set(ptyId, Date.now());
    this.activityMonitor.start(ptyId);

    const oscParser = new OscParser();
    this.oscParsers.set(ptyId, oscParser);

    const agentDetector = new AgentDetector();
    this.agentDetectors.set(ptyId, agentDetector);

    const tokenTracker = new TokenTracker();
    this.tokenTrackers.set(ptyId, tokenTracker);

    // Token usage event handling — forward to renderer
    tokenTracker.onToken((event) => {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.TOKEN_UPDATE, ptyId, event);
      }
    });

    // Handle OSC events
    oscParser.onOsc((event) => {
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;

      switch (event.code) {
        case 7: {
          const cwd = event.data.replace(/^file:\/\/[^/]*/, '');
          updateCwd(ptyId, cwd);
          win.webContents.send(IPC.CWD_CHANGED, ptyId, cwd);
          break;
        }
        case 9:
        case 99: {
          const notification = { type: 'info' as const, title: 'Terminal', body: event.data };
          win.webContents.send(IPC.NOTIFICATION, ptyId, notification);
          toastManager.show(notification.title, notification.body);
          break;
        }
        case 777: {
          const parts = event.data.split(';');
          const title = parts[1] || 'Notification';
          const body = parts.slice(2).join(';') || '';
          const notification = { type: 'info' as const, title, body };
          win.webContents.send(IPC.NOTIFICATION, ptyId, notification);
          toastManager.show(title, body);
          break;
        }
        case 7727: {
          // Git branch update from shell hook — store in main process and notify renderer
          updateBranch(ptyId, event.data);
          win.webContents.send(IPC.GIT_BRANCH_CHANGED, ptyId, event.data);
          break;
        }
      }
    });

    // Critical action detection (kept — this is precise and valuable)
    agentDetector.onCritical((criticalEvent) => {
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;
      win.webContents.send(IPC.APPROVAL_REQUEST, ptyId, {
        action: criticalEvent.action,
        riskLevel: criticalEvent.riskLevel,
      });
    });

    // Detect CWD from shell prompt patterns (PowerShell: "PS C:\path>", bash: "user@host:~/path$")
    // eslint-disable-next-line no-control-regex
    const ansiStripRegex = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[\?]?[0-9;]*[hlm]/g;
    const promptCwdRegex = /(?:PS\s+([A-Za-z]:\\[^>]*?)>)|(?:\w+@[\w.-]+:([^\$]+?)\$)/;
    let lastDetectedCwd = '';
    let promptBuffer = '';

    // --- Register per-instance middlewares ---

    // 1. Activity monitor
    this.addMiddleware(ptyId, (data) => {
      this.activityMonitor.feed(ptyId, data.length);
    });

    // 2. OSC parser
    this.addMiddleware(ptyId, (data) => {
      oscParser.process(data);
    });

    // 3. Agent detector
    this.addMiddleware(ptyId, (data) => {
      agentDetector.feed(data);
    });

    // 4. Token tracker
    this.addMiddleware(ptyId, (data) => {
      tokenTracker.feed(data);
    });

    // 5. Prompt buffer + CWD detection
    this.addMiddleware(ptyId, (data) => {
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;

      promptBuffer += data;
      if (promptBuffer.length > 1024) promptBuffer = promptBuffer.slice(-512);

      const clean = promptBuffer.replace(ansiStripRegex, '');
      const promptMatch = clean.match(promptCwdRegex);
      if (promptMatch) {
        const detectedCwd = (promptMatch[1] || promptMatch[2] || '').trim();
        if (detectedCwd && detectedCwd !== lastDetectedCwd) {
          lastDetectedCwd = detectedCwd;
          updateCwd(ptyId, detectedCwd);
          win.webContents.send(IPC.CWD_CHANGED, ptyId, detectedCwd);
        }
        promptBuffer = '';
      }
    });

    instance.process.onData((data: string) => {
      // Micro-batch: enqueue this chunk and (re)arm a short flush timer.
      // Middlewares + IPC send are deferred to the flush so a torrent of
      // small chunks collapses into one pass. Backpressure here is what
      // breaks the previous "5 sync middlewares per chunk" hot loop.
      let chunks = this.pendingData.get(ptyId);
      if (!chunks) {
        chunks = [];
        this.pendingData.set(ptyId, chunks);
      }
      chunks.push(data);

      if (!this.pendingTimers.has(ptyId)) {
        const timer = setTimeout(() => {
          this.pendingTimers.delete(ptyId);
          try {
            this.flushPending(ptyId);
          } catch (err) {
            console.error('[PTYBridge] Error processing data:', err);
            // Best-effort: drain any remaining bytes raw to the renderer so
            // we never lose user-visible output even if a middleware threw.
            const remaining = this.pendingData.get(ptyId);
            if (remaining && remaining.length > 0) {
              const joined = remaining.length === 1 ? remaining[0] : remaining.join('');
              remaining.length = 0;
              const win = this.getWindow();
              if (win && !win.isDestroyed()) {
                win.webContents.send(IPC.PTY_DATA, ptyId, joined);
              }
            }
          }
        }, PTYBridge.BATCH_INTERVAL_MS);
        this.pendingTimers.set(ptyId, timer);
      }
    });

    instance.process.onExit(({ exitCode }) => {
      // Drain any buffered output before signalling exit so the renderer
      // sees the final lines (e.g. exit banner) before PTY_EXIT.
      this.flushPending(ptyId);

      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.PTY_EXIT, ptyId, exitCode);

        if (exitCode !== 0) {
          const elapsed = Date.now() - (this.ptyCreatedAt.get(ptyId) ?? Date.now());
          const seconds = Math.round(elapsed / 1000);
          const notification = {
            type: 'error' as const,
            title: 'Process exited with error',
            body: `Exit code ${exitCode} after ${seconds}s`,
          };
          win.webContents.send(IPC.NOTIFICATION, ptyId, notification);
          toastManager.show(notification.title, notification.body);
        }
      }
      this.cleanupInstance(ptyId);
    });
  }
}
