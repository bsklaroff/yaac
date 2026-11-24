/**
 * Image builds (docs/image-builds.md "Images, revisions and builds"): which
 * chain builds run, in what order, and their records. A build request
 * names an image chain (a project image at a revision, or the stock image,
 * topped by its owner's user image); the layers the registry lacks become
 * `image_builds` rows, queued until a slot is free (at most
 * `buildConcurrency()` at once, a create's ahead of a save's, the sweep's
 * last), then built together in one builder by the driver. Two requests
 * for the same image and final tag share one job, unless only one of them
 * skips the cache.
 *
 * A row's log is a file under server-local `image-builds/`, appended as
 * the builder prints; its step progress lives in memory while it runs and
 * is stored when it ends.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ServerError } from '@yaac/shared/errors'
import { serverLocalPath } from '@yaac/shared/project-paths'
import { resolveAllowedHosts } from '@yaac/shared/allowed-hosts'
import { DEFAULT_IMAGE_CACHE_DAYS, type ImageBuild, type ImageBuildReason, type ImageBuildStatus, type ImageBuildWarning, type ImageLayerName } from '@yaac/shared/types'
import {
  getImage,
  getImageRevision,
  getInstallSetting,
  failInterruptedImageBuilds,
  getProjectRow,
  insertImageBuild,
  listImageBuilds,
  listImages,
  setImageLastBuilt,
  setInstallSetting,
  updateImageBuild,
  type ImageBuildRow,
  type ImageRevisionRow,
  type ImageRow,
  type ImageScope,
} from '#db'
import { workspaceDriver } from '#drivers/driver'
import type { ImageChainSpec, ImageLayerSource, ResolvedImageChain } from '#drivers/contract'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { serverLog } from '#lib/log'
import { isUuid } from '#lib/uuid'
import { materializeFiles } from './blobs'

/** Builds that run at once, across the install, when none is set. */
export const DEFAULT_BUILD_CONCURRENCY = 2

const CONCURRENCY_KEY = 'image-build-concurrency'

/** The BuildKit release builder pods run (k8s/buildkit/Dockerfile). */
export const BUILDKIT_VERSION = 'v0.34.2'

/** What a job builds: a project's image (absent for the stock image) at a
 *  revision, topped by the owner's user image when they have one. */
export interface ChainTarget {
  projectId: string
  image?: ImageRow
  revision?: ImageRevisionRow
  userImage?: ImageRow
  userRevision?: ImageRevisionRow
}

/** How a request ended: the tag to launch, or why there is none. */
export type ChainOutcome = { ok: true; finalTag: string } | { ok: false; error: string }

/** Lower runs first: a create someone waits on, then a person's ask, then the sweep. */
const PRIORITY: Record<ImageBuildReason, number> = { create: 0, save: 1, manual: 1, prewarm: 2 }

interface Job {
  key: string
  finalTag: string
  target: ChainTarget
  layers: ImageLayerName[]
  /** Build row per layer. */
  rows: Map<ImageLayerName, string>
  priority: number
  noCache: boolean
  abort: AbortController
  running: boolean
  /** Resolves once its rows are written and it is queued (or settled). */
  formed: Promise<void>
  /** Once it has run: resolves when it has ended and the queue has moved
   *  on (`pump`). */
  ended?: Promise<void>
  done: Promise<ChainOutcome>
  settle: (outcome: ChainOutcome) => void
}

/** Live step progress of a running row, kept out of the db. */
interface Progress {
  steps: Set<string>
  cached: number
  total: number
  current?: number
  text?: string
  warnings: Map<string, ImageBuildWarning>
  digests: Record<string, string>
  log: fs.WriteStream
}

/**
 * Jobs by `jobKey`, from the moment a request decides to start one, so a
 * second request for the same key joins it rather than racing it. The key
 * names the image too: two images with the same content build apart, so
 * deleting one never cancels the other's create. A no-cache rebuild has
 * its own key, since it must not join a build that reuses the cache.
 */
const jobs = new Map<string, Job>()

function jobKey(target: ChainTarget, finalTag: string, noCache: boolean): string {
  return `${target.image?.id ?? 'stock'} ${finalTag}${noCache ? ' no-cache' : ''}`
}
const pending: Job[] = []
const progress = new Map<string, Progress>()
let concurrencyCache: number | null = null

/** At most how many builds run at once, install-wide. */
export async function buildConcurrency(): Promise<number> {
  if (concurrencyCache === null) {
    const stored = Number.parseInt(await getInstallSetting(CONCURRENCY_KEY) ?? '', 10)
    concurrencyCache = Number.isInteger(stored) && stored > 0 ? stored : DEFAULT_BUILD_CONCURRENCY
  }
  return concurrencyCache
}

