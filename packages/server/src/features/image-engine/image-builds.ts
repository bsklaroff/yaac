/**
 * In-memory registry of image builds and registry pushes in flight (or
 * recently finished). Surfaced in the server snapshot as metadata only —
 * status, chain step, podman STEP progress — so the webapp can render a
 * "building" indicator; the raw log tail is served by `GET
 * /image/builds/:id/log` and polled only while the overlay is open (streaming
 * log lines through snapshots would rebuild the full snapshot at line rate).
 *
 * The server is a single process, so a module-level map is enough. Finished
 * entries (succeeded and failed alike) persist until the user dismisses them —
 * `dismiss` hides a row from the list but keeps the record, so a dismissed
 * failure still gates the background prewarm sweep's backoff via
 * `hasBlockingFailure` (dismissing is an acknowledgement, not a retry). An
 * explicit retry (`forgetImageBuild` + rebuild) or a superseding build clears
 * that backoff. A hard `MAX_ENTRIES` cap bounds memory; nothing ages out on a
 * timer.
 */
import { serverLink } from '#server-link'
import { stripAnsi } from '@yaac/shared/ansi'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { ImageBuildEntry, ImageLayerName } from '@yaac/shared/types'

export type ImageBuildReason = 'session' | 'prewarm' | 'rebuild'

interface BuildRecord {
  id: string
  tag: string
  layer: ImageLayerName | 'push' | 'proxy' | 'netd'
  action: 'build' | 'push'
  projectSlugs: string[]
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
  /** User dismissed this finished row: hidden from `listImageBuilds` but kept
   *  so a dismissed failure still backs off the prewarm sweep. */
  dismissed?: boolean
}

const entries = new Map<string, BuildRecord>()
let seq = 0

/** Per-entry log tail cap; with MAX_ENTRIES this bounds memory at ~2MB. */
const LOG_CAP = 64_000
const MAX_ENTRIES = 30
const STEP_TEXT_MAX = 120

/**
 * Parse podman/buildah's per-instruction progress line, e.g.
 * `STEP 3/14: RUN apt-get update`. Returns null for any other line — if the
 * format ever changes the UI degrades to status + raw log, nothing breaks.
 */
export function parseBuildStep(line: string): { current: number; total: number; text: string } | null {
  const m = /^STEP\s+(\d+)\/(\d+):\s*(.*)$/.exec(line)
  if (!m) return null
  return { current: Number(m[1]), total: Number(m[2]), text: m[3].slice(0, STEP_TEXT_MAX) }
}

/** Enforce the entry cap as a memory backstop — nothing ages out on a timer,
 *  so finished rows persist until dismissed. Over the cap, drop dismissed rows
 *  first (already hidden), then the oldest finished ones; running entries are
 *  never dropped. */
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
 * Track a new build/push. A finished entry for the same tag+action is
 * superseded (a retry replaces a stale failure, so its `hasBlockingFailure`
 * backoff clears). Returns the entry id the caller uses for log ingestion
 * and completion.
 */
export function registerImageBuild(input: {
  tag: string
  layer: ImageLayerName | 'push' | 'proxy' | 'netd'
  action: 'build' | 'push'
  /** Omitted for shared infrastructure builds with no owning project (the
   *  proxy sidecar), which register with an empty `projectSlugs`. */
  projectSlug?: string
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
    projectSlugs: input.projectSlug ? [input.projectSlug] : [],
    reason: input.reason,
    status: 'running',
    log: '',
    startedAt: Date.now(),
  })
  prune()
  serverLink().workspacesChanged()
  return id
}

/** A joiner coalescing onto an in-flight build records its project. No-op
 *  (and no broadcast) when the slug is already attached or the id is gone. */
export function attachImageBuildProject(id: string, projectSlug: string): void {
  const e = entries.get(id)
  if (!e || e.projectSlugs.includes(projectSlug)) return
  e.projectSlugs.push(projectSlug)
  serverLink().workspacesChanged()
}

/**
 * Append one podman output line to the entry's log tail. Broadcasts only
 * when the parsed `STEP N/M` progress advances — never per raw line, since
 * every snapshot rebuild re-lists active sessions.
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
  serverLink().workspacesChanged()
}

/** Mark an entry succeeded. No-op if absent. */
export function finishImageBuild(id: string): void {
  const e = entries.get(id)
  if (!e) return
  e.status = 'succeeded'
  e.finishedAt = Date.now()
  serverLink().workspacesChanged()
}

/** Mark an entry failed; kept until dismissed or superseded by a retry. */
export function failImageBuild(id: string, error: string): void {
  const e = entries.get(id)
  if (!e) return
  e.status = 'failed'
  e.error = error
  e.finishedAt = Date.now()
  serverLink().workspacesChanged()
}

/** Hide a finished row from the list (user dismissed the × ). The record is
 *  kept, so a dismissed failure still backs off the prewarm sweep —
 *  dismissing is an acknowledgement, not a retry. Running entries are left
 *  alone; their coordinator owns the lifecycle. Returns whether anything
 *  changed. */
export function dismissImageBuild(id: string): boolean {
  const e = entries.get(id)
  if (!e || e.status === 'running' || e.dismissed) return false
  e.dismissed = true
  serverLink().workspacesChanged()
  return true
}

/** Drop a finished entry entirely — the explicit retry path. Unlike
 *  `dismiss`, this removes the record, so a failure stops backing off the
 *  prewarm sweep and the rebuild can proceed immediately. Running entries are
 *  kept. Returns whether anything changed. */
export function forgetImageBuild(id: string): boolean {
  const e = entries.get(id)
  if (!e || e.status === 'running') return false
  entries.delete(id)
  serverLink().workspacesChanged()
  return true
}

/** Wire-shape projection of one build record. */
function project(e: BuildRecord): ImageBuildEntry {
  return {
    id: e.id,
    tag: e.tag,
    layer: e.layer,
    action: e.action,
    projectSlugs: [...e.projectSlugs],
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

/** Projected view of a single entry (dismissed or not) — used by the retry
 *  path to read a build's target (owning project slugs, or none for infra). */
export function getImageBuild(id: string): ImageBuildEntry | undefined {
  const e = entries.get(id)
  return e ? project(e) : undefined
}

/** The accumulated log tail for one entry, or undefined if unknown. */
export function getImageBuildLog(id: string): string | undefined {
  return entries.get(id)?.log
}

/**
 * Whether a recent failure covers any of `tags`. The prewarm sweep uses this
 * to back off a chain whose build just failed instead of retrying every 5s
 * tick. Dismissed failures still count (dismissing only hides the row); the
 * backoff clears when the window lapses, the Dockerfile changes (a new tag),
 * or the user hits retry (which forgets the entry).
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
