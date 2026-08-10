import { listWorktreePods } from '#platform/k8s'
import { isTmuxSessionAlive } from '#runtime/status'
import { resolveProjectConfig } from '#store/projects'
import { hasWorktreeForwarders, provisionWorktreeForwarders } from './port-forwarders'

interface RestoreCandidate {
  jobName: string
  projectSlug: string
  worktreeId: string
}

/**
 * Rebuild port forwarders for every live worktree pod.
 *
 * The forwarder registry is in-memory, so a server restart loses it while the
 * pods keep running with a tmux `status-right` still advertising ports that
 * are no longer forwarded. Without this pass the bars lie. Run once as the
 * server attaches to the substrate, before it serves anything.
 *
 * Every step is skipped rather than retried: a pod that isn't running, one
 * that already has forwarders (nothing was lost), and one whose tmux is gone
 * (the reaper's business, not this pass's).
 */
export async function restoreAllWorktreeForwarders(): Promise<void> {
  let pods
  try {
    pods = await listWorktreePods()
  } catch (err) {
    console.error('[server] restore forwarders: list session pods failed:', err)
    return
  }

  const candidates: RestoreCandidate[] = []
  for (const p of pods) {
    if (!p.running) continue
    if (!p.worktreeId || !p.projectSlug || !p.jobName) continue
    if (hasWorktreeForwarders(p.worktreeId)) continue
    if (!(await isTmuxSessionAlive(p.projectSlug, p.worktreeId))) continue
    candidates.push({ jobName: p.jobName, projectSlug: p.projectSlug, worktreeId: p.worktreeId })
  }

  await Promise.allSettled(candidates.map(async ({ jobName, projectSlug, worktreeId }) => {
    try {
      const config = await resolveProjectConfig(projectSlug) ?? {}
      await provisionWorktreeForwarders(projectSlug, worktreeId, jobName, config.portForward)
    } catch (err) {
      console.error(
        `[server] restore forwarders for ${worktreeId.slice(0, 8)}: `
        + (err instanceof Error ? err.message : String(err)),
      )
    }
  }))
}
