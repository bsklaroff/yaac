import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ServerError } from '@yaac/shared/errors'
import { lifeDirName } from '@yaac/shared/steps'
import { globalPath } from '@yaac/shared/paths'
import { workspaceCheckpointsDir, workspaceTreeDir } from '@yaac/shared/project-paths'
import {
  BUNDLES_DIR, LIVES_DIR, MANIFEST_FILE, MAX_MANIFEST_BYTES, START_FILE, parseManifest,
  type Manifest, type StartInstruction,
} from '@yaac/shared/tree-records'
import type { RuntimeSnapshot, WorkspaceTree } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import { applyWorkspaceEvent, listTreeLives, listUnstampedTreeLives, type CheckpointOutcome, type TreeLife } from '#db'
import { openRoot } from '#lib/confined-fs'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { serverLog } from '#lib/log'
import { workspaceCheckouts } from './checkouts'
import { tearingDown } from './cleanup'
import { workspaceBinDir } from './workspace-bin'

/**
 * A k8s workspace's files on its node (docs/node-local-workspaces.md):
 * what the server does around the tree container. It names each life's
 * tree, writes the start instruction once every checkout's `.git` is in
 * place, picks the checkpoint a restart restores, and once a life has
 * stopped stamps it as saved: by its own final pass, by a salvage pod's on
 * its node, as having nothing to save, or as lost with its node. A restart
 * and a delete wait for that stamp.
 */

/** Whether this runtime keeps a workspace's files on its node. A site's
 *  release keeps its server-made checkout on the shared tier. */
export function treesApply(siteRelease: boolean): boolean {
  return workspaceDriver().kind === 'k8s' && !siteRelease
}

/** Where the tree program is staged for pods to mount: its own place, since
 *  a workspace's staged helpers go with its stop and a salvage comes after. */
const programPath = (): string => globalPath('workspace-bin', 'yaac-tree')

/** Stage `yaac-tree` where pods mount it, replacing an older copy whole.
 *  The program is a build output, so running from source (unit tests,
 *  which start no pod) there is none to stage. */
export async function stageTreeProgram(): Promise<string> {
  const target = programPath()
  const source = await fs.readFile(path.join(workspaceBinDir(), 'yaac-tree')).catch(() => null)
  if (source === null) return target
  const current = await fs.readFile(target).catch(() => null)
  if (current?.equals(source)) return target
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${randomBytes(6).toString('hex')}`
  await fs.writeFile(tmp, source, { mode: 0o755 })
  await fs.rename(tmp, target)
  return target
}

/** The checkpoint log's folders a pod mounts, made before it is applied,
 *  since a missing mount source would be made root-owned. */
export async function prepareCheckpoints(projectId: string, workspaceId: string, life: string): Promise<void> {
  const dir = workspaceCheckpointsDir(projectId, workspaceId)
  await fs.mkdir(path.join(dir, BUNDLES_DIR), { recursive: true })
  await fs.mkdir(path.join(dir, LIVES_DIR, life), { recursive: true })
}

/** The tree of a life, as the runtime mounts it. */
export async function treeOf(projectId: string, workspaceId: string, life: string, opts: {
  checkouts: Array<{ id: string; path: string; dir: string; mainGitDir: string }>
  restoring: boolean
}): Promise<WorkspaceTree> {
  return {
    life,
    lifeDir: workspaceTreeDir(projectId, workspaceId, life),
    checkpointsDir: workspaceCheckpointsDir(projectId, workspaceId),
    checkouts: opts.checkouts.map((c) => ({ id: c.id, path: c.path, gitDir: path.join(c.dir, '.git') })),
    mainClones: [...new Set(opts.checkouts.map((c) => c.mainGitDir))],
    program: await stageTreeProgram(),
    restoring: opts.restoring,
  }
}

/**
 * Write the life's start instruction, which the tree container waits for:
 * each checkout's place, its git dir as the container mounts it and its
 * start commit, the paths it must never save (scratch dirs, volumes under
 * the root), and the checkpoint to restore. Through a temp name, so it is
 * never read half written.
 */
export async function writeStartInstruction(projectId: string, workspaceId: string, life: string, opts: {
  checkouts: Array<{ id: string; path: string; commit: string; kept: string[] }>
  excluded: string[]
  restore?: string
  restoreNewestReadable?: boolean
}): Promise<void> {
  const start: StartInstruction = {
    version: 1,
    life,
    // The server runs as the install uid, which the workspace's files are.
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    checkouts: opts.checkouts.map((c) => ({ id: c.id, path: c.path, gitDir: `/git/${c.id}`, commit: c.commit, kept: c.kept })),
    excluded: opts.excluded,
    ...(opts.restore !== undefined ? { restore: opts.restore } : {}),
    ...(opts.restoreNewestReadable === true ? { restoreNewestReadable: true } : {}),
  }
  const dir = path.join(workspaceCheckpointsDir(projectId, workspaceId), LIVES_DIR, life)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${START_FILE}.${randomBytes(6).toString('hex')}`)
  await fs.writeFile(tmp, `${JSON.stringify(start, null, 2)}\n`)
  await fs.rename(tmp, path.join(dir, START_FILE))
}

