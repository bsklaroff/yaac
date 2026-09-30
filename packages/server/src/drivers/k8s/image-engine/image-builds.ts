/**
 * In-memory list of image builds and registry pushes, running or recently
 * finished. The snapshot carries only metadata (status, layer, STEP
 * progress) for the webapp's "building" indicator; the log tail is fetched
 * separately from the `/builds/:id/log` route, so log lines don't trigger
 * snapshot rebuilds.
 *
 * Finished entries stay until dismissed. Dismissing only hides a row: a
 * dismissed failure still makes the prewarm sweep back off
 * (`hasBlockingFailure`). A retry (`forgetImageBuild`) or a new build of the
 * same tag clears it. `MAX_ENTRIES` bounds memory.
 */
import { notifyWorkspaceListChanged } from '#notify'
import { stripAnsi } from '@yaac/shared/ansi'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { ImageBuildEntry, ImageLayerName } from '@yaac/shared/types'
import type { ProjectRef } from '#drivers/contract'

export type ImageBuildReason = 'session' | 'prewarm'

interface BuildRecord {
  id: string
  tag: string
  layer: ImageLayerName | 'push' | 'proxy' | 'netd'
  action: 'build' | 'push'
  /** The projects waiting on it — what a retry rebuilds. */
  projects: ProjectRef[]
  reason: ImageBuildReason
  status: 'running' | 'succeeded' | 'failed'
  stepCurrent?: number
  stepTotal?: number
  stepText?: string
  error?: string
  /** ANSI-stripped tail of the podman output, capped at LOG_CAP. */
  log: string
  startedAt: number
  finishedAt?: number
  /** Hidden from `listImageBuilds` but kept for `hasBlockingFailure`. */
  dismissed?: boolean
}

const entries = new Map<string, BuildRecord>()
let seq = 0

/** Per-entry log tail cap; with MAX_ENTRIES this bounds memory at ~2MB. */
const LOG_CAP = 64_000
const MAX_ENTRIES = 30
const STEP_TEXT_MAX = 120

/**
 * Parse podman's per-instruction progress line, e.g.
 * `STEP 3/14: RUN apt-get update`. Returns null for any other line; if the
 * format changes, the UI just shows status and the raw log.
 */
export function parseBuildStep(line: string): { current: number; total: number; text: string } | null {
  const m = /^STEP\s+(\d+)\/(\d+):\s*(.*)$/.exec(line)
  if (!m) return null
  return { current: Number(m[1]), total: Number(m[2]), text: m[3].slice(0, STEP_TEXT_MAX) }
}

/** Enforce `MAX_ENTRIES`: drop dismissed rows first, then the oldest
 *  finished ones. Running entries are never dropped. */
function prune(): void {
  if (entries.size <= MAX_ENTRIES) return
  const droppable = [...entries.values()]
    .filter((e) => e.status !== 'running')
    .sort((a, b) => Number(b.dismissed ?? false) - Number(a.dismissed ?? false)
      || a.startedAt - b.startedAt)
  for (const e of droppable) {
    if (entries.size <= MAX_ENTRIES) break
    entries.delete(e.id)
  }
}

/**
 * Track a new build or push, replacing any finished entry for the same tag
 * and action. Returns the entry id for log ingestion and completion.
 */
export function registerImageBuild(input: {
  tag: string
  layer: ImageLayerName | 'push' | 'proxy' | 'netd'
  action: 'build' | 'push'
  /** Omitted for infrastructure builds that belong to no project. */
  project?: ProjectRef
  reason: ImageBuildReason
}): string {
  for (const [id, e] of entries) {
    if (e.tag === input.tag && e.action === input.action && e.status !== 'running') {
      entries.delete(id)
    }
  }
  const id = `build-${++seq}`
  entries.set(id, {
    id,
    tag: input.tag,
    layer: input.layer,
    action: input.action,
    projects: input.project ? [input.project] : [],
    reason: input.reason,
    status: 'running',
    log: '',
    startedAt: Date.now(),
  })
  prune()
  notifyWorkspaceListChanged()
  return id
}

/** Add a project waiting on an in-flight build. No-op when it is already
 *  attached or the id is gone. */
export function attachImageBuildProject(id: string, project: ProjectRef): void {
  const e = entries.get(id)
  if (!e || e.projects.some((p) => p.id === project.id)) return
  e.projects.push(project)
  notifyWorkspaceListChanged()
}

