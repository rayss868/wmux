// J2 — DiffPanel: 태스크 산출물 diff 리뷰·hunk 채택·코멘트 (스펙 §1·§3·§4)
//
// §6.J 문면 준수: "읽기·코멘트·체크아웃 3동작만 — 풀 IDE diff 에디터 금지."
// 파일 트리(numstat) + unified diff(+/- 색만) + hunk 체크박스 + 채택 버튼 +
// 실패 hunk 표시 + "적용됨"/"채택불가" 뱃지 + 코멘트 버튼.
import { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  DiffFile,
  DiffReadResult,
  DiffApplyRequest,
  DiffApplyResult,
  DiffTargetSnapshot,
} from '../../../shared/diffParse';

interface DiffPanelProps {
  taskId: string;
  isActive: boolean;
  surfaceId: string;
  /** 렌더러 신원 앵커(채널 포스트용). */
  verifiedWorkspaceId: string;
}

// 태스크 메타(task.mission.list에서 역참조).
interface TaskMeta {
  worktreePath: string;
  branch: string;
  missionChannelId: string;
  channelArchived: boolean;
}

// diff.read/applyHunks 브릿지(preload 노출).
interface DiffBridge {
  read: (worktreePath: string, targetHeadOid?: string) => Promise<DiffReadResult | { ok: false; error: string }>;
  applyHunks: (req: DiffApplyRequest, worktreePath: string) => Promise<DiffApplyResult>;
}

function getDiffBridge(): DiffBridge | null {
  const api = (window as unknown as { electronAPI?: { diff?: DiffBridge } }).electronAPI;
  return api?.diff ?? null;
}

// task.mission.list로 taskId → 워크트리·채널 역참조.
async function resolveTaskMeta(taskId: string, verifiedWorkspaceId: string): Promise<TaskMeta | null> {
  const api = (window as unknown as {
    electronAPI?: { rpc?: { invoke: (m: string, p: Record<string, unknown>) => Promise<unknown> } };
  }).electronAPI;
  if (!api?.rpc) return null;
  try {
    const res = (await api.rpc.invoke('task.mission.list', { verifiedWorkspaceId })) as {
      ok?: boolean;
      tasks?: Array<{
        id: string;
        worktreePath?: string;
        branch?: string;
        missionChannelId?: string;
      }>;
    };
    const task = res?.tasks?.find((t) => t.id === taskId);
    if (!task || !task.worktreePath) return null;
    // 채널 archived 여부(코멘트 버튼 게이팅). 실패는 비archived로 간주.
    let channelArchived = false;
    try {
      const chRes = (await api.rpc.invoke('a2a.channel.read', {
        verifiedWorkspaceId,
        channelId: task.missionChannelId,
        limit: 1,
      })) as { ok?: boolean; archived?: boolean; error?: string };
      channelArchived = chRes?.archived === true;
    } catch {
      /* 조회 실패 시 활성으로 간주 */
    }
    return {
      worktreePath: task.worktreePath,
      branch: task.branch ?? '',
      missionChannelId: task.missionChannelId ?? '',
      channelArchived,
    };
  } catch {
    return null;
  }
}