/** Set the install's build concurrency (null restores the default). */
export async function setBuildConcurrency(n: number | null): Promise<number> {
  if (n !== null && (!Number.isInteger(n) || n < 1 || n > 16)) {
    throw new ServerError('VALIDATION', 'build concurrency must be a whole number from 1 to 16')
  }
  await setInstallSetting(CONCURRENCY_KEY, n === null ? null : String(n))
  concurrencyCache = null
  void pump()
  return buildConcurrency()
}

function logPath(buildId: string): string {
  return serverLocalPath('image-builds', `${buildId}.log`)
}

function contextDir(buildId: string, layer: ImageLayerName): string {
  return serverLocalPath('image-contexts', buildId, layer)
}

/** The chain spec of a target; `dirs` names the materialized contexts. */
function chainSpec(target: ChainTarget, dirs: Partial<Record<ImageLayerName, string>> = {}): ImageChainSpec {
  const layers: ImageLayerSource[] = []
  const projectImage = target.image?.id ?? 'stock'
  if (target.revision) {
    layers.push({
      layer: 'project', dockerfile: target.revision.dockerfile, contextDir: dirs.project ?? '',
      contentHash: target.revision.contentHash, cacheKey: projectImage,
    })
  }
  if (target.userRevision) {
    layers.push({
      layer: 'user', dockerfile: target.userRevision.dockerfile, contextDir: dirs.user ?? '',
      contentHash: target.userRevision.contentHash, cacheKey: projectImage,
    })
  }
  return { projectId: target.projectId, layers }
}

/**
 * The chain a create or build of `imageId` (absent for the stock image) at
 * `revisionId` (default its current one) means for `projectId`, with its
 * owner's user image on top.
 */
export async function chainTarget(projectId: string, imageId?: string, revisionId?: string): Promise<ChainTarget> {
  const project = await getProjectRow(projectId)
  if (!project) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  const target: ChainTarget = { projectId }
  if (imageId !== undefined) {
    const image = isUuid(imageId) ? await getImage(imageId) : undefined
    if (!image || image.projectId !== projectId) throw new ServerError('NOT_FOUND', 'no such image in this project')
    const revId = revisionId ?? image.currentRevisionId
    const revision = revId && isUuid(revId) ? await getImageRevision(revId) : undefined
    if (!revision || revision.imageId !== image.id) throw new ServerError('NOT_FOUND', 'no such revision of this image')
    Object.assign(target, { image, revision })
  }
  const [userImage] = await listImages({ userId: project.owner })
  const userRevision = userImage?.currentRevisionId ? await getImageRevision(userImage.currentRevisionId) : undefined
  if (userImage && userRevision) Object.assign(target, { userImage, userRevision })
  return target
}

/** A target's chain, from its sources alone: nothing built or asked. */
export async function targetChain(target: ChainTarget): Promise<ResolvedImageChain> {
  return workspaceDriver().resolveImageChain(chainSpec(target))
}

/** A target's final tag (`targetChain`). */
export async function chainFinalTag(target: ChainTarget): Promise<string> {
  return (await targetChain(target)).finalTag
}

interface BuildOptions {
  reason: ImageBuildReason
  noCache?: boolean
  requestedBy?: string
}

/** Build what `target`'s chain lacks, and resolve when it is built or failed. */
export async function buildChain(target: ChainTarget, opts: BuildOptions): Promise<ChainOutcome> {
  return (await queueChain(target, opts)).done
}

/**
 * Queue a build of what `target`'s chain lacks, or join the job already
 * building its final tag the same way (with or without the cache);
 * `buildIds` are its rows (none when nothing is
 * missing, and `done` resolves at once). `noCache` rebuilds the target's
 * own layers even if present, importing no cache.
 */
