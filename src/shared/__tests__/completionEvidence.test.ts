import { describe, it, expect } from 'vitest';
import type { CompletionEvidence, EvidenceItem } from '../types';
import {
  validateCompletionEvidence,
  isVerifiedItem,
  isSafeRelPath,
  normalizeCompletionEvidenceWire,
  EVIDENCE_MAX_ITEMS,
  EVIDENCE_MAX_STR_BYTES,
  EVIDENCE_MAX_FILES,
  EVIDENCE_MAX_FILE_PATH_BYTES,
} from '../completionEvidence';

const passedCmd: EvidenceItem = {
  kind: 'command',
  status: 'passed',
  summary: '테스트 통과',
  command: 'npm test',
};
const unverifiedInspection: EvidenceItem = {
  kind: 'inspection',
  status: 'unverified',
  summary: 'claude CLI run exited success (self-reported)',
};

function ev(overrides: Partial<CompletionEvidence> = {}): CompletionEvidence {
  return { summary: '작업 완료', items: [passedCmd], ...overrides };
}

describe('validateCompletionEvidence — 수용 기준 (로드맵 :446)', () => {
  it('T-gate-missing: evidence 없이 completed → completion_evidence_missing 거부', () => {
    expect(validateCompletionEvidence('completed', undefined)).toEqual({
      ok: false,
      code: 'completion_evidence_missing',
    });
  });
});

describe('validateCompletionEvidence — 게이트 불변식 (E9: 게이트=구조, verified=등급)', () => {
  it('completed + 검증 아이템 → 통과, verifiedItemCount 정직 산출', () => {
    const r = validateCompletionEvidence(
      'completed',
      ev({ items: [passedCmd, unverifiedInspection, { kind: 'artifact', status: 'verified', summary: '산출물 확인' }] }),
    );
    expect(r).toEqual({ ok: true, verifiedItemCount: 2 });
  });

  it('completed + well-formed이나 verified 0(unverified 자기보고만) → 통과 + count 0 (E9 등급 모델)', () => {
    const r = validateCompletionEvidence('completed', ev({ items: [unverifiedInspection] }));
    expect(r).toEqual({ ok: true, verifiedItemCount: 0 });
  });

  it('세탁 불가(CL1): ClaudeWorker (A′) 정직 증거는 verified로 세지지 않는다', () => {
    // run-success를 inspection/unverified로 표기 — command+passed로 승격되지 않음
    expect(isVerifiedItem(unverifiedInspection)).toBe(false);
    expect(isVerifiedItem(passedCmd)).toBe(true);
    expect(isVerifiedItem({ kind: 'command', status: 'failed', summary: 's', command: 'c' })).toBe(false);
  });

  it('completed + 빈/공백 summary → completion_evidence_empty_summary', () => {
    expect(validateCompletionEvidence('completed', ev({ summary: '' }))).toEqual({
      ok: false,
      code: 'completion_evidence_empty_summary',
    });
    expect(validateCompletionEvidence('completed', ev({ summary: '   ' }))).toEqual({
      ok: false,
      code: 'completion_evidence_empty_summary',
    });
  });

  it('completed + 빈 items → completion_evidence_no_items', () => {
    expect(validateCompletionEvidence('completed', ev({ items: [] }))).toEqual({
      ok: false,
      code: 'completion_evidence_no_items',
    });
  });

  it('command 아이템에 command 누락/공백 → completion_evidence_invalid_item', () => {
    const noCmd = { kind: 'command', status: 'passed', summary: 's' } as unknown as EvidenceItem;
    expect(validateCompletionEvidence('completed', ev({ items: [noCmd] }))).toEqual({
      ok: false,
      code: 'completion_evidence_invalid_item',
    });
    const blankCmd = { kind: 'command', status: 'passed', summary: 's', command: '  ' } as EvidenceItem;
    expect(validateCompletionEvidence('completed', ev({ items: [blankCmd] }))).toEqual({
      ok: false,
      code: 'completion_evidence_invalid_item',
    });
  });

  it('미지 kind / kind별 위장 status(command+verified) → completion_evidence_invalid_item (G6 닫힌 enum)', () => {
    const unknownKind = { kind: 'vibe', status: 'passed', summary: 's' } as unknown as EvidenceItem;
    expect(validateCompletionEvidence('completed', ev({ items: [unknownKind] }))).toEqual({
      ok: false,
      code: 'completion_evidence_invalid_item',
    });
    const disguised = { kind: 'command', status: 'verified', summary: 's', command: 'c' } as unknown as EvidenceItem;
    expect(validateCompletionEvidence('completed', ev({ items: [disguised] }))).toEqual({
      ok: false,
      code: 'completion_evidence_invalid_item',
    });
  });
});

