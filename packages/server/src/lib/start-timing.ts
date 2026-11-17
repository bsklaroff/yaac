/**
 * What each phase of a workspace start cost, written to the server log as
 * one `[timing]` line per start (docs/start-timing.md).
 *
 * A start opens a record with `startTiming`. Code anywhere beneath it that
 * knows the workspace's id adds to it through `timingOf`, which answers
 * undefined while no start of that workspace is open, so a mark costs a map
 * lookup and nothing has to be passed down. The line is written once the
 * start has ended and everything it still waits on has settled (the
 * agent's first sign of work, a catch-up after launch), or `HOLD_CAP_MS`
 * after it ended, whichever comes first.
 */
import { serverLog } from './log'

/** How long after its end a start's line waits for what it holds open. */
export const HOLD_CAP_MS = 30_000

export interface StartTiming {
  /** Name the workspace the start brings up, which `timingOf` finds it by.
   *  A start never named writes no line. */
  identify(workspaceId: string): void
  /** A phase that ran from `fromMs` to `toMs` (epoch ms, default now). The
   *  first phase of a name is kept. */
  phase(name: string, fromMs: number, toMs?: number): void
  /** Time `task` as a phase starting now, ending when it settles. */
  time<T>(name: string, task: Promise<T>): Promise<T>
  /** A fact that is not a duration, such as what a catch-up did. */
  note(name: string, value: string): void
  /** Hold the line open until the returned function is called. */
  hold(): () => void
  /** Hold the line open for phase `name`, from `fromMs` until `seen(key)`,
   *  which may already have come. */
  expect(key: string, name: string, fromMs: number): void
  seen(key: string): void
  /** The start is over, with `outcome` (`ok`, `failed`, `fallback`). */
  end(outcome: string): void
}

const open = new Map<string, StartTiming>()

/** The open record of a start of `workspaceId`, if there is one. */
export function timingOf(workspaceId: string): StartTiming | undefined {
  return open.get(workspaceId)
}

/** A phase or fact of one checkout: `name` for one at the workspace root,
 *  `name.<folder>` for one in a folder. */
export function ofCheckout(name: string, checkoutPath: string): string {
  return checkoutPath === '' ? name : `${name}.${checkoutPath}`
}

/** A word safe to put in the line: no spaces or `=`. */
const word = (s: string): string => s.replace(/[\s=]/g, '_')

/** Open the record of a start of `kind` (`create`, `warm`, `restart`, `claim`). */
export function startTiming(kind: string, workspaceId?: string): StartTiming {
  const startedAt = Date.now()
  let id: string | undefined
  const phases: Array<{ name: string; from: number; to: number }> = []
  const notes = new Map<string, string>()
  const expected = new Map<string, { name: string; fromMs: number; release: () => void }>()
  /** When each key was seen before it was expected. */
  const seenAt = new Map<string, number>()
  let holds = 0
  let ended: { at: number; outcome: string } | undefined
  let capped = false
  let written = false
  let cap: NodeJS.Timeout | undefined

  const flush = (): void => {
    if (written || ended === undefined || (holds > 0 && !capped)) return
    written = true
    clearTimeout(cap)
    if (id === undefined) return
    if (open.get(id) === record) open.delete(id)
    const spans = [...phases].sort((a, b) => a.from - b.from)
      .map((p) => `${p.name}=${String(p.from - startedAt)}+${String(p.to - p.from)}`)
    const facts = [...notes].map(([k, v]) => `${k}=${v}`)
    serverLog([`[timing] ${id} ${kind} ${ended.outcome} total=${String(ended.at - startedAt)}`, ...spans, ...facts].join(' '))
  }

  const record: StartTiming = {
    identify(workspaceId) {
      if (id !== undefined && open.get(id) === record) open.delete(id)
      id = workspaceId
      if (!written) open.set(workspaceId, record)
    },
    phase(name, fromMs, toMs = Date.now()) {
      if (written || phases.some((p) => p.name === word(name))) return
      phases.push({ name: word(name), from: Math.round(fromMs), to: Math.round(toMs) })
    },
    time(name, task) {
      const fromMs = Date.now()
      const done = (): void => { record.phase(name, fromMs) }
      task.then(done, done)
      return task
    },
    note(name, value) {
      if (!written && !notes.has(word(name))) notes.set(word(name), word(value))
    },
    hold() {
      if (written) return () => {}
      holds++
      let released = false
      return () => {
        if (released) return
        released = true
        holds--
        flush()
      }
    },
    expect(key, name, fromMs) {
      const at = seenAt.get(key)
      if (at !== undefined) record.phase(name, fromMs, at)
      else if (!written && !expected.has(key)) expected.set(key, { name, fromMs, release: record.hold() })
    },
    seen(key) {
      const e = expected.get(key)
      if (e === undefined) {
        if (!written && !seenAt.has(key)) seenAt.set(key, Date.now())
        return
      }
      expected.delete(key)
      record.phase(e.name, e.fromMs)
      e.release()
    },
    end(outcome) {
      if (ended !== undefined) return
      ended = { at: Date.now(), outcome }
      cap = setTimeout(() => {
        capped = true
        flush()
      }, HOLD_CAP_MS)
      cap.unref()
      flush()
    },
  }
  if (workspaceId !== undefined) record.identify(workspaceId)
  return record
}