/** A life's manifest, read as agent-written data: no links followed,
 *  size-capped, checked against its schema. Null when there is none. */
export async function readLifeManifest(projectId: string, workspaceId: string, life: string): Promise<Manifest | null> {
  const root = await openRoot(workspaceCheckpointsDir(projectId, workspaceId), 'no-links').catch(() => null)
  if (!root) return null
  const bytes = await root.readFile(`${LIVES_DIR}/${life}/${MANIFEST_FILE}`, { maxBytes: MAX_MANIFEST_BYTES }).catch(() => null)
  return bytes === null ? null : parseManifest(bytes.toString('utf8'))
}

/** Why a restart cannot read its checkpoint, if the tree container said so. */
export async function restoreFailure(projectId: string, workspaceId: string, life: string): Promise<string | null> {
  const root = await openRoot(workspaceCheckpointsDir(projectId, workspaceId), 'no-links').catch(() => null)
  const bytes = await root?.readFile(`${LIVES_DIR}/${life}/restore-failed.json`, { maxBytes: 64 * 1024 }).catch(() => null)
  if (!bytes) return null
  try {
    const o = JSON.parse(bytes.toString('utf8')) as { bundle?: unknown; message?: unknown }
    return `checkpoint ${typeof o.bundle === 'string' ? o.bundle : '?'} is unreadable: ${typeof o.message === 'string' ? o.message : ''}`
  } catch {
    return 'its checkpoint is unreadable'
  }
}

/**
 * The manifest a new life restores, relative to the checkpoint dir: the
 * newest earlier life's that was saved, or lost with its node after a
 * pass. A life that had nothing to save is passed over for the one before.
 */
export async function restorePointer(projectId: string, workspaceId: string): Promise<string | undefined> {
  for (const life of await listTreeLives(workspaceId)) {
    if (life.checkpointOutcome === 'nothing') continue
    if (await readLifeManifest(projectId, workspaceId, life.treeDir)) return `${LIVES_DIR}/${life.treeDir}/${MANIFEST_FILE}`
  }
  return undefined
}

/** Stamps run one at a time per workspace: the step and a restart may both
 *  reach one. */
const stamping = createKeyedMutex()

async function stamp(life: TreeLife, outcome: CheckpointOutcome, detail?: string): Promise<void> {
  await applyWorkspaceEvent({
    type: 'life-checkpointed', projectId: life.projectId, workspaceId: life.workspaceId,
    life: life.startedAt, outcome, ...(detail !== undefined ? { detail } : {}),
  })
}

/**
 * Stamp a stopped node-local life, salvaging its tree first when its pod
 * ended without a final pass. Rejects when the salvage could not run (its
 * node is not ready), to be tried again; a node that no longer exists is a
 * loss, recorded with when the last checkpoint was taken.
 */
async function stampLife(life: TreeLife): Promise<void> {
  const { projectId, workspaceId, treeDir } = life
  const own = await readLifeManifest(projectId, workspaceId, treeDir)
  if (own?.final && own.life === treeDir) return stamp(life, 'final')
  // A pod never scheduled left no tree anywhere.
  if (life.node === undefined) return stamp(life, 'nothing')
  const checkouts = (await workspaceCheckouts(projectId, workspaceId))
    .map((c) => ({ id: c.repo.id, path: c.path, dir: c.dir, mainGitDir: c.mainGitDir }))
  const tree = await treeOf(projectId, workspaceId, treeDir, { checkouts, restoring: false })
  const outcome = await workspaceDriver().salvageTree({ projectId, workspaceId, node: life.node, tree })
  if (outcome === 'node-gone') {
    const last = own?.takenAt
    return stamp(life, 'lost', last !== undefined
      ? `its node ${life.node} is gone; its last checkpoint was taken at ${last}`
      : `its node ${life.node} is gone, before any checkpoint of it was taken`)
  }
  const after = await readLifeManifest(projectId, workspaceId, treeDir)
  return stamp(life, after?.final && after.life === treeDir ? 'salvaged' : 'nothing')
}

