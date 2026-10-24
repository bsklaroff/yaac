/**
 * Group workspace limits (docs/workspace-groups.md). A group with a
 * `workspaceLimit` holds at most that many live workspaces: those the
 * runtime runs (as the sidebar counts them), creates and restarts still
 * provisioning, and queued launches and moves under way.
 *
 * A check comes in two halves. `readGroupRoom` reads the rows and the
 * runtime, which takes an await; `groupFull` then adds what this process has
 * in flight and answers synchronously. A caller takes the slot in that same
 * synchronous step (registering its provisioning row, or `reserveGroupSlot`),
 * so of two concurrent entries only one can see the last free slot. Every
 * way in registers in memory before it runs, and a provision that settles
 * after the read is counted from `wentLiveSince`, so the read may lag but
 * does not hide a slot that is taken.
 *
 * A row counts only while the runtime has it: a failed create's row, or a
 * half-made one a server restart interrupted, lingers until it is cleaned up
 * or reaped, and holds nothing in the meantime.
 */
import { listProvisioning, wentLiveSince } from './provisioning'
import { workspaceDriver } from '#drivers/driver'
import { getProjectWorkspaceRows, listWorkspaceGroupRows } from '#db'
import { ServerError } from '@yaac/shared/errors'

/** A limited group as read from the rows and runtime, for `groupFull`. */
export interface GroupRoom {
  projectId: string
  groupId: string
  name: string
  limit: number
  /** Members with no stop that the runtime runs. */
  running: Set<string>
  readAtMs: number
}

/** Workspace ids holding a slot before (or without) a provisioning row: a
 *  queued launch from its claim, a move until its write lands. */
const reserved = new Map<string, { projectId: string; groupId: string }>()

/** Read a group's limit and running members, or undefined when there is
 *  nothing to check: no group, an unknown one, or one without a limit. */
export async function readGroupRoom(projectId: string, groupId: string | undefined): Promise<GroupRoom | undefined> {
  if (groupId === undefined) return undefined
  const readAtMs = Date.now()
  const groups = await listWorkspaceGroupRows(projectId)
  const group = groups.find((g) => g.groupId === groupId)
  if (group?.workspaceLimit == null) return undefined
  const [rows, units] = await Promise.all([getProjectWorkspaceRows(projectId), workspaceDriver().list(projectId)])
  const held = new Set(units.map((u) => u.workspaceId))
  const running = new Set([...rows.values()]
    .filter((r) => r.groupId === groupId && r.stoppedAt === undefined && held.has(r.workspaceId))
    .map((r) => r.workspaceId))
  return { projectId, groupId, name: group.name, limit: group.workspaceLimit, running, readAtMs }
}

/** The live workspaces in a group now: `room`'s plus what is in flight in
 *  this process, and what went live since the read. */
function liveWorkspaces(room: GroupRoom): Set<string> {
  const ids = new Set(room.running)
  const mine = (e: { projectId: string; groupId?: string }): boolean =>
    e.projectId === room.projectId && e.groupId === room.groupId
  for (const w of wentLiveSince(room.readAtMs)) if (mine(w)) ids.add(w.workspaceId)
  for (const p of listProvisioning()) {
    if (p.error !== undefined || !mine(p)) continue
    ids.add(p.workspaceId)
    // A create that claimed a spare runs under the spare's id.
    if (p.claimedId !== undefined) ids.delete(p.claimedId)
  }
  for (const [id, r] of reserved) if (mine(r)) ids.add(id)
  return ids
}

/** Whether `workspaceId` would find no free slot in the group. It does not
 *  count against itself, so a workspace already live there fits. */
export function groupFull(room: GroupRoom | undefined, workspaceId: string): boolean {
  if (room === undefined) return false
  const live = liveWorkspaces(room)
  live.delete(workspaceId)
  return live.size >= room.limit
}

/** Throw `CONFLICT` naming the group and its limit if it is full. */
export function refuseFullGroup(room: GroupRoom | undefined, workspaceId: string): void {
  if (room === undefined || !groupFull(room, workspaceId)) return
  throw new ServerError(
    'CONFLICT',
    `group "${room.name}" is at its workspace limit of ${room.limit} (running or starting); `
    + 'stop one of its workspaces or raise the limit',
  )
}

/** Hold a slot for `workspaceId` until the returned release is called. */
export function reserveGroupSlot(projectId: string, groupId: string, workspaceId: string): () => void {
  const holder = { projectId, groupId }
  reserved.set(workspaceId, holder)
  return () => { if (reserved.get(workspaceId) === holder) reserved.delete(workspaceId) }
}

/** Test helper: drop every reservation. */
export function clearGroupSlotsForTests(): void {
  reserved.clear()
}
