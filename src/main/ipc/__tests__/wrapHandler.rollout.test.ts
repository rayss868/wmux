/**
 * T3b — Smoke test for wrapHandler rollout.
 *
 * Statically verifies that every `ipcMain.handle(...)` call inside
 * `src/main/ipc/handlers/` goes through `wrapHandler(...)`. If a new handler
 * is added without wrapping, this test fails and prints the offending file(s)
 * plus line numbers so the dev can retrofit.
 *
 * Implementation notes:
 *   - Pure static analysis; does not `require` Electron.
 *   - We also assert that at least one `ipcMain.handle(` appears total (else
 *     the test would be trivially green if handlers moved elsewhere).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HANDLERS_DIR = path.resolve(__dirname, '..', 'handlers');
const HANDLE_CALL = /ipcMain\s*\.\s*handle\s*\(/g;

interface Offender {
  file: string;
  line: number;
  snippet: string;
}

/**
 * Strip `//` line comments, `/* ... *\/` block comments, and string literals
 * from TypeScript source. Replaces each stripped region with spaces so that
 * offsets/line numbers into the resulting string still map 1:1 to the input.
 * This prevents false positives where `ipcMain.handle(` appears inside a
 * comment or a string (e.g. a doc block).
 */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    // Line comment
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    // String literals: ', ", `
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ' ';
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          // Preserve newlines within the escape to keep line alignment.
          out += source[i] === '\n' ? '\n' : ' ';
          out += source[i + 1] === '\n' ? '\n' : ' ';
          i += 2;
          continue;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += ' ';
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Check whether the `ipcMain.handle(...)` call starting at `startIdx` in
 * `source` is wrapped with `wrapHandler(`. We look within the matching
 * parenthesis of the .handle(...) call.
 */
function callWrapsHandler(source: string, startIdx: number): boolean {
  // Find '(' immediately after `.handle`
  const openIdx = source.indexOf('(', startIdx);
  if (openIdx === -1) return false;

  // Walk forward tracking parentheses depth until we close the .handle() call.
  let depth = 0;
  let end = openIdx;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  const body = source.slice(openIdx, end + 1);
  return /wrapHandler\s*\(/.test(body);
}

function lineOf(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

describe('wrapHandler rollout', () => {
  it('every ipcMain.handle() in src/main/ipc/handlers uses wrapHandler', () => {
    expect(fs.existsSync(HANDLERS_DIR)).toBe(true);

    const files = fs
      .readdirSync(HANDLERS_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.handler.ts'))
      .map((d) => path.join(HANDLERS_DIR, d.name));

    expect(files.length).toBeGreaterThan(0);

    const offenders: Offender[] = [];
    let totalHandles = 0;

    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf-8');
      const source = stripCommentsAndStrings(raw);
      HANDLE_CALL.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = HANDLE_CALL.exec(source)) !== null) {
        totalHandles++;
        if (!callWrapsHandler(source, m.index)) {
          const line = lineOf(source, m.index);
          const snippet = raw.slice(m.index, m.index + 100).split('\n')[0];
          offenders.push({
            file: path.relative(HANDLERS_DIR, file),
            line,
            snippet,
          });
        }
      }
    }

    // Hard safety: if zero handles were discovered, something is wrong with
    // our scan (or the handler layout moved) — fail loudly instead of passing.
    expect(totalHandles).toBeGreaterThan(0);

    if (offenders.length > 0) {
      const report = offenders
        .map((o) => `  - ${o.file}:${o.line}  ${o.snippet}`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} ipcMain.handle() call(s) missing wrapHandler:\n${report}`,
      );
    }
  });

  it('every handler file importing ipcMain also imports wrapHandler', () => {
    const files = fs
      .readdirSync(HANDLERS_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.handler.ts'))
      .map((d) => path.join(HANDLERS_DIR, d.name));

    const missing: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      const usesHandle = /ipcMain\s*\.\s*handle\s*\(/.test(source);
      if (!usesHandle) continue;

      const importsWrap = /from\s+['"][^'"]*wrapHandler['"]/.test(source);
      if (!importsWrap) {
        missing.push(path.basename(file));
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Handler files using ipcMain.handle without importing wrapHandler:\n  - ${missing.join('\n  - ')}`,
      );
    }
  });
});
