import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { DIFF_CUT_LINE, type WorkspaceChanges } from '@yaac/shared/types'
import { api } from '#lib/api'
import { parseDiffPart, splitDiff, type DiffPart, type ParsedFileDiff } from '#lib/diff'

/** What a reader near a file's diff wants: its `part`, which the changes
 *  poll left out or holds from an older reading, or the `rest` of a part
 *  that was cut short. */
export type DiffWant = 'part' | 'rest'

/** A part loaded beyond the poll's body, and the reading it was read at. */
interface Loaded extends DiffPart {
  at: string
}

/** The most files one load asks for. */
const BATCH_FILES = 50

/** A part's header, everything before its first hunk. Its `index` line
 *  names both blobs, so two parts with the same header diff the same. */
function headerOf(text: string): string {
  const hunk = text.indexOf('\n@@')
  return hunk === -1 ? text : text.slice(0, hunk)
}

const lineCount = (text: string): number => text.split('\n').length - 1

/**
 * The Changes pane's diffs: the changes poll's body (`data`), plus what
 * the pane loads past it (docs/file-editor.md "Changes"). The poll caps its
 * body, so a reader near a file the cap left out wants its `part`, and one
 * near the end of a cut part wants the `rest`, a page at a time as it
 * scrolls. Loads run one at a time, the left-out files in batches.
 *
 * Every load names the reading it extends by its trees, so a page always
 * continues the text it was asked to. A loaded part outlives its reading
 * while a later poll shows the same header for the file, so a file the
 * agent did not touch keeps what was scrolled through; one the poll no
 * longer covers is shown as loaded until a reader near it loads it again.
 */
