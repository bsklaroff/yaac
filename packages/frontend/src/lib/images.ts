import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSnapshotSelect } from '#lib/useSnapshot'
import type { ImageBuild, ImageBuildStatus, ImageSummary } from '@yaac/shared/types'

/*
 * Shared pieces of the image screens (docs/image-builds.md "Images, revisions and builds"): the
 * Images settings page, the user's Dockerfile.user page, the build page and
 * the create pane's image selector.
 */

/** Every image query's key starts with this, so one invalidation refreshes
 *  them all. */
export const IMAGE_KEY = 'image'

/** A build still to finish. */
export const isLive = (status: ImageBuildStatus): boolean => status === 'queued' || status === 'running'

/**
 * Refresh the image queries whenever the snapshot's live build list changes:
 * a build starting, finishing or failing changes an image's state and its
 * build rows, and the snapshot is where that shows first.
 */
export function useFollowBuilds(): void {
  const queryClient = useQueryClient()
  const fingerprint = useSnapshotSelect((s) => (s?.imageBuilds ?? []).map((b) => `${b.id}:${b.status}`).join(','))
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: [IMAGE_KEY] })
  }, [fingerprint, queryClient])
}

/** How an image's state reads in a list or a selector. */
export function imageStateLabel(image: ImageSummary): string {
  switch (image.state) {
    case 'ready': return 'ready'
    case 'building': return image.currentRevision ? `building revision ${image.currentRevision.number}` : 'building'
    case 'never-built': return 'never built'
    case 'failed': return 'build failed'
  }
}

/** A build's run time so far, or in all, as "1m 20s". */
export function buildDuration(b: Pick<ImageBuild, 'startedAt' | 'finishedAt'>, now = Date.now()): string {
  if (b.startedAt === undefined) return ''
  const end = b.finishedAt !== undefined ? Date.parse(b.finishedAt) : now
  const s = Math.max(0, Math.round((end - Date.parse(b.startedAt)) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** ArrayBuffer to base64, chunked so large files don't blow the arg limit. */
export function encodeBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  const chunks: string[] = []
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return btoa(chunks.join(''))
}

/** One step of a BuildKit plain-progress log: every line its `#<n>` prefix
 *  names, the prefix cut off. */
export interface LogStep {
  /** The `<n>` of `#<n>`; '' for lines outside any step. */
  id: string
  /** Its first line, which names the step (`[3/9] RUN make`). */
  title: string
  lines: string[]
  /** How it ended, from its last `CACHED`, `DONE <time>` or `ERROR` line. */
  outcome?: 'cached' | 'done' | 'error' | 'canceled'
  /** The time a `DONE` line gives. */
  took?: string
}

const STEP_LINE = /^#(\d+) (.*)$/

/**
 * Split a BuildKit plain-progress log into its steps, in the order each
 * first appears. BuildKit interleaves steps that run in parallel, so a
 * step's lines are gathered from wherever they fall.
 */
export function logSteps(log: string): LogStep[] {
  const steps = new Map<string, LogStep>()
  for (const line of log.split('\n')) {
    if (line === '') continue
    const m = STEP_LINE.exec(line)
    const id = m?.[1] ?? ''
    const text = m?.[2] ?? line
    let step = steps.get(id)
    if (step === undefined) {
      step = { id, title: id === '' ? 'Output' : text, lines: [] }
      steps.set(id, step)
      if (id !== '') continue
    }
    step.lines.push(text)
    if (text === 'CACHED') step.outcome = 'cached'
    else if (text.startsWith('DONE')) {
      step.outcome = 'done'
      step.took = text.slice('DONE'.length).trim()
    } else if (text.startsWith('ERROR')) step.outcome = 'error'
    else if (text === 'CANCELED') step.outcome = 'canceled'
  }
  return [...steps.values()]
}