export async function queueChain(
  target: ChainTarget,
  opts: BuildOptions,
): Promise<{ buildIds: string[]; done: Promise<ChainOutcome> }> {
  const driver = workspaceDriver()
  const chain = await driver.resolveImageChain(chainSpec(target))
  const noCache = opts.noCache ?? false
  const key = jobKey(target, chain.finalTag, noCache)
  const existing = jobs.get(key)
  if (existing) {
    existing.priority = Math.min(existing.priority, PRIORITY[opts.reason])
    await existing.formed
    return { buildIds: [...existing.rows.values()], done: existing.done }
  }
  let settle!: (o: ChainOutcome) => void
  let formed!: () => void
  const job: Job = {
    key,
    finalTag: chain.finalTag,
    target,
    layers: [],
    rows: new Map(),
    priority: PRIORITY[opts.reason],
    noCache,
    abort: new AbortController(),
    running: false,
    formed: new Promise((resolve) => { formed = resolve }),
    done: new Promise((resolve) => { settle = resolve }),
    settle: (o) => settle(o),
  }
  jobs.set(key, job)
  try {
    const own = chain.layers.map((l) => l.name).filter((n) => n === 'project' || n === 'user')
    job.layers = noCache ? own : await driver.missingImageLayers(chain)
    if (job.layers.length === 0) {
      forget(job)
      await recordBuilt(target, chain.finalTag)
      job.settle({ ok: true, finalTag: chain.finalTag })
      return { buildIds: [], done: job.done }
    }
    for (const name of job.layers) {
      const source = name === 'project'
        ? { image: target.image!, revision: target.revision! }
        : { image: target.userImage!, revision: target.userRevision! }
      const layer = chain.layers.find((l) => l.name === name)!
      const row = await insertImageBuild({
        imageId: source.image.id,
        revisionId: source.revision.id,
        projectId: target.projectId,
        layer: name,
        tag: layer.tag,
        reason: opts.reason,
        status: 'queued',
        noCache,
        requestedBy: opts.requestedBy ?? null,
        parentTag: layer.parentTag ?? null,
        buildkitVersion: BUILDKIT_VERSION,
      })
      job.rows.set(name, row.id)
    }
    // Cancelled while its rows were being written: it never queues.
    if (job.abort.signal.aborted) {
      forget(job)
      await finishJob(job, { ok: false, error: 'cancelled' }, undefined, [])
    } else {
      pending.push(job)
      void pump()
    }
    return { buildIds: [...job.rows.values()], done: job.done }
  } catch (err) {
    forget(job)
    await finishJob(job, { ok: false, error: err instanceof Error ? err.message : String(err) }, undefined, [])
      .catch((e: unknown) => serverLog(`[image-builds] ${job.finalTag}: ${String(e)}`))
    throw err
  } finally {
    formed()
  }
}

/** Drop a job from the map, unless a later one has taken its key. */
function forget(job: Job): void {
  if (jobs.get(job.key) === job) jobs.delete(job.key)
}

/** Start queued jobs while there are free slots, highest priority first. */
async function pump(): Promise<void> {
  const limit = await buildConcurrency()
  let running = [...jobs.values()].filter((j) => j.running).length
  while (running < limit && pending.length > 0) {
    pending.sort((a, b) => a.priority - b.priority)
    const job = pending.shift()!
    job.running = true
    running++
    job.ended = runJob(job)
      .catch((err: unknown) => serverLog(`[image-builds] ${job.finalTag}: ${String(err)}`))
      .finally(() => {
        forget(job)
        return pump()
      })
  }
}

async function runJob(job: Job): Promise<void> {
  const { target } = job
  const firstRow = job.rows.get(job.layers[0])!
  const dirs: Partial<Record<ImageLayerName, string>> = {}
  try {
    for (const name of job.layers) {
      const source = name === 'project'
        ? { scope: { projectId: target.projectId } as ImageScope, revision: target.revision! }
        : { scope: { userId: target.userImage!.userId! } as ImageScope, revision: target.userRevision! }
      dirs[name] = contextDir(firstRow, name)
      await materializeFiles(source.scope, source.revision.files, dirs[name])
    }
    const project = await getProjectRow(target.projectId)
    if (!project) throw new Error('the project was removed')
    if (job.abort.signal.aborted) throw new Error('cancelled')
    const outcome = await workspaceDriver().buildImageLayers({
      spec: chainSpec(target, dirs),
      layers: job.layers,
      egressId: firstRow,
      allowedHosts: resolveAllowedHosts(project.egressAllowlist),
      noCache: job.noCache,
      cacheMaxDays: project.imageCacheDays ?? DEFAULT_IMAGE_CACHE_DAYS,
      signal: job.abort.signal,
      onLayerStart: (name) => startRow(job.rows.get(name)!),
      onLine: (name, line) => ingestLine(job.rows.get(name)!, line),
    })
    await finishJob(job, outcome.ok ? { ok: true, finalTag: job.finalTag } : { ok: false, error: outcome.error ?? 'build failed' },
      outcome.failedLayer, outcome.blockedHosts)
  } catch (err) {
    await finishJob(job, { ok: false, error: err instanceof Error ? err.message : String(err) }, undefined, [])
  } finally {
    await fsp.rm(serverLocalPath('image-contexts', firstRow), { recursive: true, force: true }).catch(() => {})
  }
}

