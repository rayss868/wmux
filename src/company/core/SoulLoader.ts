// ─── Soul Loader ──────────────────────────────────────────────────────────────
// Loads agent SOUL files from GitHub (agency-agents repo) with in-memory caching.
// Designed to work in the Electron renderer process (no Node.js fs required).
// Souls are fetched once per session and cached in memory.

import { SOUL_MAPPING } from './soulMapping';

const GITHUB_RAW_BASE =
  'https://raw.githubusercontent.com/msitarzewski/agency-agents/main';

/** In-memory cache: presetId -> raw markdown content */
const soulCache = new Map<string, string>();

/** Track in-flight fetches to avoid duplicate requests */
const pendingFetches = new Map<string, Promise<string | null>>();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if a preset has a SOUL mapping in the agency-agents repo.
 */
export function hasSoul(presetId: string): boolean {
  return presetId in SOUL_MAPPING;
}

/**
 * Get a cached SOUL synchronously. Returns null if not yet fetched.
 */
export function loadSoulSync(presetId: string): string | null {
  return soulCache.get(presetId) ?? null;
}

/**
 * Fetch a SOUL file from GitHub and cache it in memory.
 * Returns the raw content, or null if fetch fails or no mapping exists.
 * Deduplicates concurrent requests for the same preset.
 */
export async function fetchSoul(presetId: string): Promise<string | null> {
  // Return from cache if available
  const cached = soulCache.get(presetId);
  if (cached) return cached;

  const repoPath = SOUL_MAPPING[presetId as keyof typeof SOUL_MAPPING];
  if (!repoPath) return null;

  // Deduplicate in-flight fetches
  const pending = pendingFetches.get(presetId);
  if (pending) return pending;

  const fetchPromise = (async (): Promise<string | null> => {
    const url = `${GITHUB_RAW_BASE}/${repoPath}`;
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const content = await response.text();

      // Cache in memory
      soulCache.set(presetId, content);
      return content;
    } catch {
      // Network error — return null, caller uses base persona
      return null;
    } finally {
      pendingFetches.delete(presetId);
    }
  })();

  pendingFetches.set(presetId, fetchPromise);
  return fetchPromise;
}

/**
 * Load SOUL with fallback: memory cache first, then fetch from GitHub.
 */
export async function loadSoul(presetId: string): Promise<string | null> {
  const cached = loadSoulSync(presetId);
  if (cached) return cached;
  return fetchSoul(presetId);
}

/**
 * Pre-fetch all souls for a list of preset IDs in parallel.
 * Useful before spawning a company to warm the cache.
 * Returns count of successfully loaded souls.
 */
export async function prefetchSouls(presetIds: string[]): Promise<number> {
  const unique = [...new Set(presetIds.filter((id) => hasSoul(id)))];
  const results = await Promise.allSettled(unique.map((id) => fetchSoul(id)));
  return results.filter(
    (r) => r.status === 'fulfilled' && r.value !== null,
  ).length;
}

// ─── Soul Condensing ─────────────────────────────────────────────────────────

/**
 * Extract the core persona sections from a raw SOUL markdown file.
 * Strips frontmatter, code blocks, and verbose examples to keep prompt size
 * reasonable (~3000 chars). Focuses on identity, mission, rules, and workflow.
 */
export function condenseSoul(raw: string): string {
  // Remove YAML frontmatter
  let content = raw.replace(/^---[\s\S]*?---\n*/m, '');

  // Remove code blocks (examples are too verbose for prompts)
  content = content.replace(/```[\s\S]*?```/g, '');

  // Remove HTML comments
  content = content.replace(/<!--[\s\S]*?-->/g, '');

  // Extract key sections by heading
  const sections: string[] = [];
  const sectionPattern = /^## .+$/gm;
  const matches = [...content.matchAll(sectionPattern)];

  const keepSections = [
    'identity',
    'memory',
    'core mission',
    'critical rules',
    'workflow',
    'development philosophy',
    'your role',
    'responsibilities',
    'deliverable',
    'key principles',
    'operating principles',
    'approach',
    'persona',
    'mindset',
  ];

  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][0].toLowerCase();
    if (keepSections.some((s) => heading.includes(s))) {
      const start = matches[i].index!;
      const end =
        i + 1 < matches.length ? matches[i + 1].index! : content.length;
      sections.push(content.slice(start, end).trim());
    }
  }

  if (sections.length === 0) {
    // Fallback: use the first 2000 chars of the cleaned content
    return content.slice(0, 2000).trim();
  }

  // Join extracted sections and cap at ~3000 chars
  let result = sections.join('\n\n');
  if (result.length > 3000) {
    result = result.slice(0, 3000).trim() + '\n\n[... condensed for prompt size]';
  }

  return result;
}

/**
 * Write the SOUL as .claude/CLAUDE.md via the main-process fs IPC.
 *
 * Previously this built a POSIX shell heredoc and piped it through the PTY,
 * which introduced three defects: (1) supply-chain RCE via the fixed heredoc
 * delimiter when upstream markdown contained `WMUX_SOUL_EOF`, (2) silent
 * failure on Windows PowerShell (no `mkdir -p`, `&&`, or heredoc), and
 * (3) corruption of every apostrophe into `'\''` because the inline-quote
 * escape was applied inside a quoted heredoc where no expansion happens.
 *
 * Writing via the main process eliminates the shell round-trip entirely.
 * Returns true on success, false otherwise.
 */
export async function writeSoulToFile(presetId: string, workDir: string): Promise<boolean> {
  if (!hasSoul(presetId)) return false;
  const raw = await loadSoul(presetId);
  if (!raw) return false;
  const filePath = `${workDir}/.claude/CLAUDE.md`;
  return window.electronAPI.fs.writeFile(filePath, raw);
}

/**
 * Clear the in-memory soul cache. Useful for testing or forced refresh.
 */
export function clearSoulCache(): void {
  soulCache.clear();
}
