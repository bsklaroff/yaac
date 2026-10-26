import { Cron } from 'croner'

/**
 * Time handling for scheduled workspaces, timeouts and routines
 * (docs/routines.md). Durations are whole minutes, because the server acts
 * on its 60s reconcile resync and promises nothing finer. Wall-clock times
 * are read in the user's stored zone, never the zone of whatever process
 * typed them.
 */

const MINUTE = 60_000
const UNIT_MINUTES: Record<string, number> = { m: 1, h: 60, d: 1440 }

/**
 * `1h30m`, `45m`, `2d` → whole minutes. Units combine in any order, each at
 * most once. Returns undefined for anything else, including a total under a
 * minute.
 */
export function parseDuration(text: string): number | undefined {
  const s = text.trim().toLowerCase()
  if (!/^(\d+[mhd])+$/.test(s)) return undefined
  const seen = new Set<string>()
  let minutes = 0
  for (const [, n, unit] of s.matchAll(/(\d+)([mhd])/g)) {
    if (seen.has(unit)) return undefined
    seen.add(unit)
    minutes += Number(n) * UNIT_MINUTES[unit]
  }
  return minutes >= 1 && Number.isSafeInteger(minutes) ? minutes : undefined
}

/** Minutes → `2d 3h 5m`, largest units first, zero parts left out. */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const parts = [[Math.floor(m / 1440), 'd'], [Math.floor((m % 1440) / 60), 'h'], [m % 60, 'm']] as const
  const shown = parts.filter(([n]) => n > 0).map(([n, u]) => `${n}${u}`)
  return shown.length > 0 ? shown.join(' ') : '0m'
}

/**
 * A zone name `Intl` knows. The charset check keeps it to IANA names, since
 * `Intl` also takes offsets like `+05:00`, and the value lands in `TZ`.
 */
export function isTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]+$/.test(timeZone)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

function cron(expr: string, timeZone: string): Cron {
  return new Cron(expr.trim(), { timezone: timeZone, mode: '5-part' })
}

/** Why `expr` is not a 5-field cron expression (or `@daily`-style
 *  nickname), or undefined if it is one. */
export function cronError(expr: string): string | undefined {
  try {
    cron(expr, 'UTC')
    return undefined
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).replace(/^CronPattern: /, '')
  }
}

/** The next `n` ticks of `expr` in `timeZone` strictly after `from`. */
export function nextCronRuns(expr: string, timeZone: string, from: Date, n: number): Date[] {
  return cron(expr, timeZone).nextRuns(n, from)
}

/** The latest tick of `expr` in `timeZone` at or before `at`. */
export function latestCronRun(expr: string, timeZone: string, at: Date): Date | undefined {
  // `previousRuns` excludes its reference, so step one second past it.
  return cron(expr, timeZone).previousRuns(1, new Date(at.getTime() + 1000))[0]
}

/**
 * The instant a wall-clock time names in `timeZone`. A time in a DST gap
 * moves forward by the gap, as clocks do; one a fall-back repeats is its
 * first occurrence, as croner fires a cron.
 */
export function zonedTimeToInstant(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  // The candidates are the time under the zone's offsets an hour or so
  // either side. Those that read back as the wall time asked for are its
  // occurrences, earliest first; in a gap there are none, and the later
  // candidate is the time moved forward.
  const day = 86_400_000
  const candidates = [...new Set([zoneOffset(asUtc - day, timeZone), zoneOffset(asUtc + day, timeZone)])]
    .map((offset) => asUtc - offset)
    .sort((a, b) => a - b)
  const matches = candidates.filter((t) => {
    const p = wallClock(new Date(t), timeZone)
    return p.day === wall.day && p.hour === wall.hour && p.minute === wall.minute
  })
  return new Date(matches[0] ?? candidates[candidates.length - 1])
}

/** `timeZone`'s offset from UTC at `epochMs`, in ms. */
function zoneOffset(epochMs: number, timeZone: string): number {
  const p = wallClock(new Date(epochMs), timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(epochMs / 1000) * 1000
}

function wallClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(at)
  const get = (type: string): number => Number(parts.find((x) => x.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
}

/**
 * When a `--start-at` text names, read in `timeZone`:
 * - ISO 8601 with an offset or `Z`: that instant;
 * - ISO 8601 without one (`2026-10-24T09:00`, also what a `datetime-local`
 *   input yields; a space may stand in for the `T`): that wall-clock time;
 * - `HH:MM`: the next time that clock time comes round.
 * Returns undefined for anything else.
 */
export function resolveStartAt(text: string, timeZone: string, now: Date): Date | undefined {
  const s = text.trim()
  const clock = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (clock) {
    const hour = Number(clock[1])
    const minute = Number(clock[2])
    if (hour > 23 || minute > 59) return undefined
    const today = wallClock(now, timeZone)
    let at = zonedTimeToInstant({ ...today, hour, minute }, timeZone)
    if (at.getTime() <= now.getTime()) {
      // Tomorrow's date, found by stepping a day in UTC from noon today.
      const tomorrow = wallClock(new Date(zonedTimeToInstant({ ...today, hour: 12, minute: 0 }, timeZone).getTime() + 1440 * MINUTE), timeZone)
      at = zonedTimeToInstant({ ...tomorrow, hour, minute }, timeZone)
    }
    return at
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s)
  if (!iso) return undefined
  const [year, month, day, hour, minute] = iso.slice(1, 6).map(Number)
  // A day the month lacks would roll over into the next month.
  const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (month < 1 || month > 12 || day < 1 || day > monthDays || hour > 23 || minute > 59) return undefined
  if (iso[7] !== undefined) {
    const at = new Date(s.replace(' ', 'T'))
    return Number.isNaN(at.getTime()) ? undefined : at
  }
  return zonedTimeToInstant({ year, month, day, hour, minute }, timeZone)
}

/** `at` as `Fri Oct 24 09:00` in `timeZone`. */
export function formatInZone(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(at).replace(/,/g, '')
}

/** Whole minutes from `now` until `at`, at least 0, rounded up. */
export function minutesUntil(at: Date, now: Date): number {
  return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / MINUTE))
}