// hunk 라인에 +/- 색만 입힌다(신택스 하이라이팅 금지 — 비목표).
function HunkBody({ bodyLines }: { bodyLines: readonly string[] }) {
  return (
    <div className="font-mono text-[11px] leading-[1.5] whitespace-pre overflow-x-auto">
      {bodyLines.map((line, i) => {
        const c = line.charAt(0);
        const color =
          c === '+'
            ? 'text-[var(--accent-green,#4ade80)]'
            : c === '-'
              ? 'text-[var(--accent-red,#f87171)]'
              : 'text-[var(--text-sub)]';
        return (
          <div key={i} className={color}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

export default function DiffPanel({ taskId, isActive, surfaceId, verifiedWorkspaceId }: DiffPanelProps) {
  const [meta, setMeta] = useState<TaskMeta | null>(null);
  const [data, setData] = useState<DiffReadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // path → 선택된 hunk index Set.
  const [selection, setSelection] = useState<Record<string, Set<number>>>({});
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [failedProbes, setFailedProbes] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setApplyMsg(null);
    setFailedProbes(new Set());
    const m = await resolveTaskMeta(taskId, verifiedWorkspaceId);
    if (!m) {
      setError('태스크를 찾을 수 없음 — worktree 소실 또는 손상');
      setLoading(false);
      return;
    }
    setMeta(m);
    const bridge = getDiffBridge();
    if (!bridge) {
      setError('diff 브릿지 미가용');
      setLoading(false);
      return;
    }
    const res = await bridge.read(m.worktreePath);
    if (!res.ok) {
      setError(res.error);
      setData(null);
    } else {
      setData(res);
      if (res.files.length > 0) setSelectedFile(res.files[0].path);
    }
    setLoading(false);
  }, [taskId, verifiedWorkspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filesByPath = useMemo(() => {
    const map = new Map<string, DiffFile>();
    for (const f of data?.files ?? []) map.set(f.path, f);
    return map;
  }, [data]);

  const toggleHunk = useCallback((path: string, idx: number) => {
    setSelection((prev) => {
      const next = { ...prev };
      const set = new Set(next[path] ?? []);
      if (set.has(idx)) set.delete(idx);
      else set.add(idx);
      next[path] = set;
      return next;
    });
  }, []);

  const selectedCount = useMemo(
    () => Object.values(selection).reduce((s, set) => s + set.size, 0),
    [selection],
  );

  const handleAdopt = useCallback(async () => {
    if (!meta || !data) return;
    const bridge = getDiffBridge();
    if (!bridge) return;
    const selections = Object.entries(selection)
      .filter(([, set]) => set.size > 0)
      .map(([path, set]) => ({ path, hunkIndices: [...set].sort((a, b) => a - b) }));
    if (selections.length === 0) {
      setApplyMsg('선택된 hunk가 없습니다');
      return;
    }
    setApplying(true);
    setApplyMsg(null);
    setFailedProbes(new Set());
    const snapshot: DiffTargetSnapshot = data.snapshot;
    const req: DiffApplyRequest = { taskId, snapshot, selections };
    const res = await bridge.applyHunks(req, meta.worktreePath);
    setApplying(false);
    if (res.ok) {
      setApplyMsg(`채택 완료 — 타겟 워킹트리에 반영됨(${res.appliedFiles.length}파일). 커밋은 직접 하세요.`);
      // 재열람: 채택분은 여전히 태스크 worktree diff에 보이며 "적용됨" 뱃지로 표시됨.
      void load();
    } else {
      if (res.code === 'probe' && res.failedProbes) {
        setFailedProbes(new Set(res.failedProbes.map((p) => `${p.path}#${p.hunkIndex}`)));
        setApplyMsg('일부 hunk가 적용 불가 — 표시된 hunk를 해제하고 재시도하세요.');
      } else if (res.code === 'drift') {
        setApplyMsg('타겟이 이동됨 — diff를 재열람하세요.');
      } else if (res.code === 'dirty') {
        setApplyMsg(res.error);
      } else {
        setApplyMsg(res.error);
      }
    }
  }, [meta, data, selection, taskId, load]);

  // 코멘트 발사(§4): 미션 채널에 diff-comment 앵커 포스트(렌더러 channelLocal 경로).
  const handleComment = useCallback(
    async (file: string, hunkHeader: string) => {
      if (!meta || meta.channelArchived || !meta.missionChannelId) return;
      const text = window.prompt(`코멘트 (${file})`);
      if (!text) return;
      const api = (window as unknown as {
        electronAPI?: { rpc?: { mutateChannelLocal: (m: string, p: Record<string, unknown>) => Promise<unknown> } };
      }).electronAPI;
      if (!api?.rpc) return;
      await api.rpc.mutateChannelLocal('a2a.channel.post', {
        verifiedWorkspaceId,
        channelId: meta.missionChannelId,
        text,
        data: { kind: 'diff-comment', taskId, file, hunkHeader, side: 'new', line: 0 },
      });
      setApplyMsg('코멘트를 미션 채널에 발사했습니다.');
    },
    [meta, taskId, verifiedWorkspaceId],
  );

  const activeFile = selectedFile ? filesByPath.get(selectedFile) : null;

  return (
    <div
      className="absolute inset-0 flex flex-col bg-[var(--bg-base)]"
      style={{ display: isActive ? 'flex' : 'none' }}
      data-surface-id={surfaceId}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-surface)] border-b border-[var(--bg-mantle)] shrink-0 text-xs">
        <span className="text-[var(--text-main)] font-semibold">Diff</span>
        {meta && <span className="text-[var(--text-muted)] text-[10px]">{meta.branch}</span>}
        <div className="flex-1" />
        <button
          className="px-2 py-0.5 rounded text-[10px] bg-[var(--bg-base)] text-[var(--text-sub)] hover:text-[var(--text-main)] border border-[var(--bg-mantle)]"
          onClick={() => void load()}
        >
          Reload
        </button>
        <button
          className="px-2 py-0.5 rounded text-[10px] bg-[var(--accent-blue,#3b82f6)] text-white disabled:opacity-40"
          onClick={() => void handleAdopt()}
          disabled={applying || selectedCount === 0}
          title="선택한 hunk를 타겟 워킹트리에 채택"
        >
          {applying ? '채택 중...' : `채택 (${selectedCount})`}
        </button>
      </div>

      {applyMsg && (
        <div className="px-3 py-1 text-[11px] text-[var(--text-sub)] bg-[var(--bg-mantle)] border-b border-[var(--bg-mantle)] shrink-0">
          {applyMsg}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {loading && (
          <div className="flex items-center justify-center w-full text-[var(--text-muted)] text-sm">
            Loading...
          </div>
        )}
        {!loading && error && (
          <div className="flex items-center justify-center w-full text-[var(--text-muted)] text-sm">
            {error}
          </div>
        )}
        {!loading && !error && data && (
          <>
            {/* 파일 트리(numstat) */}
            <div className="w-56 shrink-0 overflow-y-auto border-r border-[var(--bg-mantle)] text-[11px]">
              {data.files.map((f) => {
                const num = data.numstat.find((n) => n.path === f.path);
                const isTrunc = data.truncated.includes(f.path);
                return (
                  <button
                    key={f.path}
                    className={`w-full text-left px-2 py-1 truncate hover:bg-[var(--bg-mantle)] ${
                      selectedFile === f.path ? 'bg-[var(--bg-mantle)] text-[var(--text-main)]' : 'text-[var(--text-sub)]'
                    }`}
                    onClick={() => setSelectedFile(f.path)}
                    title={f.path}
                  >
                    <span className="truncate">{f.path}</span>
                    {num && (
                      <span className="ml-1 text-[10px]">
                        <span className="text-[var(--accent-green,#4ade80)]">+{num.additions ?? '?'}</span>{' '}
                        <span className="text-[var(--accent-red,#f87171)]">-{num.deletions ?? '?'}</span>
                      </span>
                    )}
                    {!f.hunkSelectable && (
                      <span className="ml-1 text-[9px] text-[var(--text-muted)]">[{f.kind}·채택불가]</span>
                    )}
                    {isTrunc && <span className="ml-1 text-[9px] text-[var(--text-muted)]">[표시전용]</span>}
                  </button>
                );
              })}
            </div>

            {/* unified diff 뷰 + hunk 체크박스 */}
            <div className="flex-1 overflow-auto p-2">
              {!activeFile && <div className="text-[var(--text-muted)] text-sm">파일을 선택하세요</div>}
              {activeFile && activeFile.hunks.length === 0 && (
                <div className="text-[var(--text-muted)] text-xs">
                  {activeFile.kind} — 표시 전용(hunk 없음 또는 채택 불가)
                </div>
              )}
              {activeFile &&
                activeFile.hunks.map((hunk, idx) => {
                  const key = `${activeFile.path}#${idx}`;
                  const checked = selection[activeFile.path]?.has(idx) ?? false;
                  const failed = failedProbes.has(key);
                  return (
                    <div key={idx} className="mb-2 border border-[var(--bg-mantle)] rounded overflow-hidden">
                      <div className="flex items-center gap-2 px-2 py-1 bg-[var(--bg-surface)] text-[10px]">
                        {activeFile.hunkSelectable && (
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleHunk(activeFile.path, idx)}
                            title="이 hunk를 채택 대상으로 선택"
                          />
                        )}
                        <span className="font-mono text-[var(--text-sub)] truncate">{hunk.header}</span>
                        {failed && (
                          <span className="text-[9px] text-[var(--accent-red,#f87171)]">채택불가</span>
                        )}
                        <div className="flex-1" />
                        {!meta?.channelArchived && meta?.missionChannelId && (
                          <button
                            className="text-[9px] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                            onClick={() => void handleComment(activeFile.path, hunk.header)}
                            title="이 hunk에 코멘트"
                          >
                            💬
                          </button>
                        )}
                        {meta?.channelArchived && (
                          <span className="text-[9px] text-[var(--text-muted)]" title="채널 아카이브됨">
                            코멘트 비활성
                          </span>
                        )}
                      </div>
                      <div className="px-2 py-1">
                        <HunkBody bodyLines={hunk.bodyLines} />
                      </div>
                    </div>
                  );
                })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