describe('validateCompletionEvidence — failed 비대칭 + X8 형태 검증 공통', () => {
  it('failed + 사유(summary)만, items 없음 → 통과 (검증 불변식 미적용)', () => {
    expect(validateCompletionEvidence('failed', { summary: 'spawn error', items: [] })).toEqual({
      ok: true,
      verifiedItemCount: 0,
    });
  });

  it('failed + evidence/summary 부재 → failure_reason_missing', () => {
    expect(validateCompletionEvidence('failed', undefined)).toEqual({ ok: false, code: 'failure_reason_missing' });
    expect(validateCompletionEvidence('failed', { summary: ' ', items: [] })).toEqual({
      ok: false,
      code: 'failure_reason_missing',
    });
  });

  it('failed + 진단 아이템(command+failed) → 통과 / malformed 아이템 → 거부 (X8: 감사 로그 잔류 차단)', () => {
    expect(
      validateCompletionEvidence('failed', {
        summary: '빌드 실패',
        items: [{ kind: 'command', status: 'failed', summary: '빌드', command: 'npm run build' }],
      }),
    ).toEqual({ ok: true, verifiedItemCount: 0 });
    const malformed = { kind: 'command', status: 'exploded', summary: 's', command: 'c' } as unknown as EvidenceItem;
    expect(validateCompletionEvidence('failed', { summary: '실패', items: [malformed] })).toEqual({
      ok: false,
      code: 'completion_evidence_invalid_item',
    });
  });
});

describe('validateCompletionEvidence — DoS 캡 (E12)', () => {
  it(`items ${EVIDENCE_MAX_ITEMS + 1}개 → completion_evidence_too_large`, () => {
    const items = Array.from({ length: EVIDENCE_MAX_ITEMS + 1 }, () => ({ ...passedCmd }));
    expect(validateCompletionEvidence('completed', ev({ items }))).toEqual({
      ok: false,
      code: 'completion_evidence_too_large',
    });
  });

  it('문자열 필드 4KiB 초과(멀티바이트는 바이트 기준) → too_large', () => {
    // '한' = 3바이트 — 1366자 * 3 = 4098바이트 > 4096
    const big = '한'.repeat(Math.ceil((EVIDENCE_MAX_STR_BYTES + 1) / 3));
    expect(validateCompletionEvidence('completed', ev({ summary: big }))).toEqual({
      ok: false,
      code: 'completion_evidence_too_large',
    });
    const bigOutput = { ...passedCmd, output: 'x'.repeat(EVIDENCE_MAX_STR_BYTES + 1) } as EvidenceItem;
    expect(validateCompletionEvidence('completed', ev({ items: [bigOutput] }))).toEqual({
      ok: false,
      code: 'completion_evidence_too_large',
    });
  });

  it(`files ${EVIDENCE_MAX_FILES + 1}개 → too_large`, () => {
    const files = Array.from({ length: EVIDENCE_MAX_FILES + 1 }, (_, i) => `src/f${i}.ts`);
    expect(validateCompletionEvidence('completed', ev({ files }))).toEqual({
      ok: false,
      code: 'completion_evidence_too_large',
    });
  });

  it('직렬화 총량 64KiB 초과 → too_large (개별 캡은 전부 통과하는 조합)', () => {
    // 아이템 20개 × output 3.9KiB ≈ 78KiB — 개별 필드 캡 이하, 총량 초과
    const items = Array.from({ length: 20 }, () => ({ ...passedCmd, output: 'y'.repeat(3900) }) as EvidenceItem);
    expect(validateCompletionEvidence('completed', ev({ items }))).toEqual({
      ok: false,
      code: 'completion_evidence_too_large',
    });
  });
});

describe('isSafeRelPath — 새니타이즈 (X7+G5 변종 매트릭스)', () => {
  const reject = [
    '/etc/x', // POSIX 절대
    'C:\\x', // 드라이브 절대
    '\\\\host\\x', // UNC
    '\\\\?\\C:\\x', // NT 네임스페이스
    'C:foo', // drive-relative
    'a.txt:ads', // NTFS ADS
    'file://x', // URL 스킴
    'a/../b', // 상위 탈출
    '..', // 상위 탈출 단독
    'a\\..\\b', // 백슬래시 구분자 탈출
    'a\u0000b', // null 바이트
    'a\nb', // C0 제어문자
    '', // 빈 문자열
    'x'.repeat(EVIDENCE_MAX_FILE_PATH_BYTES + 1), // 과길이
  ];
  it.each(reject)('거부: %j', (p) => {
    expect(isSafeRelPath(p)).toBe(false);
  });

  const accept = [
    'src/a.ts',
    'docs/한글.md', // 멀티바이트
    'a\\b/c.txt', // 혼합 구분자 상대경로
    '%2e%2e%2f', // 무디코드 정책: 리터럴 세그먼트명으로 통과(소비자 디코드 금지 계약)
    './a.ts', // '.' 세그먼트는 무해
  ];
  it.each(accept)('통과: %j', (p) => {
    expect(isSafeRelPath(p)).toBe(true);
  });

  it('비문자열 → 거부', () => {
    expect(isSafeRelPath(null)).toBe(false);
    expect(isSafeRelPath(42)).toBe(false);
  });
});