/**
 * Make sure the workspace's current life, if its tree was on a node, is
 * stamped before a restart or delete goes on, salvaging it now if need be.
 * `CONFLICT` while that cannot be done.
 */
export async function ensureLifeStamped(workspaceId: string): Promise<void> {
  const [life] = await listTreeLives(workspaceId)
  if (!life || life.checkpointedAt !== undefined) return
  await stamping(workspaceId, async () => {
    const [now] = await listTreeLives(workspaceId)
    if (!now || now.checkpointedAt !== undefined) return
    try {
      await stampLife(now)
    } catch (err) {
      throw new ServerError('CONFLICT', `${workspaceId.slice(0, 8)}'s files are still on node ${now.node ?? '?'} `
        + `and could not be saved yet (${err instanceof Error ? err.message : String(err)}); try again shortly`)
    }
  })
}

/** When each workspace whose salvage failed may be tried again. */
const retryAt = new Map<string, number>()
const RETRY_MS = 60_000

/**
 * The `tree-salvage` step: stamp each stopped node-local life whose unit
 * is gone, salvaging its tree where its pod took no final pass. Detached,
 * one workspace at a time each.
 */
export async function reconcileTreeSalvage(view: RuntimeSnapshot): Promise<void> {
  const lives = await listUnstampedTreeLives()
  if (lives.length === 0) return
  const [units, strays] = await Promise.all([view.workspaces(), view.strayUnits()])
  const live = new Set([...units.map((u) => u.workspaceId), ...strays.map((s) => s.workspaceId)])
  const now = Date.now()
  for (const life of lives) {
    if (live.has(life.workspaceId) || tearingDown(life.workspaceId)) continue
    if ((retryAt.get(life.workspaceId) ?? 0) > now) continue
    void stamping(life.workspaceId, async () => {
      const [current] = await listTreeLives(life.workspaceId)
      if (!current || current.checkpointedAt !== undefined || current.startedAt.getTime() !== life.startedAt.getTime()) return
      await stampLife(current)
      retryAt.delete(life.workspaceId)
    }).catch((err: unknown) => {
      retryAt.set(life.workspaceId, Date.now() + RETRY_MS)
      serverLog(`[tree-salvage] ${life.workspaceId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
}

/** Workspaces whose tree may still be on a node, for the node-local sweep
 *  to leave alone. */
export async function unsalvagedWorkspaceIds(): Promise<string[]> {
  return (await listUnstampedTreeLives()).map((l) => l.workspaceId)
}

/** The commit a checkout's git dir has as HEAD, read as data rather than
 *  through the agent's git; undefined when it names none. */
export async function gitHead(gitDir: string): Promise<string | undefined> {
  const sha = /^[0-9a-f]{40}([0-9a-f]{24})?$/
  const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => '')).trim()
  if (sha.test(head)) return head
  const ref = /^ref: (refs\/\S+)$/.exec(head)?.[1]
  if (ref === undefined || ref.split('/').includes('..')) return undefined
  const loose = (await fs.readFile(path.join(gitDir, ref), 'utf8').catch(() => '')).trim()
  if (sha.test(loose)) return loose
  const packed = await fs.readFile(path.join(gitDir, 'packed-refs'), 'utf8').catch(() => '')
  return packed.split('\n').map((l) => l.split(' ')).find(([s, name]) => name === ref && sha.test(s))?.[0]
}

/** Whether `dir` holds a file outside every `.git`; links count as files. */
async function holdsWork(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name === '.git') continue
    if (!e.isDirectory() || await holdsWork(path.join(dir, e.name))) return true
  }
  return false
}

/**
 * Move a workspace whose last life kept its files on the shared tier onto
 * node disk (docs/node-local-workspaces.md "Workspaces from before"):
 * a one-shot pod takes an ordinary checkpoint of the shared directory,
 * which the new life restores. The old files are left as they are, unread
 * from now on, until the workspace is deleted. Resolves with the manifest
 * to restore, or undefined when there is nothing but each `.git` there.
 */
export async function importSharedFiles(projectId: string, workspaceId: string, sharedDir: string, opts: {
  checkouts: Array<{ id: string; path: string; dir: string; mainGitDir: string; commit: string; kept: string[] }>
  excluded: string[]
}): Promise<string | undefined> {
  if (!await holdsWork(sharedDir)) return undefined
  const life = `import-${lifeDirName(new Date())}`
  await prepareCheckpoints(projectId, workspaceId, life)
  await writeStartInstruction(projectId, workspaceId, life, { checkouts: opts.checkouts, excluded: opts.excluded })
  const tree = await treeOf(projectId, workspaceId, life, { checkouts: opts.checkouts, restoring: false })
  await workspaceDriver().importTree({ projectId, workspaceId, sharedDir, tree })
  if (!(await readLifeManifest(projectId, workspaceId, life))?.final) {
    throw new ServerError('INTERNAL', `moving ${workspaceId.slice(0, 8)}'s files to its node took no checkpoint`)
  }
  return `${LIVES_DIR}/${life}/${MANIFEST_FILE}`
}

/** A bundle or temp file younger than this may be a pass's that has not
 *  replaced its manifest yet, so the collection leaves it. */
const COLLECT_AFTER_MS = 60 * 60_000

/**
 * Remove the bundles no kept manifest names, and the temp files a pass
 * that died left (docs/node-local-workspaces.md "The log"). The kept
 * manifests are the two newest of each workspace (the current life's, and
 * the one it restored from until it has its own) and those of lives lost
 * with their node, in case their tree turns up. A tree container deletes
 * nothing there, so this is the only collection.
 */
export async function collectCheckpointBundles(): Promise<void> {
  for (const projectId of await fs.readdir(globalPath('projects')).catch(() => [])) {
    const root = path.join(globalPath('projects'), projectId, 'checkpoints')
    for (const workspaceId of await fs.readdir(root).catch(() => [])) {
      await collectWorkspace(projectId, workspaceId).catch((err: unknown) => {
        serverLog(`[checkpoint-gc] ${workspaceId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }
}

async function collectWorkspace(projectId: string, workspaceId: string): Promise<void> {
  const dir = workspaceCheckpointsDir(projectId, workspaceId)
  const lifeNames = await fs.readdir(path.join(dir, LIVES_DIR)).catch(() => [])
  const manifests = (await Promise.all(lifeNames.map(async (life) => ({ life, m: await readLifeManifest(projectId, workspaceId, life) }))))
    .filter((x): x is { life: string; m: Manifest } => x.m !== null)
    .sort((a, b) => b.m.takenAt.localeCompare(a.m.takenAt))
  const lost = new Set((await listTreeLives(workspaceId)).filter((l) => l.checkpointOutcome === 'lost').map((l) => l.treeDir))
  const kept = new Set(manifests.filter((x, i) => i < 2 || lost.has(x.life)).flatMap((x) => x.m.bundles))
  // With no manifest at all there is nothing to judge by yet.
  if (manifests.length === 0) return
  const now = Date.now()
  for (const name of await fs.readdir(path.join(dir, BUNDLES_DIR)).catch(() => [])) {
    if (kept.has(`${BUNDLES_DIR}/${name}`) || name.endsWith('.unreadable')) continue
    const file = path.join(dir, BUNDLES_DIR, name)
    const st = await fs.lstat(file).catch(() => null)
    if (!st?.isFile() || now - st.mtimeMs < COLLECT_AFTER_MS) continue
    await fs.rm(file, { force: true })
  }
}

/**
 * Point a checkout's alternates at its main clone, which every pod mounts
 * at the server's own path, before the tree container reads the checkout's
 * objects. A checkout a containerless launch or an older layout left names
 * it otherwise, and the in-workspace relink comes only after the tree is
 * filled.
 */
export async function relinkAlternates(gitDir: string, mainGitDir: string): Promise<void> {
  const file = path.join(gitDir, 'objects', 'info', 'alternates')
  const line = `${path.join(mainGitDir, 'objects')}\n`
  if (await fs.readFile(file, 'utf8').then((t) => t === line, () => false)) return
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, line)
}
