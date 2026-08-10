// The public interface of the k8s runtime's worktree observation: which
// worktrees the substrate is running, resolved and described in the
// vocabulary of `#runtime/contract` — plus the image-salvage sweep that
// must run against live pods. Modules in here import each other by
// relative path; everything outside imports `#runtime/k8s/worktrees`.
export { getWorktreeChanges, worktreeForkFallback } from './changes'
export {
  countProjectWorkspaces,
  countWorkspaces,
  findWorkspace,
  listWorkspaces,
} from './locate'
export { observeWorkspaces } from './observe'
export { reconcileImageSalvage } from './salvage-reconcile'
