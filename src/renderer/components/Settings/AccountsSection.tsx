import { useState, useEffect, useCallback, useRef } from 'react';
import type { Account } from '../../../main/account/accountStore';
import type { CredentialStatus } from '../../../main/ipc/handlers/account.handler';

type Vendor = 'claude' | 'codex';
type AccountRow = Account & { status: CredentialStatus };

// ─── Settings → Accounts (M1) ────────────────────────────────────────────────
//
// Registry management + guided onboarding for multi-account. Onboarding
// provisions an isolated (hybrid-shared) config dir, then hands the user the
// exact one-line command to log in there; the wizard polls credentialStatus and
// commits the account automatically once login lands. wmux never touches the
// OAuth flow itself. Hidden entirely when the preload doesn't expose accounts.

function statusBadge(status: CredentialStatus): React.ReactElement {
  if (status.loggedIn) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'var(--accent-green)', background: 'color-mix(in srgb, var(--accent-green) 12%, transparent)' }}>
        {status.subscriptionType ? status.subscriptionType : 'logged in'}
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'var(--accent-red)', background: 'color-mix(in srgb, var(--accent-red) 12%, transparent)' }}>
      logged out
    </span>
  );
}

function loginCommand(vendor: Vendor, configDir: string): string {
  // Single-line (owner preference): paste into any wmux terminal, then follow
  // the vendor's prompt (claude: /login · codex: interactive).
  return vendor === 'codex'
    ? `$env:CODEX_HOME='${configDir}'; codex auth login`
    : `$env:CLAUDE_CONFIG_DIR='${configDir}'; claude`;
}

