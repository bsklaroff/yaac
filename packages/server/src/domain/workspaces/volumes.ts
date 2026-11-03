/**
 * Workspace volumes (docs/workspace-volumes.md): named app data that one
 * running workspace at a time mounts. This module owns the lease: who may
 * mount a volume, when a launch is refused for one, and when a lease ends
 * because its holder's runtime is gone. The substrate's half (a directory
 * or a claim) is the driver's.
 */
import { workspaceDriver } from '#drivers/driver'
import type { RuntimeSnapshot, VolumeRef, WorkspaceMount } from '#drivers/contract'
import {
  applyWorkspaceEvent,
  claimVolume,
  deleteVolumeRow,
  findVolumeByName,
  findWorkspaceRow,
  getVolumeRow,
  insertVolume,
  leaseOf,
  listHeldVolumes,
  listProjectVolumes,
  listStagedVolumes,
  listVolumeSites,
  unstageVolume,
  listUnpinnedVolumes,
  listVolumeWorkspaces,
  setVolumeSize,
  forgetDeletedVolume,
  listDeletedVolumeIds,
  setWorkspaceVolume,
  stageVolume as stageVolumeRow,
  type VolumeLease,
  type VolumeRow,
} from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { serverLog } from '#lib/log'
import { inFlightWorkspaceIds } from './provisioning'
import { tearingDown } from './cleanup'
import { ServerError } from '@yaac/shared/errors'
import type { VolumeEntry } from '@yaac/shared/types'

/** Where a workspace sees its volume, named by `YAAC_VOLUME_DIR`. */
export const VOLUME_MOUNT_PATH = '/home/yaac/volume'

const DEFAULT_SIZE = '10Gi'

const VOLUME_NAME = /^[a-z0-9-]{1,40}$/

const QUANTITY = /^([1-9][0-9]*)(Ki|Mi|Gi|Ti|Pi|K|M|G|T|P)?$/

const UNIT: Record<string, number> = {
  '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50,
}

/** Bytes in a Kubernetes quantity, refusing any other spelling. */
function quantityBytes(size: string): number {
  const m = QUANTITY.exec(size)
  if (!m) throw new ServerError('VALIDATION', `"${size}" is not a size like 10Gi or 500Mi`)
  return Number(m[1]) * UNIT[m[2] ?? '']
}

function requireVolumes(): void {
  if (workspaceDriver().kind !== 'k8s') {
    throw new ServerError('NOT_SUPPORTED', 'volumes need a cluster; this server runs workspaces on the host')
  }
}

const ref = (row: VolumeRow): VolumeRef => ({ id: row.id, size: row.size, pinned: row.pinnedAt !== undefined })

async function requireVolume(projectId: string, name: string): Promise<VolumeRow> {
  const row = await findVolumeByName(projectId, name)
  if (!row) {
    throw new ServerError('NOT_FOUND', `this project has no volume named "${name}"; `
      + 'create it with `yaac volume create`')
  }
  return row
}

/**
 * Whether a lease's holder can no longer be using the volume: no unit, not
 * even one shutting down, and nothing creating or tearing it down.
 */
async function holderGone(workspaceId: string): Promise<boolean> {
  return !inFlightWorkspaceIds(Date.now()).includes(workspaceId)
    && !tearingDown(workspaceId)
    && await workspaceDriver().findForTeardown(workspaceId) === undefined
}

async function heldError(row: VolumeRow, holder: string): Promise<ServerError> {
  const title = (await findWorkspaceRow(holder))?.title
  return new ServerError('VOLUME_HELD', `volume "${row.name}" is attached to running workspace `
    + `${holder.slice(0, 8)}${title !== undefined ? ` (${title})` : ''}; stop it first, or start without the volume`)
}

export async function createVolume(principal: Actor, projectId: string, name: string, size = DEFAULT_SIZE): Promise<void> {
  requireVolumes()
  await authorizeProject(principal, projectId)
  if (!VOLUME_NAME.test(name)) {
    throw new ServerError('VALIDATION', `"${name}" is not a volume name: use 1-40 of a-z, 0-9 and -`)
  }
  quantityBytes(size)
  const row = await insertVolume(projectId, name, size)
  try {
    await workspaceDriver().ensureVolume(ref(row))
  } catch (err) {
    await deleteVolumeRow(row.id)
    throw err
  }
}

/** A project's volumes. Any user may read them, as every other resource. */
export async function listVolumes(projectId: string): Promise<VolumeEntry[]> {
  requireVolumes()
  const rows = await listProjectVolumes(projectId)
  const named = await listVolumeWorkspaces(rows.map((r) => r.id))
  const titles = new Map(named.map((w) => [w.workspaceId, w.title]))
  return rows.map((row) => {
    const holder = row.holderWorkspaceId
    const holderTitle = holder !== undefined ? titles.get(holder) : undefined
    return {
      name: row.name,
      size: row.size,
      createdAt: row.createdAt.toISOString(),
      ...(holder !== undefined && row.attachedAt !== undefined
        ? { holder: { workspaceId: holder, ...(holderTitle !== undefined ? { title: holderTitle } : {}), attachedAt: row.attachedAt.toISOString() } }
        : {}),
      stoppedWorkspaces: named
        .filter((w) => w.volumeId === row.id && w.stopped && w.workspaceId !== holder)
        .map((w) => ({ workspaceId: w.workspaceId, ...(w.title !== undefined ? { title: w.title } : {}) })),
    }
  })
}

