// ─── Broadcast 팝오버 ────────────────────────────────────────────────────────
//
// 활성 워크스페이스의 모든 terminal surface(에이전트가 아닌 일반 셸 포함)에 같은
// 텍스트를 동시에 주입한다. 예전엔 window.prompt로 받았으나 preload에 prompt
// 폴리필이 없어 실질적으로 사망 상태였다(Electron) — 인라인 recessed 팝오버로 복구.
//
// 스코프는 현행 유지: "현재 워크스페이스의 모든 터미널 페인"(fan-out 같은 격리·
// worktree 생성 없음). 대상 개수를 "N terminals"로 미리 표기해 "함대만 대상"으로
// 오독되지 않게 한다(Codex 리뷰). 전송은 Promise.allSettled로 감싸 한 페인이 실패해도
// 나머지가 진행되고, 성공/실패 카운트를 표시한다.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { selectActiveWorkspace } from '../../stores/selectors/workspaceProjections';
import { useT } from '../../hooks/useT';
import { findLeafPanes } from '../../hooks/a2aAddressing';
import type { Workspace } from '../../../shared/types';
import { injectText } from './inject';

interface BroadcastPopoverProps {
  onClose: () => void;
}

/** 활성 워크스페이스의 모든 terminal surface ptyId를 중복 없이 수집(순수 — 테스트용). */
export function collectBroadcastPtyIds(workspace: Workspace): string[] {
  const seen = new Set<string>();
  for (const leaf of findLeafPanes(workspace.rootPane)) {
    for (const s of leaf.surfaces) {
      if (s.ptyId && (s.surfaceType ?? 'terminal') === 'terminal') seen.add(s.ptyId);
    }
  }
  return [...seen];
}

export default function BroadcastPopover({ onClose }: BroadcastPopoverProps): React.ReactElement {
  const t = useT();
  const activeWorkspace = useStore(selectActiveWorkspace);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: number; fail: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 더블 서밋 방지: React state는 비동기라 같은 틱의 두 번째 클릭이 stale sending을
  // 보고 통과한다 — 동기 ref로 잠근다.
  const sendingRef = useRef(false);

  const ptyIds = useMemo(
    () => (activeWorkspace ? collectBroadcastPtyIds(activeWorkspace) : []),
    [activeWorkspace],
  );

  // 열릴 때 textarea 포커스.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Esc·외부 클릭 닫기.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const handleSend = useCallback(async () => {
    if (sendingRef.current) return;
    const body = text.trim();
    if (body.length === 0 || ptyIds.length === 0) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const settled = await Promise.allSettled(ptyIds.map((id) => injectText(id, text, true)));
      const ok = settled.filter((r) => r.status === 'fulfilled').length;
      setResult({ ok, fail: settled.length - ok });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [text, ptyIds]);

  const targetCount = ptyIds.length;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('toolbar.broadcastTitle')}
      data-testid="broadcast-popover"
      className="absolute bottom-full right-2 mb-2 z-50 w-80 rounded-[7px] border border-[var(--bg-overlay)] bg-[var(--bg-mantle)] p-3 shadow-xl"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-semibold text-[var(--text-main)]">{t('toolbar.broadcastTitle')}</span>
        <span className="text-[10px] text-[var(--text-muted)]" data-testid="broadcast-targets">
          {t('toolbar.broadcastTargets', { n: targetCount })}
        </span>
      </div>
      <textarea
        ref={textareaRef}
        className="ui-input h-20 resize-none font-mono text-[12px]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter로 전송(일반 Enter는 줄바꿈).
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void handleSend();
          }
        }}
        placeholder={t('toolbar.broadcastPlaceholder')}
        data-testid="broadcast-input"
      />
      <div className="flex items-center justify-between mt-2">
        <span className="text-[10px] text-[var(--text-muted)]" data-testid="broadcast-result">
          {result ? t('toolbar.broadcastResult', { ok: result.ok, fail: result.fail }) : ''}
        </span>
        <button
          type="button"
          disabled={sending || targetCount === 0 || text.trim().length === 0}
          onClick={() => void handleSend()}
          data-testid="broadcast-send"
          className="px-2.5 py-1 rounded-[5px] text-[11px] font-semibold bg-[var(--accent)] text-[var(--bg-base)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sending ? t('toolbar.broadcastSending') : t('toolbar.broadcastSend')}
        </button>
      </div>
    </div>
  );
}