/**
 * Append one podman output line to the entry's log tail. Notifies only when
 * the `STEP N/M` progress changes, since each notification rebuilds the
 * snapshot.
 */
export function ingestImageBuildLine(id: string, line: string): void {
  const e = entries.get(id)
  if (!e) return
  const stripped = stripAnsi(line)
  e.log = (e.log + stripped + '\n').slice(-LOG_CAP)
  const step = parseBuildStep(stripped)
  if (!step) return
  if (e.stepCurrent === step.current && e.stepTotal === step.total && e.stepText === step.text) return
  e.stepCurrent = step.current
  e.stepTotal = step.total
  e.stepText = step.text
  notifyWorkspaceListChanged()
}

/** Mark an entry succeeded. No-op if absent. */
export function finishImageBuild(id: string): void {
  const e = entries.get(id)
  if (!e) return
  e.status = 'succeeded'
  e.finishedAt = Date.now()
  notifyWorkspaceListChanged()
}

/** Mark an entry failed; kept until dismissed or superseded by a retry. */
export function failImageBuild(id: string, error: string): void {
  const e = entries.get(id)
  if (!e) return
  e.status = 'failed'
  e.error = error
  e.finishedAt = Date.now()
  notifyWorkspaceListChanged()
}

/** Hide a finished row from the list, keeping the record (see the module
 *  comment). Running entries are left alone. Returns whether anything
 *  changed. */
export function dismissImageBuild(id: string): boolean {
  const e = entries.get(id)
  if (!e || e.status === 'running' || e.dismissed) return false
  e.dismissed = true
  notifyWorkspaceListChanged()
  return true
}

/** Delete a finished entry (the retry path), so its failure no longer
 *  blocks the prewarm sweep. Running entries are kept. Returns whether
 *  anything changed. */
export function forgetImageBuild(id: string): boolean {
  const e = entries.get(id)
  if (!e || e.status === 'running') return false
  entries.delete(id)
  notifyWorkspaceListChanged()
  return true
}

/** Wire-shape projection of one build record. */
function project(e: BuildRecord): ImageBuildEntry {
  return {
    id: e.id,
    tag: e.tag,
    layer: e.layer,
    action: e.action,
    projectSlugs: e.projects.map((p) => p.slug),
    reason: e.reason,
    status: e.status,
    ...(e.stepCurrent !== undefined ? { stepCurrent: e.stepCurrent } : {}),
    ...(e.stepTotal !== undefined ? { stepTotal: e.stepTotal } : {}),
    ...(e.stepText !== undefined ? { stepText: e.stepText } : {}),
    ...(e.error !== undefined ? { error: e.error } : {}),
    startedAt: formatUtcTimestamp(e.startedAt),
    ...(e.finishedAt !== undefined ? { finishedAt: formatUtcTimestamp(e.finishedAt) } : {}),
  }
}

/** Snapshot projection of the registry, newest first, minus dismissed rows. */
export function listImageBuilds(): ImageBuildEntry[] {
  prune()
  return [...entries.values()]
    .filter((e) => !e.dismissed)
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
    .map(project)
}

/** Projected view of a single entry (dismissed or not). */
export function getImageBuild(id: string): ImageBuildEntry | undefined {
  const e = entries.get(id)
  return e ? project(e) : undefined
}

/** The projects waiting on a build, which a retry rebuilds. Empty for
 *  infra builds and unknown ids. */
export function imageBuildProjects(id: string): ProjectRef[] {
  return [...entries.get(id)?.projects ?? []]
}

/** The accumulated log tail for one entry, or undefined if unknown. */
export function getImageBuildLog(id: string): string | undefined {
  return entries.get(id)?.log
}

/**
 * Whether any of `tags` failed within `retryAfterMs`. The prewarm sweep uses
 * this to back off a failing chain. Dismissed failures count; a changed
 * Dockerfile (new tag) or a retry clears it.
 */
export function hasBlockingFailure(tags: string[], retryAfterMs: number): boolean {
  const cutoff = Date.now() - retryAfterMs
  return [...entries.values()].some((e) =>
    e.status === 'failed' && tags.includes(e.tag) && (e.finishedAt ?? 0) > cutoff)
}

/** Test helper: drop all tracked entries. */
export function clearAllImageBuildsForTests(): void {
  entries.clear()
}