/** A row starts: its log opens at once, so no line is lost, and its
 *  status follows. */
function startRow(id: string): void {
  fs.mkdirSync(path.dirname(logPath(id)), { recursive: true })
  progress.set(id, {
    steps: new Set(), cached: 0, total: 0, warnings: new Map(), digests: {},
    log: fs.createWriteStream(logPath(id), { flags: 'a' }),
  })
  void updateImageBuild(id, { status: 'running', startedAt: new Date(), logPath: logPath(id) })
    .catch((err: unknown) => serverLog(`[image-builds] ${id}: ${String(err)}`))
}

/**
 * One line of BuildKit's plain progress: appended to the row's log, and
 * read for step progress (`#7 [3/9] RUN …`), cache hits (`#7 CACHED`),
 * check warnings (`#1 WARN: … (line 4)`) and resolved `FROM` digests.
 */
function ingestLine(id: string, line: string): void {
  const p = progress.get(id)
  if (!p) return
  p.log.write(`${line}\n`)
  const step = /^#(\d+) \[(?:\S+ )?(\d+)\/(\d+)\] (.*)$/.exec(line)
  if (step) {
    const [, vertex, current, total, text] = step
    if (!p.steps.has(vertex)) {
      p.steps.add(vertex)
      p.total = Math.max(p.total, Number(total))
      p.current = Number(current)
      p.text = text.slice(0, 120)
      const from = /^FROM (\S+)@(sha256:[0-9a-f]{64})/.exec(text)
      if (from) p.digests[from[1]] = from[2]
      notifyWorkspaceListChanged()
    }
    return
  }
  const cached = /^#(\d+) CACHED$/.exec(line)
  if (cached && p.steps.has(cached[1])) {
    p.cached++
    return
  }
  const warn = /^#\d+ WARN: (.*)$/.exec(line)
  if (warn) {
    const lineNo = /\(line (\d+)\)$/.exec(warn[1])
    p.warnings.set(warn[1], { message: warn[1], ...(lineNo ? { line: Number(lineNo[1]) } : {}) })
  }
}

async function finishJob(
  job: Job,
  outcome: ChainOutcome,
  failedLayer: ImageLayerName | undefined,
  blockedHosts: string[],
): Promise<void> {
  const cancelled = job.abort.signal.aborted
  let failedSeen = false
  try {
    for (const name of job.layers) {
      const id = job.rows.get(name)
      if (id === undefined) continue
      const p = progress.get(id)
      progress.delete(id)
      await new Promise<void>((resolve) => { if (p) p.log.end(resolve); else resolve() })
      let status: ImageBuildStatus = 'succeeded'
      let error: string | null = null
      if (!outcome.ok) {
        if (cancelled) status = 'cancelled'
        else if (name === failedLayer || (!failedLayer && !failedSeen)) {
          status = 'failed'
          error = outcome.error
          failedSeen = true
        } else if (failedSeen) {
          status = 'cancelled'
          error = 'an earlier layer failed'
        }
      }
      await updateImageBuild(id, {
        status,
        error,
        finishedAt: new Date(),
        ...(p ? {
          cachedSteps: p.cached,
          totalSteps: p.total,
          warnings: [...p.warnings.values()],
          baseDigests: p.digests,
        } : {}),
        blockedHosts,
      })
    }
    if (outcome.ok) await recordBuilt(job.target, outcome.finalTag)
    else serverLog(`[image-builds] ${job.finalTag} ${cancelled ? 'cancelled' : `failed: ${outcome.error}`}`)
  } finally {
    // Waiters always hear how it ended, even when recording it failed.
    job.settle(outcome)
  }
}

/** A finished chain: the image's (and user image's) last built revision. */
async function recordBuilt(target: ChainTarget, finalTag: string): Promise<void> {
  if (target.image && target.revision) await setImageLastBuilt(target.image.id, target.revision.id, finalTag)
  if (target.userImage && target.userRevision && target.userImage.lastBuiltRevisionId !== target.userRevision.id) {
    await setImageLastBuilt(target.userImage.id, target.userRevision.id, finalTag)
  }
}

/** Stop a build: a queued job leaves the queue, a running one is aborted. */
export async function cancelBuildJob(buildId: string): Promise<boolean> {
  for (const job of jobs.values()) {
    if (![...job.rows.values()].includes(buildId)) continue
    job.abort.abort()
    // Running, or still being formed (queueChain finishes it): the abort
    // is enough.
    const queued = pending.indexOf(job)
    if (job.running || queued < 0) return true
    pending.splice(queued, 1)
    forget(job)
    await finishJob(job, { ok: false, error: 'cancelled' }, undefined, [])
    return true
  }
  return false
}

