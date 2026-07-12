// 루프 steps(매 iteration 절차) + 스킬 카탈로그 스캔 계약.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startLoop,
  loadWorkspaceLoopState,
  renderLoopStateBlock,
  LOOP_STATE_LIMITS,
} from '../deckLoopStateStore';
import { scanSkillCatalog, findProjectRoot } from '../skillCatalogScan';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wmux-loopsteps-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loop steps — 저장·정규화·왕복', () => {
  it('steps가 저장되고 재로드에서 살아남는다(빈 줄 제거·캡)', async () => {
    await startLoop(
      'ws-1',
      {
        objective: 'keep CI green',
        steps: ['  /qa 실행  ', '', '실패 수정', 'x'.repeat(LOOP_STATE_LIMITS.MAX_STEP_TEXT + 50)],
      },
      dir,
    );
    const loop = loadWorkspaceLoopState('ws-1', dir)!;
    expect(loop.steps).toEqual(['/qa 실행', '실패 수정', 'x'.repeat(LOOP_STATE_LIMITS.MAX_STEP_TEXT)]);
  });

  it('steps 개수 캡(MAX_STEPS) — 초과분 절단', async () => {
    await startLoop(
      'ws-1',
      { objective: 'o', steps: Array.from({ length: LOOP_STATE_LIMITS.MAX_STEPS + 5 }, (_, i) => `s${i}`) },
      dir,
    );
    expect(loadWorkspaceLoopState('ws-1', dir)!.steps.length).toBe(LOOP_STATE_LIMITS.MAX_STEPS);
  });

  it('steps 없는 루프는 빈 배열(구 파일 하위호환 포함)', async () => {
    await startLoop('ws-1', { objective: 'o' }, dir);
    expect(loadWorkspaceLoopState('ws-1', dir)!.steps).toEqual([]);
  });

  it('renderLoopStateBlock — steps가 objective 다음, 번호 순서로 주입된다', async () => {
    await startLoop('ws-1', { objective: 'o', steps: ['/qa', 'fix failures'], taskTexts: ['done'] }, dir);
    const block = renderLoopStateBlock(loadWorkspaceLoopState('ws-1', dir)!);
    expect(block).toContain('steps (follow in order each iteration');
    expect(block).toContain('  1. /qa');
    expect(block).toContain('  2. fix failures');
    // steps 섹션이 done-when보다 먼저.
    expect(block.indexOf('steps (')).toBeLessThan(block.indexOf('done-when'));
  });

  it('steps 없으면 블록에 steps 섹션이 없다', async () => {
    await startLoop('ws-1', { objective: 'o' }, dir);
    expect(renderLoopStateBlock(loadWorkspaceLoopState('ws-1', dir)!)).not.toContain('steps (');
  });
});

describe('scanSkillCatalog — .claude/skills|commands 스캔', () => {
  function seed(root: string, kind: 'skills' | 'commands', name: string, desc?: string): void {
    if (kind === 'skills') {
      const d = join(root, '.claude', 'skills', name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc ?? ''}\n---\nbody`);
    } else {
      const d = join(root, '.claude', 'commands');
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `${name}.md`), desc ? `---\ndescription: ${desc}\n---\n` : 'body');
    }
  }

  it('프로젝트 스킬+커맨드, 사용자 전역 순서로 나오고 이름 dedup은 프로젝트 우선', () => {
    const project = join(dir, 'proj');
    const home = join(dir, 'home');
    seed(project, 'skills', 'qa', 'test the site');
    seed(project, 'commands', 'ship');
    seed(home, 'skills', 'qa', 'USER duplicate — must be shadowed');
    seed(home, 'commands', 'review', 'code review');
    const out = scanSkillCatalog(join(project, 'src', 'deep'), home);
    expect(out.map((e) => `${e.source}:${e.name}`)).toEqual([
      'project:qa',
      'project:ship',
      'user:review',
    ]);
    expect(out[0].description).toBe('test the site');
    expect(out[0].kind).toBe('skill');
    expect(out[1].kind).toBe('command');
  });

  it('findProjectRoot — .claude 조상을 찾되 home 자체는 프로젝트가 아니다', () => {
    const project = join(dir, 'p2');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const deep = join(project, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(findProjectRoot(deep, dir)).toBe(project);
    // home(=dir)에 .claude가 있어도 워크업이 home에 닿으면 null —
    // ~/.claude를 "프로젝트"로 이중계상하지 않는다.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const bare = join(dir, 'bare');
    mkdirSync(bare);
    expect(findProjectRoot(bare, dir)).toBeNull();
  });

  it('비존재 cwd·빈 home도 fail-soft 빈 목록', () => {
    expect(scanSkillCatalog(join(dir, 'nope'), dir)).toEqual([]);
  });
});