function AddAccountWizard({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }): React.ReactElement {
  const [vendor, setVendor] = useState<Vendor>('claude');
  const [name, setName] = useState('');
  const [share, setShare] = useState(true);
  const [configDir, setConfigDir] = useState<string | null>(null);
  const [phase, setPhase] = useState<'form' | 'login' | 'done'>('form');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => stopPoll, []);

  const prepare = useCallback(async () => {
    setError(null);
    const api = window.electronAPI?.accounts;
    if (!api) return;
    if (!name.trim()) { setError('Enter a name'); return; }
    try {
      const res = await api.onboardPrepare({ vendor, share });
      setConfigDir(res.configDir);
      setPhase('login');
      // Poll for login completion (credential file appears in the config dir).
      pollRef.current = setInterval(() => {
        void api.credentialStatus({ vendor, configDir: res.configDir }).then((st) => {
          if (st.loggedIn) {
            stopPoll();
            void api.add({ name: name.trim(), vendor, configDir: res.configDir })
              .then(() => { setPhase('done'); })
              .catch((e) => setError(String(e?.message ?? e)));
          }
        }).catch(() => { /* transient — keep polling */ });
      }, 2000);
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    }
  }, [vendor, name, share]);

  return (
    <div className="mt-2 p-3 rounded-[7px]" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-overlay)' }}>
      {phase === 'form' && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            {(['claude', 'codex'] as const).map((v) => (
              <button
                key={v}
                className="px-2 py-1 text-xs rounded transition-colors"
                style={vendor === v
                  ? { color: 'var(--accent-amber)', background: 'color-mix(in srgb, var(--accent-amber) 14%, transparent)' }
                  : { color: 'var(--text-muted)', background: 'var(--bg-overlay)' }}
                onClick={() => setVendor(v)}
              >
                {v === 'claude' ? 'Claude' : 'Codex'}
              </button>
            ))}
          </div>
          <input
            className="px-2 py-1 text-xs rounded bg-[var(--bg-overlay)] text-[var(--text-main)] outline-none"
            placeholder="Account name (e.g. Work Max)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
            Copy default settings (MCP · skills · plugins shared, login separate)
          </label>
          {error && <div className="text-[10px] text-[var(--accent-red)]">{error}</div>}
          <div className="flex justify-end gap-2">
            <button className="px-2 py-1 text-xs rounded text-[var(--text-subtle)] hover:bg-[var(--bg-overlay)]" onClick={onCancel}>Cancel</button>
            <button className="px-2 py-1 text-xs rounded" style={{ color: 'var(--accent-amber)', background: 'color-mix(in srgb, var(--accent-amber) 14%, transparent)' }} onClick={prepare}>Create & log in</button>
          </div>
        </div>
      )}
      {phase === 'login' && configDir && (
        <div className="flex flex-col gap-2">
          <div className="text-xs text-[var(--text-main)]">
            Run this in any terminal, then complete login{vendor === 'claude' ? ' with /login' : ''}:
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-2 py-1 text-[11px] rounded bg-[var(--bg-overlay)] text-[var(--accent-blue)] font-mono truncate" title={loginCommand(vendor, configDir)}>
              {loginCommand(vendor, configDir)}
            </code>
            <button
              className="px-2 py-1 text-[10px] rounded text-[var(--text-subtle)] hover:bg-[var(--bg-overlay)]"
              onClick={() => {
                void window.clipboardAPI?.writeText(loginCommand(vendor, configDir));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {share && (
            <div className="text-[10px] text-[var(--text-muted)]">
              This is an independent profile — settings/MCP/skills copied from your default; login stays separate.
            </div>
          )}
          <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
            <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--accent-amber)' }} />
            Waiting for login…
          </div>
          {error && <div className="text-[10px] text-[var(--accent-red)]">{error}</div>}
          <div className="flex justify-end">
            <button className="px-2 py-1 text-xs rounded text-[var(--text-subtle)] hover:bg-[var(--bg-overlay)]" onClick={() => { stopPoll(); onCancel(); }}>Cancel</button>
          </div>
        </div>
      )}
      {phase === 'done' && (
        <div className="flex flex-col gap-2">
          <div className="text-xs" style={{ color: 'var(--accent-green)' }}>✓ Account added.</div>
          <div className="flex justify-end">
            <button className="px-2 py-1 text-xs rounded" style={{ color: 'var(--accent-amber)', background: 'color-mix(in srgb, var(--accent-amber) 14%, transparent)' }} onClick={onDone}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AccountsSection(): React.ReactElement | null {
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const reload = useCallback(() => {
    const api = window.electronAPI?.accounts;
    if (!api) { setLoaded(true); return; }
    void api.list().then((res) => { setRows(res.accounts); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Hidden when the preload predates multi-account.
  if (!window.electronAPI?.accounts) return null;

  const remove = (id: string) => {
    const api = window.electronAPI?.accounts;
    if (api) void api.remove(id).then(reload).catch(() => { /* useIpc surfaces the error */ });
    setConfirmRemove(null);
  };
  const rename = (id: string) => {
    const api = window.electronAPI?.accounts;
    if (api && editName.trim()) {
      void api.rename({ id, name: editName.trim() }).then(reload).catch(() => { /* useIpc surfaces the error */ });
    }
    setEditingId(null);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Accounts</div>
      {loaded && rows.length === 0 && !adding && (
        <div className="text-xs text-[var(--text-muted)]">No accounts yet. Add one to bind different subscriptions per workspace.</div>
      )}
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-2 py-1">
          <span className="text-[10px] px-1 rounded bg-[var(--bg-overlay)] text-[var(--text-subtle)]">{r.vendor}</span>
          {editingId === r.id ? (
            <input
              className="flex-1 px-2 py-0.5 text-xs rounded bg-[var(--bg-overlay)] text-[var(--text-main)] outline-none"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') rename(r.id); if (e.key === 'Escape') setEditingId(null); }}
              onBlur={() => rename(r.id)}
              autoFocus
            />
          ) : (
            <button className="flex-1 text-left text-xs text-[var(--text-main)] truncate hover:underline" onClick={() => { setEditingId(r.id); setEditName(r.name); }}>
              {r.name}
            </button>
          )}
          {statusBadge(r.status)}
          {confirmRemove === r.id ? (
            <>
              <button className="text-[10px] text-[var(--accent-red)]" onClick={() => remove(r.id)}>Remove</button>
              <button className="text-[10px] text-[var(--text-subtle)]" onClick={() => setConfirmRemove(null)}>Cancel</button>
            </>
          ) : (
            <button className="text-[10px] text-[var(--text-subtle)] hover:text-[var(--accent-red)]" onClick={() => setConfirmRemove(r.id)} title="Unregister (does not delete the directory)">×</button>
          )}
        </div>
      ))}
      {adding ? (
        <AddAccountWizard onDone={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />
      ) : (
        <button className="self-start mt-1 px-2 py-1 text-xs rounded text-[var(--accent-amber)] hover:bg-[var(--bg-overlay)]" onClick={() => setAdding(true)}>
          + Add account
        </button>
      )}
    </div>
  );
}
