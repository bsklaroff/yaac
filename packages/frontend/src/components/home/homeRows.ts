import { isSessionUnread, isUnreadWaiting, unseenDeaths } from '#lib/store'
import type { ProjectSummary, ProvisioningWorkspaceEntry, WorkspaceListEntry } from '@yaac/shared/types'
import type { YStatusKind } from '#ui'

/*
 * Home's view of every project at once: the sessions that need the viewer,
 * those working, and those done, as the Home sidebar and inbox list them,
 * and each project's state for its rail tile and card.
 */

export type HomeSection = 'need' | 'working' | 'done'

export interface HomeRow {
  id: string
  projectId: string
  title: string
  status: YStatusKind
  section: HomeSection
  /** What it needs or how it ended, in words. */
  sub?: string
  /** Waiting on the viewer: a question, or finished and not yet seen. */
  unread: boolean
  /** When its current state began (epoch ms), for ordering. */
  order: number
  /** The same, when it is known: absent for a waiting spell the server
   *  restamped on restarting, so no age is shown for it. */
  since?: number
  workspace?: WorkspaceListEntry
}

/* How long after the server starts a waiting spell may still be the one its
 * restart stamped while re-attaching every workspace. */
const RESTART_STAMP_MS = 60_000

function rowOf(w: WorkspaceListEntry, me: string | undefined, startedAtMs: number): HomeRow {
  const unread = isUnreadWaiting(w, me)
  const created = Date.parse(`${w.createdAt.replace(' ', 'T')}Z`)
  const waiting = w.waitingSinceMs
  const since = waiting === undefined ? created : waiting > startedAtMs + RESTART_STAMP_MS ? waiting : undefined
  const base = {
    id: w.workspaceId,
    projectId: w.projectId,
    title: w.title || w.prompt || 'New workspace',
    order: waiting ?? created,
    ...(since !== undefined && !Number.isNaN(since) ? { since } : {}),
    workspace: w,
  }
  if (w.asking === true) return { ...base, status: 'need', section: 'need', sub: 'Waiting for your answer', unread: true }
  if (w.status === 'running') return { ...base, status: 'work', section: 'working', unread: false }
  if (w.status === 'background') return { ...base, status: 'bg', section: 'working', unread: false }
  if (w.status === 'idle') return { ...base, status: 'stop', section: 'done', sub: 'No agent running', unread: false }
  return { ...base, status: 'done', section: 'done', sub: unread ? 'Finished since you looked' : undefined, unread }
}

/** Home's list sections, in the order it shows them. */
export const HOME_SECTIONS = ['need', 'working', 'done'] as const satisfies readonly HomeSection[]

/** Rows in the order Home's list shows them, for stepping through it. */
export function homeListOrder(rows: HomeRow[]): HomeRow[] {
  return HOME_SECTIONS.flatMap((section) => rows.filter((r) => r.section === section))
}

/** Every live and starting workspace as a Home row, in its section's
 *  order: what needs you oldest first, the rest newest first. */
export function homeRows(
  workspaces: WorkspaceListEntry[],
  provisioning: ProvisioningWorkspaceEntry[],
  me: string | undefined,
  pendingDeleteIds: string[] = [],
  startedAtMs = 0,
): HomeRow[] {
  const live = workspaces
    .filter((w) => !w.stopping && !pendingDeleteIds.includes(w.workspaceId))
    .map((w) => rowOf(w, me, startedAtMs))
  const starting = provisioning
    .filter((p) => !p.stopping && !live.some((r) => r.id === p.workspaceId))
    .map((p): HomeRow => ({
      id: p.workspaceId,
      projectId: p.projectId,
      title: p.title ?? 'New workspace',
      status: p.error !== undefined ? 'fail' : 'work',
      section: p.error !== undefined ? 'need' : 'working',
      sub: p.error !== undefined ? 'Couldn’t start' : 'Starting',
      unread: p.error !== undefined,
      order: Date.now(),
    }))
  const rank: Record<HomeSection, number> = { need: 0, working: 1, done: 2 }
  return [...live, ...starting].sort((a, b) =>
    rank[a.section] - rank[b.section]
    || (a.section === 'need' ? a.order - b.order : Number(b.unread) - Number(a.unread) || b.order - a.order))
}

/** The sessions of a workspace the viewer has not seen finish. */
export function unreadSessions(w: WorkspaceListEntry, me: string | undefined): WorkspaceListEntry['sessions'] {
  return w.sessions.filter((s) => isSessionUnread(s, me))
}

/** How each project's tile shows what is going on in it: agents working,
 *  and whether something failed there that the viewer has not seen. */
export function projectActivity(
  projects: ProjectSummary[],
  workspaces: WorkspaceListEntry[],
  provisioning: ProvisioningWorkspaceEntry[],
  me: string | undefined,
): Record<string, { agents: number; failed: boolean }> {
  const out: Record<string, { agents: number; failed: boolean }> = {}
  for (const p of projects) out[p.id] = { agents: 0, failed: unseenDeaths(p, me) > 0 }
  for (const w of workspaces) {
    const t = out[w.projectId]
    if (t && !w.stopping && (w.status === 'running' || w.status === 'background')) t.agents += 1
  }
  for (const p of provisioning) {
    const t = out[p.projectId]
    if (t && p.error !== undefined && !p.stopping) t.failed = true
  }
  return out
}

/** A short age for a list's right edge: "now", "4m", "2h", "3d". */
export function shortAge(since: number, now: number): string {
  const m = Math.floor(Math.max(0, now - since) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}
