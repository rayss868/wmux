// E0 컨포먼스 하니스 — 코퍼스 생성 (스펙: engine-core-decision-2026-07-09.md §5-1)
//
// 합성 워크로드 5종을 녹화해 core/harness/corpus/{name}/{recording.bin,events.jsonl,meta.json}을
// 생성한다. 결정적이므로 재실행해도 같은 바이트가 나온다(meta.json workloadHash로 확인 가능).
//
// 실행: npm run harness:gen-corpus (vitest 러너로 이 모듈의 generateCorpus를 호출).
// 커밋 코퍼스는 합성 5종만(D4 거버넌스). 실 CLI 워크로드는 커밋하지 않는다.
//
// tsx 의존을 새로 들이지 않으려고 실행 러너로 vitest를 재사용한다(tsconfig.harness + vitest는
// CJS 컨텍스트라 __dirname이 있다). import.meta는 쓰지 않는다.

import path from 'node:path';
import { record, writeRecording } from './recorder';
import { WORKLOADS } from './workloads';

/** 커밋 코퍼스 디렉토리(이 파일 기준 corpus/). */
export const CORPUS_DIR = path.join(__dirname, 'corpus');

/** 합성 워크로드 5종을 녹화해 CORPUS_DIR에 기록한다. 생성된 케이스 디렉토리 목록을 반환. */
export async function generateCorpus(outDir: string = CORPUS_DIR): Promise<string[]> {
  const seed = 0; // 합성 워크로드는 시드 무의존이나 meta에 기록해 재현성을 명시.
  const dirs: string[] = [];
  for (const w of WORKLOADS) {
    const result = await record(w, seed);
    const dir = writeRecording(outDir, result);
    dirs.push(dir);
    // eslint-disable-next-line no-console
    console.log(
      `[gen-corpus] ${w.name}: ${result.bytes.length}B → ${path.relative(process.cwd(), dir)} (sha256=${result.meta.workloadHash.slice(0, 16)}…)`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[gen-corpus] 완료 — ${WORKLOADS.length}종 코퍼스 생성.`);
  return dirs;
}
