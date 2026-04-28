/**
 * Module-level resolver for the A2A execute confirmation dialog.
 *
 * The main process asks renderer "may I spawn a bypassPermissions Claude CLI
 * for this incoming a2a task?" via the `a2a.confirmExecute` RPC. The handler
 * in useRpcBridge stores the approval prompt in zustand and parks the resolver
 * here so the dialog component can call it once the user clicks Approve/Deny.
 */

type Resolver = (approved: boolean) => void;

let pendingResolver: Resolver | null = null;

export function setExecuteApprovalResolver(resolver: Resolver): void {
  pendingResolver = resolver;
}

export function resolveExecuteApproval(approved: boolean): void {
  const resolver = pendingResolver;
  pendingResolver = null;
  if (resolver) resolver(approved);
}

export function hasPendingExecuteApproval(): boolean {
  return pendingResolver !== null;
}
