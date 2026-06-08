import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Electron-free so it can be unit-tested without an Electron runtime — the
// IPC registration that wraps this lives in ../ipc/handlers/fonts.handler.ts.

const execFileAsync = promisify(execFile);

// Enumerate installed font *family* names via .NET's
// InstalledFontCollection. This returns CSS-resolvable family names
// ("Cascadia Code", "JetBrains Mono", "D2Coding") — unlike the registry
// `…\Fonts` value-names, which are file-display strings like
// "Arial Bold (TrueType)" that don't match a CSS family. `[Console]::
// OutputEncoding = UTF-8` is set first so Korean/CJK family names survive the
// pipe instead of being mangled by the console's OEM codepage (CP949 on a
// Korean Windows). Single line by design (see feedback_command_single_line).
const PS_FONT_SCRIPT =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }";

// PowerShell cold-start + assembly load is a few hundred ms; 5s is generous
// headroom while still bounding a hung spawn so the Settings panel never waits
// indefinitely for suggestions.
const PS_TIMEOUT_MS = 5000;

// 156 families on a stock box, longest ~40 chars → ~10KB. 1MB is ~100x
// headroom and caps a runaway/garbage stream.
const PS_MAX_BUFFER = 1024 * 1024;

/**
 * Parse the newline-delimited PowerShell stdout into a clean, de-duplicated,
 * locale-sorted list of family names. Pure (no I/O) so it is unit-testable
 * without spawning PowerShell. Trims each line, drops blanks, and collapses
 * the weight-variant duplicates PowerShell can emit (the datalist filters the
 * rest as the user types).
 */
export function parseFontList(stdout: string): string[] {
  const names = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

async function listWindowsFonts(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', PS_FONT_SCRIPT],
    { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: PS_MAX_BUFFER, encoding: 'utf8' },
  );
  return parseFontList(stdout);
}

/**
 * Best-effort enumeration of installed font families for the Settings font
 * picker. Contract: NEVER throws and NEVER rejects. On a non-Windows platform,
 * a spawn failure, a timeout, or a parse error it resolves `[]`. The renderer's
 * font input is free-text, so an empty list simply means "no suggestions".
 */
export async function listInstalledFonts(): Promise<string[]> {
  // macOS/Linux enumeration is a deliberate follow-up — Windows ships first.
  // Returning [] keeps the picker working as pure free-text there.
  if (process.platform !== 'win32') return [];
  try {
    return await listWindowsFonts();
  } catch {
    // Swallow: a missing/locked PowerShell or a slow box must not surface an
    // error toast for an optional convenience feature.
    return [];
  }
}