export function useChangeDiffs(workspaceId: string, data: WorkspaceChanges | undefined): {
  diffs: Map<string, ParsedFileDiff>
  /** Whether loading a file's part or its rest failed at this reading. */
  failed: (path: string) => boolean
  want: (path: string, kind: DiffWant, near: boolean) => void
} {
  const [version, bump] = useReducer((n: number) => n + 1, 0)
  const loaded = useRef(new Map<string, Loaded>())
  const wanted = useRef(new Set<string>())
  const failedAt = useRef(new Map<string, string>())
  const busy = useRef(false)
  const latest = useRef(data)
  const at = data?.diff === undefined ? '' : `${data.base} ${data.work}`
  const polled = useMemo(() => splitDiff(data?.diff ?? ''), [data?.diff])
  const polledRef = useRef(polled)

  useEffect(() => {
    loaded.current.clear()
    failedAt.current.clear()
  }, [workspaceId])

  /**
   * A file's part as far as it is held, and whether it is of `reading`.
   * A poll whose body is whole has every part, so a file it has none for
   * has none.
   */
  const partOf = useCallback((path: string, poll: Map<string, DiffPart>, reading: string, truncated: boolean) => {
    const p = poll.get(path)
    const l = loaded.current.get(path)
    if (l && (l.at === reading || (p && headerOf(p.text) === headerOf(l.text)))) {
      return { part: p && p.text.length > l.text.length ? p : l, current: true }
    }
    if (p) return { part: p, current: true }
    return l && truncated ? { part: l, current: false } : undefined
  }, [])

  const pump = useCallback(async (): Promise<void> => {
    const d = latest.current
    if (busy.current || d?.diff === undefined) return
    const reading = `${d.base} ${d.work}`
    const poll = polledRef.current
    const needs = (kind: DiffWant, path: string): boolean => {
      if (!wanted.current.has(`${kind}:${path}`) || failedAt.current.get(`${kind}:${path}`) === reading) return false
      const held = partOf(path, poll, reading, d.truncated)
      return kind === 'rest' ? held?.current === true && held.part.cut : (held ? !held.current : d.truncated)
    }
    const rest = d.files.find((f) => !f.binary && needs('rest', f.path))
    const batch = rest ? [rest] : d.files.filter((f) => !f.binary && needs('part', f.path)).slice(0, BATCH_FILES)
    if (batch.length === 0) return
    const held = rest && partOf(rest.path, poll, reading, d.truncated)!.part
    const keys = batch.map((f) => `${rest ? 'rest' : 'part'}:${f.path}`)
    busy.current = true
    try {
      const { diff } = await api.workspace[':id'].changes.diff.$post({
        param: { id: workspaceId },
        json: {
          base: d.base,
          work: d.work,
          files: batch.map((f) => ({ path: f.path, ...f.oldPath ? { oldPath: f.oldPath } : {} })),
          ...held ? { skip: lineCount(held.text) } : {},
        },
      })
      if (rest && held) {
        const mark = `${DIFF_CUT_LINE}\n`
        const cut = diff === mark || diff.endsWith(`\n${mark}`)
        const text = cut ? diff.slice(0, -mark.length) : diff
        loaded.current.set(rest.path, { text: held.text + text, cut: cut && text !== '', at: reading })
      } else {
        const parts = splitDiff(diff)
        const last = Math.max(-1, ...batch.map((f, i) => (parts.has(f.path) ? i : -1)))
        for (const [i, f] of batch.entries()) {
          const part = parts.get(f.path)
          const l = loaded.current.get(f.path)
          // A file git printed nothing for, before one it did, has no part.
          if (!part && (i < last || last === -1)) loaded.current.set(f.path, { text: '', cut: false, at: reading })
          else if (part && l && headerOf(l.text) === headerOf(part.text) && l.text.length > part.text.length) l.at = reading
          else if (part) loaded.current.set(f.path, { ...part, at: reading })
        }
      }
    } catch {
      for (const k of keys) failedAt.current.set(k, reading)
    } finally {
      busy.current = false
      bump()
    }
    void pump()
  }, [workspaceId, partOf])

  useEffect(() => {
    latest.current = data
    polledRef.current = polled
    // A whole body holds every part, and a file no longer changed has none.
    if (data?.diff !== undefined) {
      const changed = new Set(data.files.map((f) => f.path))
      for (const path of loaded.current.keys()) if (!data.truncated || !changed.has(path)) loaded.current.delete(path)
    }
    void pump()
  }, [data, polled, pump])

  const want = useCallback((path: string, kind: DiffWant, near: boolean): void => {
    const key = `${kind}:${path}`
    if (!near) {
      wanted.current.delete(key)
      return
    }
    wanted.current.add(key)
    failedAt.current.delete(key)
    // Readers coming into view together land in one batch.
    queueMicrotask(() => void pump())
  }, [pump])

  // Parsing a part is the costly step, so each is parsed once per text.
  const parsed = useRef(new Map<string, { part: DiffPart; diff: ParsedFileDiff }>())
  // A part of an older reading whose reload failed is dropped, so the file
  // shows that rather than a diff it can no longer vouch for.
  const diffs = useMemo(() => {
    void version
    const out = new Map<string, ParsedFileDiff>()
    const kept = new Map<string, { part: DiffPart; diff: ParsedFileDiff }>()
    for (const path of new Set([...polled.keys(), ...loaded.current.keys()])) {
      const held = partOf(path, polled, at, data?.truncated === true)
      if (!held || (!held.current && failedAt.current.get(`part:${path}`) === at)) continue
      let p = parsed.current.get(path)
      if (p?.part.text !== held.part.text || p.part.cut !== held.part.cut) {
        p = { part: held.part, diff: parseDiffPart(path, held.part) }
      }
      kept.set(path, p)
      out.set(path, p.diff)
    }
    parsed.current = kept
    return out
  }, [polled, at, data?.truncated, version, partOf])

  const failed = useCallback((path: string): boolean => (['part', 'rest'] as const)
    .some((k) => failedAt.current.get(`${k}:${path}`) === at), [at])

  return { diffs, failed, want }
}
