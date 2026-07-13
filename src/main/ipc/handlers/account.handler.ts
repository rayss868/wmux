// ─── Multi-Account — renderer → main IPC (registry CRUD + bindings) ──────────
//
// Renderer-only trust boundary (ipcMain.handle): main owns accounts.json and is
// the ONLY place spawn env is resolved. The renderer edits names/bindings and
// drives onboarding, but never sees or writes a token.

import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { getWmuxDir } from '../../../daemon/config';
import {
  getAccountStore,
  AccountError,
  type Vendor,
  type Account,
} from '../../account/accountStore';
import { provisionAccountDir } from '../../account/accountProvision';
import { loadClaudeCredential } from '../../claude/claudeCredential';

function isVendor(v: unknown): v is Vendor {
  return v === 'claude' || v === 'codex';
}

function assertString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v) throw new AccountError('invalid', `${field} is required`);
  return v;
}

export interface CredentialStatus {
  loggedIn: boolean;
  /** claude only: subscription tier when known (pro/max/team). */
  subscriptionType?: string | null;
  /** why not logged in / unsupported, for the UI. */
  detail?: string;
}

/** Resolve login status + tier for one account's config dir. */
async function credentialStatus(vendor: Vendor, configDir: string): Promise<CredentialStatus> {
  if (vendor === 'codex') {
    // Codex has no public usage API in v1; login = auth.json presence in CODEX_HOME.
    return { loggedIn: fs.existsSync(path.join(configDir, 'auth.json')) };
  }
  const res = await loadClaudeCredential(configDir);
  if (res.ok) return { loggedIn: true, subscriptionType: res.credential.subscriptionType };
  return { loggedIn: false, detail: res.reason };
}

export interface AccountRow extends Account {
  status: CredentialStatus;
}

export function registerAccountHandlers(): () => void {
  const channels = [
    IPC.ACCOUNT_LIST,
    IPC.ACCOUNT_ONBOARD_PREPARE,
    IPC.ACCOUNT_ADD,
    IPC.ACCOUNT_RENAME,
    IPC.ACCOUNT_REMOVE,
    IPC.ACCOUNT_SET_BINDING,
    IPC.ACCOUNT_CREDENTIAL_STATUS,
  ];
  for (const c of channels) ipcMain.removeHandler(c);

  // List accounts + bindings, each row annotated with live credential status.
  ipcMain.handle(IPC.ACCOUNT_LIST, wrapHandler(IPC.ACCOUNT_LIST, async () => {
    const store = getAccountStore();
    store.load();
    const accounts = store.listAccounts();
    const rows: AccountRow[] = await Promise.all(
      accounts.map(async (a) => ({ ...a, status: await credentialStatus(a.vendor, a.configDir) })),
    );
    return { accounts: rows, bindings: store.getBindings() };
  }));

  // Provision an isolated config dir for a NEW account (hybrid share by
  // default), returning the path the renderer points a login pane at. The
  // account is NOT registered yet — the renderer commits ACCOUNT_ADD after login.
  ipcMain.handle(IPC.ACCOUNT_ONBOARD_PREPARE, wrapHandler(IPC.ACCOUNT_ONBOARD_PREPARE,
    async (_e, args: { vendor: unknown; share?: unknown }) => {
      if (!isVendor(args?.vendor)) throw new AccountError('invalid', 'invalid vendor');
      const share = args.share !== false; // default: hybrid share ON
      const configDir = path.join(getWmuxDir(), 'accounts', `${args.vendor}-${randomUUID().slice(0, 8)}`);
      const result = provisionAccountDir({ configDir, vendor: args.vendor, share });
      return result;
    }));

  // Register an account (post-login). configDir is canonicalized + deduped in
  // the store.
  ipcMain.handle(IPC.ACCOUNT_ADD, wrapHandler(IPC.ACCOUNT_ADD,
    async (_e, args: { name: unknown; vendor: unknown; configDir: unknown }) => {
      const name = assertString(args?.name, 'name');
      if (!isVendor(args?.vendor)) throw new AccountError('invalid', 'invalid vendor');
      const configDir = assertString(args?.configDir, 'configDir');
      return getAccountStore().addAccount({ name, vendor: args.vendor, configDir });
    }));

  ipcMain.handle(IPC.ACCOUNT_RENAME, wrapHandler(IPC.ACCOUNT_RENAME,
    async (_e, args: { id: unknown; name: unknown }) => {
      await getAccountStore().renameAccount(assertString(args?.id, 'id'), assertString(args?.name, 'name'));
      return { ok: true };
    }));

  // Remove = unregister only (never deletes the dir). Returns affected workspaces.
  ipcMain.handle(IPC.ACCOUNT_REMOVE, wrapHandler(IPC.ACCOUNT_REMOVE,
    async (_e, args: { id: unknown }) => {
      const affected = await getAccountStore().removeAccount(assertString(args?.id, 'id'));
      return { ok: true, affectedWorkspaceIds: affected };
    }));

  ipcMain.handle(IPC.ACCOUNT_SET_BINDING, wrapHandler(IPC.ACCOUNT_SET_BINDING,
    async (_e, args: { workspaceId: unknown; vendor: unknown; accountId?: unknown }) => {
      const workspaceId = assertString(args?.workspaceId, 'workspaceId');
      if (!isVendor(args?.vendor)) throw new AccountError('invalid', 'invalid vendor');
      const accountId = typeof args?.accountId === 'string' && args.accountId ? args.accountId : undefined;
      await getAccountStore().setBinding(workspaceId, args.vendor, accountId);
      return { ok: true };
    }));

  // Poll target during onboarding (login-completion detection) + refresh rows.
  ipcMain.handle(IPC.ACCOUNT_CREDENTIAL_STATUS, wrapHandler(IPC.ACCOUNT_CREDENTIAL_STATUS,
    async (_e, args: { vendor: unknown; configDir: unknown }): Promise<CredentialStatus> => {
      if (!isVendor(args?.vendor)) throw new AccountError('invalid', 'invalid vendor');
      return credentialStatus(args.vendor, assertString(args?.configDir, 'configDir'));
    }));

  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
