import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { CompletionEvidence } from '../../../shared/types';
import { isVerifiedItem } from '../../../shared/completionEvidence';

// ClaudeWorker.updateTaskStatus 는 _bridge.sendToRenderer 로 렌더러에 wire payload 를
// 보낸다. _bridge 는 electron(ipcMain)을 끌어오므로 vitest 에서 반드시 mock — 대신
// 캡처된 payload 로 (A′) 정직 증거 shape 를 어서션한다.
const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: sendToRendererMock }));

import { ClaudeWorker } from '../ClaudeWorker';

const fakeWindow = {} as BrowserWindow;

/** private processLine 을 모의 result 라인으로 직접 구동하고 캡처된 wire payload 를 돌려준다. */
async function drivenResult(line: string, sessionId: string | null = 'sess-abc'): Promise<Record<string, unknown>> {
  sendToRendererMock.mockClear();
  const worker = new ClaudeWorker(() => fakeWindow);
  const session = { proc: {} as never, taskId: 'task-1', lineBuffer: '', sessionId };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (worker as any).processLine(session, 'ws-receiver', line);
  await Promise.resolve(); // fire-and-forget updateTaskStatus 의 마이크로태스크 플러시
  const call = sendToRendererMock.mock.calls.at(-1);
  expect(call?.[1]).toBe('a2a.task.update');
  return call?.[2] as Record<string, unknown>;
}

describe('ClaudeWorker — (A′) 정직 증거 생산 (§6.M P1 PR-D′)', () => {
  beforeEach(() => sendToRendererMock.mockClear());

  it('is_error:false → completed + inspection/unverified 증거 (command/passed 로 승격 금지)', async () => {
    const payload = await drivenResult(
      JSON.stringify({ type: 'result', result: 'done the thing', is_error: false, total_cost_usd: 0.0123 }),
    );
    expect(payload.status).toBe('completed');
    const ev = payload.evidence as CompletionEvidence;
    expect(ev.summary).toBe('done the thing');
    expect(ev.items).toHaveLength(1);
    const item = ev.items[0];
    // 세탁 불가(CL1): run-success 는 절대 command/passed(verified)로 올라가지 않는다.
    expect(item.kind).toBe('inspection');
    expect(item.status).toBe('unverified');
    expect(item).not.toHaveProperty('command');
    expect(item.summary).toMatch(/self-reported/);
    if (item.kind === 'inspection' || item.kind === 'artifact') {
      expect(item.location).toBe('claude -p (stream-json)');
    }
    expect(item.output).toContain('session=sess-abc');
    expect(item.output).toContain('cost=$0.0123');
    // 등급 산출기가 이 아이템을 verified 로 세지 않음 (verifiedItemCount=0 이 될 것).
    expect(isVerifiedItem(item)).toBe(false);
  });

  it('C7: 빈 result 텍스트 → 기본 summary 로 빈 summary 자기거부 방지', async () => {
    const payload = await drivenResult(
      JSON.stringify({ type: 'result', result: '', is_error: false, total_cost_usd: 0 }),
    );
    const ev = payload.evidence as CompletionEvidence;
    expect(ev.summary).toBe('agent run completed (empty result text)');
    expect(ev.items).toHaveLength(1);
    expect(isVerifiedItem(ev.items[0])).toBe(false);
  });

  it('sessionId 부재 → output 에 session=? 폴백 (자기거부 없음)', async () => {
    const payload = await drivenResult(
      JSON.stringify({ type: 'result', result: 'ok', is_error: false }),
      null,
    );
    const ev = payload.evidence as CompletionEvidence;
    expect(ev.items[0].output).toContain('session=?');
    expect(ev.items[0].output).toContain('cost=$?');
  });

  it('is_error:true → failed + Error: 사유 + inspection/unverified 진단 아이템 (X8 형태 통과)', async () => {
    const payload = await drivenResult(
      JSON.stringify({ type: 'result', result: 'boom', is_error: true, total_cost_usd: 0.5 }),
    );
    expect(payload.status).toBe('failed');
    const ev = payload.evidence as CompletionEvidence;
    expect(ev.summary).toBe('Error: boom');
    expect(ev.items).toHaveLength(1);
    expect(ev.items[0].kind).toBe('inspection');
    expect(ev.items[0].status).toBe('unverified');
    expect(ev.items[0].summary).toBe('claude CLI run reported error');
  });

  it('is_error:true + 빈 result → 기본 실패 사유', async () => {
    const payload = await drivenResult(
      JSON.stringify({ type: 'result', result: '', is_error: true }),
    );
    expect((payload.evidence as CompletionEvidence).summary).toBe('Error: agent run failed');
  });
});