/**
 * At server start: no build outlives the server that ran it, since its
 * builder pod goes with it. Its rows are marked failed and the contexts
 * materialized for it removed. Returns how many rows it marked.
 */
export async function failInterruptedBuilds(): Promise<number> {
  await fsp.rm(serverLocalPath('image-contexts'), { recursive: true, force: true })
  return failInterruptedImageBuilds()
}

/** Delete the log files of finished or cancelled rows. */
export async function removeBuildLogs(rows: ImageBuildRow[]): Promise<void> {
  await Promise.all(rows.map((r) => fsp.rm(r.logPath ?? logPath(r.id), { force: true })))
}

/** A row as the wire shows it, with live progress while it runs. */
export async function buildView(row: ImageBuildRow): Promise<ImageBuild> {
  const [image, revision] = await Promise.all([getImage(row.imageId), getImageRevision(row.revisionId)])
  const p = progress.get(row.id)
  return {
    id: row.id,
    imageId: row.imageId,
    imageName: image?.name ?? '(deleted)',
    scope: image?.userId ? 'user' : 'project',
    revisionId: row.revisionId,
    revisionNumber: revision?.number ?? 0,
    projectId: row.projectId,
    layer: row.layer,
    tag: row.tag,
    reason: row.reason,
    status: row.status,
    noCache: row.noCache,
    queuedAt: row.queuedAt.toISOString(),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {}),
    ...(row.error ? { error: row.error } : {}),
    warnings: p ? [...p.warnings.values()] : row.warnings,
    ...(row.parentTag ? { parentTag: row.parentTag } : {}),
    baseDigests: p ? p.digests : row.baseDigests,
    ...(row.buildkitVersion ? { buildkitVersion: row.buildkitVersion } : {}),
    cachedSteps: p ? p.cached : row.cachedSteps,
    totalSteps: p ? p.total : row.totalSteps,
    ...(p?.current !== undefined ? { stepCurrent: p.current } : {}),
    ...(p?.text !== undefined ? { stepText: p.text } : {}),
    blockedHosts: row.blockedHosts,
  }
}

/** How long a failed build stays on the building pill. */
const RECENT_FAILURE_MS = 60 * 60_000

/**
 * The snapshot's building pill: queued and running builds, and failures of
 * the last hour no later build of the same image and layer replaced.
 */
export async function activeImageBuilds(): Promise<ImageBuild[]> {
  const rows = await listImageBuilds({ limit: 200 })
  const seen = new Set<string>()
  const out: ImageBuildRow[] = []
  for (const row of rows) {
    const key = `${row.imageId}|${row.projectId}|${row.layer}`
    const first = !seen.has(key)
    seen.add(key)
    if (row.status === 'queued' || row.status === 'running') out.push(row)
    else if (first && row.status === 'failed' && (row.finishedAt?.getTime() ?? 0) > Date.now() - RECENT_FAILURE_MS) out.push(row)
  }
  return Promise.all(out.map(buildView))
}

/**
 * A row's log from byte `offset`, and where the next read starts. `done`
 * once the build has ended and the whole log is read.
 */
export async function readBuildLog(row: ImageBuildRow, offset: number): Promise<{ text: string; offset: number; done: boolean }> {
  let text = ''
  try {
    const fh = await fsp.open(row.logPath ?? logPath(row.id), 'r')
    try {
      const { size } = await fh.stat()
      const length = Math.max(0, Math.min(size - offset, 1024 * 1024))
      const buf = Buffer.alloc(length)
      if (length > 0) await fh.read(buf, 0, length, offset)
      text = buf.toString('utf8')
    } finally {
      await fh.close()
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const ended = row.status !== 'queued' && row.status !== 'running'
  return { text, offset: offset + Buffer.byteLength(text), done: ended && text.length === 0 }
}

/** Test hook: cancel every job this server holds and wait for each to
 *  record how it ended, so none writes after a test closes its database. */
export async function _imageBuildsSettledForTests(): Promise<void> {
  for (const job of pending.splice(0)) {
    forget(job)
    job.abort.abort()
    await finishJob(job, { ok: false, error: 'cancelled' }, undefined, [])
  }
  const held = [...jobs.values()]
  for (const job of held) job.abort.abort()
  await Promise.allSettled(held.map((j) => j.ended ?? j.done))
}

/** Test hook: forget every job and its progress. */
export function _resetImageBuildsForTests(): void {
  jobs.clear()
  pending.length = 0
  for (const p of progress.values()) p.log.end()
  progress.clear()
  concurrencyCache = null
}

