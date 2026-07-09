// E0 하니스 — miner 검증 (스펙: engine-core-decision-2026-07-09.md §5-1 사전 점검 인도물)
//
// 두 축을 검증한다:
//   (A) .buf 실덤프의 raw ANSI 보존 — RingBuffer.dumpToFile이 필터 없이 raw 바이트를 남기는지
//       실제 RingBuffer로 왕복(로컬 실덤프가 없으므로 fixture로 실증 — 스펙 허용).
//   (B) 다층 스크럽 — api key/token/secret·Bearer·OSC 52·base64 고엔트로피가 지워지고, raw ANSI
//       제어시퀀스(SGR·커서이동 등 secret 아님)는 보존되는지.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RingBuffer } from '../../../src/daemon/RingBuffer';
import { scrub, mineBufferDir, writeMinedSeeds, LOCAL_CORPUS_DIR } from '../miner';

const enc = new TextEncoder();
const decUtf8 = new TextDecoder('utf-8');
// 스크럽 테스트는 ASCII secret만 다루므로 바이트 1:1 latin1로 디코드(멀티바이트 이슈 없음).
const dec = new TextDecoder('latin1');

describe('miner — .buf raw ANSI 보존', () => {
  it('(A) RingBuffer.dumpToFile은 raw ANSI 바이트를 무필터로 보존한다', async () => {
    // 실덤프 fixture: SGR·커서이동·CJK·이모지 등 raw ANSI가 섞인 바이트열(UTF-8 인코딩).
    const src = '\x1b[31mred\x1b[0m \x1b[H\x1b[2J한글\u{1F600}\x1b[38;2;18;52;86mtrue\x1b[0m';
    const raw = enc.encode(src);
    const dir = mkdtempSync(path.join(tmpdir(), 'wmux-miner-'));
    try {
      const rb = new RingBuffer(1 << 20);
      rb.write(Buffer.from(raw));
      const bufPath = path.join(dir, 'session-abc.buf');
      await rb.dumpToFile(bufPath);

      // 채굴기가 .buf를 읽어 스크럽한 결과. 이 fixture엔 secret이 없으므로 raw 바이트가 100% 보존돼야 한다.
      const seeds = mineBufferDir(dir);
      expect(seeds.length, 'session-abc.buf 1건을 읽어야 한다').toBe(1);
      // (핵심) secret 없는 입력은 스크럽이 바이트를 한 개도 안 바꿔야 한다 — raw 무필터 보존의 정본.
      expect(Buffer.from(seeds[0].bytes).equals(Buffer.from(raw)), 'secret 없는 바이트가 변형됨').toBe(
        true,
      );
      // UTF-8로 재디코딩하면 원문과 동일(멀티바이트 CJK·이모지 무손상 — 바이트 보존의 귀결).
      const minedText = decUtf8.decode(seeds[0].bytes);
      expect(minedText).toBe(src);
      // raw ANSI 제어시퀀스·CJK·이모지·truecolor 모두 보존.
      expect(minedText).toContain('\x1b[31m'); // SGR 빨강.
      expect(minedText).toContain('\x1b[H\x1b[2J'); // 커서 홈 + 화면 클리어.
      expect(minedText).toContain('한글'); // CJK 무손상.
      expect(minedText).toContain('\u{1F600}'); // 이모지 무손상.
      expect(minedText).toContain('\x1b[38;2;18;52;86m'); // truecolor SGR.
      expect(minedText).not.toContain('[[REDACTED]]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(A2) tmp 동반 파일(.tmp.<hex>)은 채굴에서 스킵된다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wmux-miner-tmp-'));
    try {
      const rb = new RingBuffer(1 << 16);
      rb.write(Buffer.from(enc.encode('hello')));
      await rb.dumpToFile(path.join(dir, 'real.buf'));
      // 원자적 덤프의 중간 산물을 흉내: real.buf.tmp.deadbeef (스킵 대상).
      await rb.dumpToFile(path.join(dir, 'real.buf.tmp.deadbeef'));
      const seeds = mineBufferDir(dir);
      // real.buf만 잡히고 .tmp.deadbeef는 스킵 — 단, 파일명이 .buf로 안 끝나므로 애초에 제외.
      // (real.buf.tmp.deadbeef는 .buf로 끝나지 않으니 확장자 필터에서 이미 걸러진다 — 이중 안전.)
      expect(seeds.map((s) => path.basename(s.sourceFile))).toEqual(['real.buf']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('miner — 다층 스크럽', () => {
  it('key=value 자격증명(api_key/token/secret/password)을 지운다', () => {
    const input = enc.encode(
      'export API_KEY=sk-abc123DEF456 TOKEN=ghp_xyz secret=hunter2 password=p@ss normal=keep',
    );
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('sk-abc123DEF456');
    expect(out).not.toContain('ghp_xyz');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('p@ss');
    expect(out).toContain('[[REDACTED]]');
    // 비-secret key=value는 보존.
    expect(out).toContain('normal=keep');
  });

  it('Bearer 토큰을 지운다', () => {
    const input = enc.encode('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload');
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('Bearer [[REDACTED]]');
  });

  it('OSC 52 클립보드 페이로드를 지우되 시퀀스 골격은 남긴다', () => {
    // ESC ] 52 ; c ; <base64> BEL
    const payload = 'c2VjcmV0LWNsaXBib2FyZC1kYXRh'; // "secret-clipboard-data" base64.
    const input = enc.encode(`before\x1b]52;c;${payload}\x07after`);
    const out = dec.decode(scrub(input));
    expect(out).not.toContain(payload);
    expect(out).toContain('\x1b]52;c;[[REDACTED]]\x07');
    // 전후 텍스트는 보존.
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('base64 고엔트로피 토큰을 지우고, 저엔트로피/짧은 문자열은 보존한다', () => {
    // 고엔트로피(랜덤에 가까운) 32+자 base64.
    const highEntropy = 'aZ9kQ2mX7pL4vB8nR1sT6wY3cF5gH0jD';
    // 저엔트로피(반복) — 지우면 안 됨.
    const lowEntropy = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const input = enc.encode(`high=${highEntropy} low=${lowEntropy}`);
    const out = dec.decode(scrub(input));
    // high=는 KV_RE에 안 걸리는 key지만(secret 키워드 아님), 값이 base64 고엔트로피라 4번 층이 지운다.
    expect(out).not.toContain(highEntropy);
    // 저엔트로피 반복 문자열은 보존.
    expect(out).toContain(lowEntropy);
  });

  // ── R7 보강 패턴 ──────────────────────────────────────────────────────────
  it('AWS 계열 대문자 스네이크 credential env를 지운다(R7)', () => {
    const input = enc.encode(
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SESSION_TOKEN=FQoGZXIvYXdzE keep=me',
    );
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('FQoGZXIvYXdzE');
    // 키 이름은 남고 값만 마킹.
    expect(out).toContain('AWS_SECRET_ACCESS_KEY=[[REDACTED]]');
    expect(out).toContain('keep=me');
  });

  it('URL userinfo(scheme://user:pass@)를 지우되 호스트는 보존한다(R7)', () => {
    const input = enc.encode('git clone https://alice:s3cr3tPass@github.com/org/repo.git done');
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('s3cr3tPass');
    expect(out).not.toContain('alice:s3cr3tPass');
    expect(out).toContain('https://[[REDACTED]]@github.com/org/repo.git');
  });

  it('JSON/colon 형식("secret": "...")을 지우되 키는 보존한다(R7)', () => {
    const input = enc.encode('{"api_key": "sk_live_verysecretvalue123", "user": "bob"}');
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('sk_live_verysecretvalue123');
    expect(out).toContain('"api_key": "[[REDACTED]]"');
    // 비-secret 키/값은 보존.
    expect(out).toContain('"user": "bob"');
  });

  it('PEM 개인키 블록을 통째로 지운다(R7)', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn\nrandomkeymaterial\n-----END RSA PRIVATE KEY-----';
    const input = enc.encode(`before\n${pem}\nafter`);
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn');
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).toContain('[[REDACTED]]');
  });

  it('알려진 토큰 프리픽스(sk-/ghp_/gho_/xox)를 지운다(R7)', () => {
    const input = enc.encode(
      'openai sk-proj1234567890ABCDEFxyz github ghp_1234567890abcdefghijABCDEF12 slack xoxb-123456789012-abcdef done',
    );
    const out = dec.decode(scrub(input));
    expect(out).not.toContain('sk-proj1234567890ABCDEFxyz');
    expect(out).not.toContain('ghp_1234567890abcdefghijABCDEF12');
    expect(out).not.toContain('xoxb-123456789012-abcdef');
    expect(out).toContain('[[REDACTED]]');
    // 프리픽스 아닌 일반 텍스트는 보존.
    expect(out).toContain('openai');
    expect(out).toContain('done');
  });

  it('raw ANSI 제어시퀀스(SGR·커서)는 스크럽 후에도 보존된다', () => {
    const input = enc.encode('\x1b[1;31mBOLD-RED\x1b[0m\x1b[10;5H');
    const out = dec.decode(scrub(input));
    expect(out).toBe('\x1b[1;31mBOLD-RED\x1b[0m\x1b[10;5H');
  });

  it('writeMinedSeeds는 로컬 디렉토리에 .seed.bin으로 기록한다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wmux-miner-local-'));
    try {
      // 새 시그니처(R7): (seeds, outLocalDir). tmpdir은 저장소 바깥이라 격리 가드 통과.
      const written = writeMinedSeeds([{ sourceFile: '/x/y/session-1.buf', bytes: enc.encode('data') }], dir);
      expect(written.length).toBe(1);
      expect(path.basename(written[0])).toBe('session-1.seed.bin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // R7: 격리 가드 — 저장소 내 비-ignored 경로로 쓰려 하면 거부.
  it('writeMinedSeeds는 저장소 내 비-ignored 경로(예: corpus/)를 거부한다', () => {
    const repoCorpus = path.join(__dirname, '..', 'corpus'); // core/harness/corpus — 커밋 대상.
    expect(() =>
      writeMinedSeeds([{ sourceFile: '/x/session-x.buf', bytes: enc.encode('data') }], repoCorpus),
    ).toThrow(/격리 위반/);
  });

  it('writeMinedSeeds 기본 출력 루트는 core/harness/corpus-local/(저장소 내 유일 허용)', () => {
    // 기본 경로가 LOCAL_CORPUS_DIR와 일치하는지(가드가 이 경로만 저장소 내부에서 허용).
    expect(LOCAL_CORPUS_DIR.endsWith(path.join('core', 'harness', 'corpus-local'))).toBe(true);
  });
});