/** Grow a volume. A claim cannot shrink, so a smaller size is refused. */
export async function resizeVolume(principal: Actor, projectId: string, name: string, size: string): Promise<void> {
  requireVolumes()
  await authorizeProject(principal, projectId)
  const row = await requireVolume(projectId, name)
  if (quantityBytes(size) <= quantityBytes(row.size)) {
    throw new ServerError('VALIDATION', `volume "${name}" is ${row.size}; a volume can only grow`)
  }
  await workspaceDriver().resizeVolume(ref(row), size)
  await setVolumeSize(row.id, size)
}

/**
 * Delete a volume and its bytes. Refused while a running workspace holds
 * it; a lease whose holder is gone is ended first. The row goes before the
 * storage, so no launch can claim a volume being deleted. Removing the
 * storage is best-effort: what a failure leaves, `collectDeletedVolumes`
 * removes later.
 */
export async function deleteVolume(principal: Actor, projectId: string, name: string): Promise<void> {
  requireVolumes()
  await authorizeProject(principal, projectId)
  const row = await requireVolume(projectId, name)
  const users = await listVolumeSites(row.id)
  if (users.length > 0) {
    throw new ServerError('CONFLICT', `volume "${name}" holds site ${users.map((u) => `"${u.name}"`).join(', ')}'s data; `
      + 'remove it from the site first')
  }
  const lease = leaseOf(row)
  if (lease !== undefined) {
    if (!await holderGone(lease.holderWorkspaceId)) throw await heldError(row, lease.holderWorkspaceId)
    await applyWorkspaceEvent({ type: 'volume-released', volumeId: row.id, lease })
  }
  if (!await deleteVolumeRow(row.id)) {
    throw new ServerError('CONFLICT', `volume "${name}" was attached meanwhile; stop that workspace first`)
  }
  await workspaceDriver().deleteVolume(row.id).catch((err: unknown) => {
    serverLog(`[server] removing volume ${row.id}'s storage, which the volume-gc step retries: ${String(err)}`)
  })
}

/**
 * The volume a launch of `workspaceId` would attach, checked before
 * anything is torn down or created: `name` given, else (`name` undefined)
 * the one it last held. Throws `VOLUME_HELD` when a running workspace has
 * it. Resolves undefined for no volume.
 */
export async function volumeForLaunch(
  projectId: string,
  workspaceId: string,
  name: string | null | undefined,
): Promise<VolumeRow | undefined> {
  let row: VolumeRow | undefined
  if (typeof name === 'string') {
    requireVolumes()
    row = await requireVolume(projectId, name)
  } else if (name === undefined) {
    const id = (await findWorkspaceRow(workspaceId))?.volumeId
    row = id !== undefined ? await getVolumeRow(id) : undefined
  }
  const holder = row?.holderWorkspaceId
  if (row && holder !== undefined && holder !== workspaceId && !await holderGone(holder)) {
    throw await heldError(row, holder)
  }
  // Staged for a site's release mid-deploy, which takes it next.
  const next = row?.nextHolderWorkspaceId
  if (row && next !== undefined && next !== workspaceId && !await holderGone(next)) {
    throw await heldError(row, next)
  }
  return row
}

/**
 * Take a volume's lease for a launch and make its storage ready. Resolves
 * with the lease taken, and the mount and env the workspace gets. A lease
 * whose holder is found gone is taken over, unless it was renewed since it
 * was read; a live holder refuses with `VOLUME_HELD`.
 */
export async function attachVolume(
  workspaceId: string,
  volumeId: string,
): Promise<{ lease: VolumeLease; mount: WorkspaceMount; env: string[] }> {
  const row = await getVolumeRow(volumeId)
  if (!row) throw new ServerError('NOT_FOUND', 'the volume was deleted')
  const seen = leaseOf(row)
  let lease = await claimVolume(row.id, workspaceId)
  if (!lease && seen !== undefined && await holderGone(seen.holderWorkspaceId)) {
    lease = await claimVolume(row.id, workspaceId, seen)
  }
  if (!lease) {
    const now = (await getVolumeRow(volumeId))?.holderWorkspaceId
    throw await heldError(row, now ?? seen?.holderWorkspaceId ?? 'another workspace')
  }
  await setWorkspaceVolume(workspaceId, row.id)
  await workspaceDriver().ensureVolume(ref(row))
  return {
    lease,
    mount: { source: { kind: 'volume', volumeId: row.id }, mountPath: VOLUME_MOUNT_PATH },
    env: [`YAAC_VOLUME_DIR=${VOLUME_MOUNT_PATH}`, `YAAC_VOLUME_NAME=${row.name}`],
  }
}