describe('normalizeCompletionEvidenceWire — wire 가드 (X6: plain+hasOwn+normalize)', () => {
  const validWire = {
    summary: '완료',
    items: [{ kind: 'command', status: 'passed', summary: '테스트', command: 'npm test' }],
    files: ['src/a.ts'],
  };

  it('유효 입력 → 알려진 필드만 복사한 새 객체 (원본과 분리)', () => {
    const out = normalizeCompletionEvidenceWire(validWire);
    expect(out).toEqual({
      summary: '완료',
      items: [{ kind: 'command', status: 'passed', summary: '테스트', command: 'npm test' }],
      files: ['src/a.ts'],
    });
    expect(out).not.toBe(validWire);
    expect(out!.items).not.toBe(validWire.items);
    expect(out!.files).not.toBe(validWire.files);
  });

  it('recordedBy/recordedAt·미지 키 밀수 → 드롭 (서버 전용 스탬프 보호)', () => {
    const out = normalizeCompletionEvidenceWire({
      ...validWire,
      recordedBy: 'ws-forged',
      recordedAt: '2020-01-01T00:00:00Z',
      smuggle: { evil: true },
    });
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty('recordedBy');
    expect(out).not.toHaveProperty('recordedAt');
    expect(out).not.toHaveProperty('smuggle');
  });

  it('JSON.parse의 __proto__ own-키 → 산출물에 오염 없음 (프로토타입 오염 차단)', () => {
    const wire = JSON.parse(
      '{"summary":"s","items":[],"__proto__":{"polluted":"yes"}}',
    ) as unknown;
    const out = normalizeCompletionEvidenceWire(wire);
    expect(out).not.toBeNull();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out as object, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('비-plain object(class 인스턴스·상속 필드) → null', () => {
    class Fake {
      summary = 's';
      items: unknown[] = [];
    }
    expect(normalizeCompletionEvidenceWire(new Fake())).toBeNull();
    // summary가 프로토타입 체인에만 있는 객체 — hasOwn 검사로 거부
    expect(normalizeCompletionEvidenceWire(Object.create({ summary: 's', items: [] }))).toBeNull();
  });

  it('null-prototype 객체(정상 wire 산물) → 통과', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.summary = 's';
    o.items = [];
    expect(normalizeCompletionEvidenceWire(o)).toEqual({ summary: 's', items: [] });
  });

  it('형태 불량 → null: items 비배열 / 미지 kind / 위장 status / 비문자열 files', () => {
    expect(normalizeCompletionEvidenceWire({ summary: 's', items: 'nope' })).toBeNull();
    expect(normalizeCompletionEvidenceWire({ summary: 's', items: [{ kind: 'vibe', status: 'ok', summary: 'x' }] })).toBeNull();
    expect(
      normalizeCompletionEvidenceWire({ summary: 's', items: [{ kind: 'command', status: 'verified', summary: 'x', command: 'c' }] }),
    ).toBeNull();
    expect(normalizeCompletionEvidenceWire({ summary: 's', items: [], files: [42] })).toBeNull();
    expect(normalizeCompletionEvidenceWire('str')).toBeNull();
    expect(normalizeCompletionEvidenceWire(null)).toBeNull();
    expect(normalizeCompletionEvidenceWire([])).toBeNull();
  });

  it('shape만 판정: 빈 summary는 통과시키고 권위 검증기가 거부 (역할 분리)', () => {
    const out = normalizeCompletionEvidenceWire({ summary: '', items: [] });
    expect(out).toEqual({ summary: '', items: [] });
    expect(validateCompletionEvidence('completed', out!)).toEqual({
      ok: false,
      code: 'completion_evidence_empty_summary',
    });
  });

  it('캡 초과 → null (wire에서도 독립 강제)', () => {
    const items = Array.from({ length: EVIDENCE_MAX_ITEMS + 1 }, () => ({
      kind: 'command',
      status: 'passed',
      summary: 's',
      command: 'c',
    }));
    expect(normalizeCompletionEvidenceWire({ summary: 's', items })).toBeNull();
  });
});
