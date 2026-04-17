// TokenTracker — parses Claude Code token usage and cost information
// from PTY output. Follows the same feed/line-buffer/gate architecture
// as AgentDetector.

export interface TokenEvent {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalCost?: number;
  timestamp: number;
}

export type TokenEventCallback = (event: TokenEvent) => void;

const MAX_BUFFER = 16 * 1024;

// Gate pattern: only start parsing after Claude Code banner is detected
const GATE_PATTERN = /Claude Code|claude-code|╭.*Claude/;

// Strip ANSI escape codes (same regex as AgentDetector)
const ANSI_RE = /\x1b(?:\[[0-9;]*[a-zA-Z]|\][^\x07]*\x07|\([A-Z])/g;

// ---------------------------------------------------------------------------
// Token / cost regex patterns
// ---------------------------------------------------------------------------

// Cost patterns: "Total cost: $1.23" or "Cost: $0.45"
const COST_RE = /(?:Total\s+)?[Cc]ost:\s*\$([0-9,]+(?:\.[0-9]+)?)/;

// Total tokens: "Total tokens: 142,567" or "Tokens used: 42.3k"
const TOTAL_TOKENS_RE = /(?:Total\s+)?[Tt]okens(?:\s+used)?:\s*([0-9,]+(?:\.[0-9]+)?k?)/;

// Shorthand tokens: "142k tokens" or "42.3k tokens"
const SHORT_TOKENS_RE = /\b([0-9,]+(?:\.[0-9]+)?k?)\s+tokens\b/;

// Session summary: "Session: 100k input, 50k output"
const SESSION_RE = /[Ss]ession:\s*([0-9,]+(?:\.[0-9]+)?k?)\s*input[,;]\s*([0-9,]+(?:\.[0-9]+)?k?)\s*output/;

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function parseTokenNumber(raw: string): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/,/g, '');
  const isK = cleaned.endsWith('k') || cleaned.endsWith('K');
  const numStr = isK ? cleaned.slice(0, -1) : cleaned;
  const num = parseFloat(numStr);
  if (isNaN(num)) return undefined;
  return isK ? Math.round(num * 1000) : num;
}

function parseCostNumber(raw: string): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? undefined : num;
}

// ---------------------------------------------------------------------------
// TokenTracker
// ---------------------------------------------------------------------------

export class TokenTracker {
  private gateActive = false;
  private lineBuffer = '';
  private callbacks: TokenEventCallback[] = [];
  private accumulated: TokenEvent = { timestamp: 0 };

  /**
   * Register a callback that fires whenever a token/cost event is parsed.
   */
  onToken(callback: TokenEventCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Feed raw PTY data. Lines are buffered and processed individually.
   */
  feed(data: string): void {
    this.lineBuffer += data;
    if (this.lineBuffer.length > MAX_BUFFER) {
      this.lineBuffer = this.lineBuffer.slice(-MAX_BUFFER);
    }
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      this.processLine(line);
    }
  }

  /**
   * Return accumulated token/cost data for the current session.
   */
  getAccumulated(): TokenEvent {
    return { ...this.accumulated };
  }

  /**
   * Reset all state (gate, buffers, accumulated data).
   */
  reset(): void {
    this.gateActive = false;
    this.lineBuffer = '';
    this.accumulated = { timestamp: 0 };
  }

  // -------------------------------------------------------------------------

  private processLine(line: string): void {
    const clean = line.replace(ANSI_RE, '').trim();
    if (!clean) return;

    // Check gate first
    if (!this.gateActive) {
      if (GATE_PATTERN.test(clean)) {
        this.gateActive = true;
      }
      return; // Even on the gate line itself, don't parse tokens yet
    }

    // Try to extract token/cost info from this line
    const event = this.parseLine(clean);
    if (event) {
      this.mergeAccumulated(event);
      for (const cb of this.callbacks) {
        cb(event);
      }
    }
  }

  private parseLine(clean: string): TokenEvent | null {
    try {
      let totalTokens: number | undefined;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let totalCost: number | undefined;

      // Cost
      const costMatch = clean.match(COST_RE);
      if (costMatch) {
        totalCost = parseCostNumber(costMatch[1]);
      }

      // Session summary (input + output)
      const sessionMatch = clean.match(SESSION_RE);
      if (sessionMatch) {
        inputTokens = parseTokenNumber(sessionMatch[1]);
        outputTokens = parseTokenNumber(sessionMatch[2]);
        if (inputTokens !== undefined && outputTokens !== undefined) {
          totalTokens = inputTokens + outputTokens;
        }
      }

      // Total tokens (only if session didn't already provide them)
      if (totalTokens === undefined) {
        const totalMatch = clean.match(TOTAL_TOKENS_RE);
        if (totalMatch) {
          totalTokens = parseTokenNumber(totalMatch[1]);
        } else {
          const shortMatch = clean.match(SHORT_TOKENS_RE);
          if (shortMatch) {
            totalTokens = parseTokenNumber(shortMatch[1]);
          }
        }
      }

      // Only emit if we found something
      if (totalTokens === undefined && inputTokens === undefined && outputTokens === undefined && totalCost === undefined) {
        return null;
      }

      const event: TokenEvent = { timestamp: Date.now() };
      if (totalTokens !== undefined) event.totalTokens = totalTokens;
      if (inputTokens !== undefined) event.inputTokens = inputTokens;
      if (outputTokens !== undefined) event.outputTokens = outputTokens;
      if (totalCost !== undefined) event.totalCost = totalCost;
      return event;
    } catch {
      // Graceful degradation: never propagate parse errors
      return null;
    }
  }

  private mergeAccumulated(event: TokenEvent): void {
    // Update (not sum) — last value wins
    if (event.totalTokens !== undefined) this.accumulated.totalTokens = event.totalTokens;
    if (event.inputTokens !== undefined) this.accumulated.inputTokens = event.inputTokens;
    if (event.outputTokens !== undefined) this.accumulated.outputTokens = event.outputTokens;
    if (event.totalCost !== undefined) this.accumulated.totalCost = event.totalCost;
    this.accumulated.timestamp = event.timestamp;
  }
}
