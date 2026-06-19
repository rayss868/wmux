/**
 * Module-level resolvers for A2A execute confirmation dialogs.
 *
 * The renderer parks one resolver per approval prompt so concurrent
 * `execute:true` requests cannot overwrite each other. Dialog surfaces pass
 * the approvalId back when the user clicks Approve/Deny.
 */

type Resolver = (approved: boolean) => void;

const pendingResolvers = new Map<string, Resolver>();

export function setExecuteApprovalResolver(approvalId: string, resolver: Resolver): void {
  pendingResolvers.set(approvalId, resolver);
}

export function resolveExecuteApproval(approvalId: string, approved: boolean): void {
  const resolver = pendingResolvers.get(approvalId);
  pendingResolvers.delete(approvalId);
  if (resolver) resolver(approved);
}

export function hasPendingExecuteApproval(approvalId?: string): boolean {
  return approvalId ? pendingResolvers.has(approvalId) : pendingResolvers.size > 0;
}
