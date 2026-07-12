// 루프 설정 모달의 스킬 픽커 재료 — pane 에이전트(Claude CLI)가 쓸 수 있는
// 스킬/커맨드 카탈로그를 디스크에서 스캔한다.
//
// 중요한 구분: 이 스킬들은 오케스트레이터의 것이 아니라 *pane 안 CLI*의
// 것이다. 루프 step이 "/qa"를 참조하면 실행 의미는 "pane에 /qa를 타이핑"
// (그라운딩 규칙) — 그래서 카탈로그의 진실 원천도 CLI와 동일한 디스크 규약:
//   <projectRoot>/.claude/skills/<name>/SKILL.md   (프로젝트 스킬)
//   <projectRoot>/.claude/commands/<name>.md       (프로젝트 커맨드)
//   <home>/.claude/skills|commands/...             (사용자 전역)
// projectRoot는 cwd에서 위로 걸어 올라가며 `.claude` 디렉토리를 가진 가장
// 가까운 조상(CLI의 프로젝트 해석과 동형). 읽기 전용·fail-soft: 어떤 IO
// 실패도 빈 목록/부분 목록으로 강등된다.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface SkillCatalogEntry {
  /** 슬래시 없는 이름 — UI가 `/${name}`으로 렌더. */
  readonly name: string;
  /** SKILL.md frontmatter description 첫 줄(캡) 또는 ''. */
  readonly description: string;
  readonly source: 'project' | 'user';
  readonly kind: 'skill' | 'command';
}

const MAX_ENTRIES = 200;
const MAX_DESC_CHARS = 160;
const MAX_WALK_UP = 12;

/** cwd에서 위로 걸어 `.claude` 디렉토리를 가진 가장 가까운 조상을 찾는다.
 *  home 자체는 프로젝트가 아니다(~/.claude는 사용자 전역 루트) — 워크업이
 *  home에 닿으면 프로젝트 없음으로 판정한다(테스트가 잡은 이중계상 버그). */
export function findProjectRoot(cwd: string, home: string = homedir()): string | null {
  const normHome = home.replace(/[/\\]+$/, '').toLowerCase();
  let dir = cwd;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (dir.replace(/[/\\]+$/, '').toLowerCase() === normHome) return null;
    try {
      if (existsSync(join(dir, '.claude'))) return dir;
    } catch {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** SKILL.md/커맨드 md의 frontmatter에서 description 한 줄을 뽑는다(fail-soft). */
function readDescription(mdPath: string): string {
  try {
    const raw = readFileSync(mdPath, 'utf8').slice(0, 4096);
    const m = raw.match(/^description:\s*(.+)$/m);
    return (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '').slice(0, MAX_DESC_CHARS);
  } catch {
    return '';
  }
}

function scanRoot(claudeDir: string, source: 'project' | 'user', out: SkillCatalogEntry[]): void {
  // skills/<name>/SKILL.md
  try {
    const skillsDir = join(claudeDir, 'skills');
    for (const name of readdirSync(skillsDir)) {
      if (out.length >= MAX_ENTRIES) return;
      try {
        const dir = join(skillsDir, name);
        if (!statSync(dir).isDirectory()) continue;
        const md = join(dir, 'SKILL.md');
        if (!existsSync(md)) continue;
        out.push({ name, description: readDescription(md), source, kind: 'skill' });
      } catch {
        /* 항목 단위 fail-soft */
      }
    }
  } catch {
    /* skills 디렉토리 없음 — 정상 */
  }
  // commands/<name>.md
  try {
    const commandsDir = join(claudeDir, 'commands');
    for (const file of readdirSync(commandsDir)) {
      if (out.length >= MAX_ENTRIES) return;
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -3);
      out.push({
        name,
        description: readDescription(join(commandsDir, file)),
        source,
        kind: 'command',
      });
    }
  } catch {
    /* commands 디렉토리 없음 — 정상 */
  }
}

/**
 * cwd 기준 스킬/커맨드 카탈로그. 프로젝트 항목이 먼저(가까운 것이 더 유관),
 * 같은 이름은 프로젝트가 사용자 전역을 가린다(CLI 해석과 동형).
 */
export function scanSkillCatalog(cwd: string, home: string = homedir()): SkillCatalogEntry[] {
  const out: SkillCatalogEntry[] = [];
  const projectRoot = cwd ? findProjectRoot(cwd, home) : null;
  if (projectRoot) scanRoot(join(projectRoot, '.claude'), 'project', out);
  scanRoot(join(home, '.claude'), 'user', out);
  // 이름 dedup — 프로젝트 우선(먼저 push됨).
  const seen = new Set<string>();
  return out.filter((e) => {
    if (seen.has(e.name)) return false;
    seen.add(e.name);
    return true;
  });
}