/**
 * Mount a volume in a site release as its next holder, while the release
 * serving the site may still hold it (docs/public-sites.md "Volumes: a
 * staged handoff"). The release writes nothing there until its deploy
 * passes it the lease, and the steps before then are not told where it is.
 * Resolves with the mount. Refused while another release is staged.
 */
export async function stageVolume(workspaceId: string, volumeId: string): Promise<WorkspaceMount> {
  const row = await getVolumeRow(volumeId)
  if (!row) throw new ServerError('NOT_FOUND', 'the volume was deleted')
  if (!await stageVolumeRow(row.id, workspaceId)) {
    throw new ServerError('VOLUME_HELD', `volume "${row.name}" is already being handed to another release`)
  }
  await setWorkspaceVolume(workspaceId, row.id)
  await workspaceDriver().ensureVolume(ref(row))
  return { source: { kind: 'volume', volumeId: row.id }, mountPath: VOLUME_MOUNT_PATH }
}

/**
 * End every lease `workspaceId` holds but `keep`, once its runtime is
 * confirmed gone: a restart of a running workspace relaunches it without
 * the volume its old pod held, or with another.
 */
export async function releaseWorkspaceVolumes(workspaceId: string, keep?: string): Promise<void> {
  for (const row of await listHeldVolumes()) {
    const lease = leaseOf(row)
    if (lease?.holderWorkspaceId !== workspaceId || row.id === keep) continue
    await applyWorkspaceEvent({ type: 'volume-released', volumeId: row.id, lease })
  }
}

/**
 * End the leases whose holders' runtimes are gone, and forget next holders
 * whose releases are gone, then keep the disks that have been bound since
 * the last pass (`pinVolumes`). The lease is
 * otherwise taken over lazily by the next launch, so this keeps the list
 * honest and catches a crash mid-teardown.
 *
 * The leases are read before the runtime, so a holder that renews after
 * the read keeps its lease (the release matches the lease as read), and one
 * that renewed before it is in flight. A unit with no pod yet, a Job a
 * server restart found mid-create, counts as live.
 */
export async function reconcileVolumeLeases(snapshot: RuntimeSnapshot): Promise<void> {
  const held = await listHeldVolumes()
  const staged = await listStagedVolumes()
  const alive = await workspacesAlive(snapshot)
  for (const row of held) {
    const lease = leaseOf(row)
    if (lease === undefined || alive(lease.holderWorkspaceId)) continue
    await applyWorkspaceEvent({ type: 'volume-released', volumeId: row.id, lease })
  }
  for (const row of staged) {
    const next = row.nextHolderWorkspaceId
    if (next === undefined || alive(next)) continue
    await unstageVolume(row.id, next)
  }
  const unpinned = await listUnpinnedVolumes()
  if (unpinned.length === 0) return
  const pinned = await workspaceDriver().pinVolumes(unpinned.map((r) => r.id))
    .catch((err: unknown) => {
      serverLog(`[server] pinning volumes: ${String(err)}`)
      return []
    })
  if (pinned.length > 0) await applyWorkspaceEvent({ type: 'volumes-pinned', volumeIds: pinned })
}

/**
 * Which workspaces' runtimes may still be up as of `snapshot`: listed (a
 * unit with no pod yet, such as a Job a server restart found mid-create,
 * included), being created or restarted, or being torn down.
 */
export async function workspacesAlive(snapshot: RuntimeSnapshot): Promise<(workspaceId: string) => boolean> {
  const listed = new Set([
    ...(await snapshot.workspaces()).map((h) => h.workspaceId),
    ...(await snapshot.strayUnits()).map((u) => u.workspaceId),
  ])
  // The snapshot's time, not now: a launch that settled after the runtime
  // was listed is missing from it, and must still count.
  const inFlight = new Set(inFlightWorkspaceIds(snapshot.takenAtMs))
  return (id) => listed.has(id) || inFlight.has(id) || tearingDown(id)
}

/**
 * Finish the deletes whose storage step failed, or ran while a pod still
 * had the volume mounted (a project's workspaces are still shutting down
 * when its volumes go). Only volumes yaac recorded as deleted are touched:
 * a tombstone is written with the row's delete, so storage a reset or
 * restored database does not know about is left alone. A tombstone goes
 * once its storage is gone; it is listed before the storage, so storage
 * missing from that listing really is gone.
 */
export async function collectDeletedVolumes(): Promise<void> {
  const deleted = await listDeletedVolumeIds()
  if (deleted.length === 0) return
  const storage = new Map((await workspaceDriver().volumeStorage()).map((v) => [v.volumeId, v.mounted]))
  for (const id of deleted) {
    const mounted = storage.get(id)
    if (mounted === undefined) await forgetDeletedVolume(id)
    else if (!mounted) {
      await workspaceDriver().deleteVolume(id)
        .catch((err: unknown) => serverLog(`[server] removing deleted volume ${id}'s storage: ${String(err)}`))
    }
  }
}
