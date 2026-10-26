/**
 * The routine form's Repeats presets (docs/routines.md): the common
 * schedules a user picks instead of writing cron. Each compiles to a 5-field
 * cron expression, and a cron that one of them would produce reads back as
 * that preset, so reopening a routine shows how it was made. Anything else
 * is shown as Custom.
 */

export const REPEAT_KINDS = ['minutes', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly'] as const
export type RepeatKind = typeof REPEAT_KINDS[number]

/** A preset and every preset's inputs, so switching presets keeps the
 *  time already typed. `days` are cron weekdays (0 is Sunday). */
export interface Repeat {
  kind: RepeatKind
  every: number
  minute: number
  hour: number
  days: number[]
  day: number
}

export const DEFAULT_REPEAT: Repeat = { kind: 'weekdays', every: 15, minute: 0, hour: 9, days: [1], day: 1 }

/** The intervals `Every N minutes` offers: those dividing an hour, since
 *  `*\/45` fires at :00 and :45, 45 then 15 minutes apart. */
export const EVERY_MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] as const

/** Weekdays in the order the week's toggles show them, Monday first. */
export const WEEK = [
  { day: 1, short: 'M', name: 'Mon' }, { day: 2, short: 'T', name: 'Tue' }, { day: 3, short: 'W', name: 'Wed' },
  { day: 4, short: 'T', name: 'Thu' }, { day: 5, short: 'F', name: 'Fri' }, { day: 6, short: 'S', name: 'Sat' },
  { day: 0, short: 'S', name: 'Sun' },
] as const

const pad = (n: number): string => String(n).padStart(2, '0')

export function compileRepeat(r: Repeat): string {
  switch (r.kind) {
    case 'minutes': return `*/${r.every} * * * *`
    case 'hourly': return `${r.minute} * * * *`
    case 'daily': return `${r.minute} ${r.hour} * * *`
    case 'weekdays': return `${r.minute} ${r.hour} * * 1-5`
    case 'weekly': return `${r.minute} ${r.hour} * * ${[...r.days].sort((a, b) => a - b).join(',')}`
    case 'monthly': return `${r.minute} ${r.hour} ${r.day} * *`
  }
}

/** The preset `cron` is, or undefined for one only Custom can show. */
export function parseRepeat(cron: string): Repeat | undefined {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5 || f[3] !== '*') return undefined
  const [mi, h, dom, , dow] = f
  const num = (s: string, min: number, max: number): number | undefined =>
    /^\d{1,2}$/.test(s) && Number(s) >= min && Number(s) <= max ? Number(s) : undefined
  const every = /^\*\/(\d{1,2})$/.exec(mi)
  if (h === '*' && dom === '*' && dow === '*') {
    if (every && (EVERY_MINUTES as readonly number[]).includes(Number(every[1]))) {
      return { ...DEFAULT_REPEAT, kind: 'minutes', every: Number(every[1]) }
    }
    const minute = num(mi, 0, 59)
    return minute === undefined ? undefined : { ...DEFAULT_REPEAT, kind: 'hourly', minute }
  }
  const minute = num(mi, 0, 59)
  const hour = num(h, 0, 23)
  if (minute === undefined || hour === undefined) return undefined
  const at = { ...DEFAULT_REPEAT, minute, hour }
  if (dom === '*' && dow === '*') return { ...at, kind: 'daily' }
  if (dom === '*' && dow === '1-5') return { ...at, kind: 'weekdays' }
  if (dom === '*' && /^[0-6](,[0-6])*$/.test(dow)) return { ...at, kind: 'weekly', days: [...new Set(dow.split(',').map(Number))] }
  const day = num(dom, 1, 31)
  return dow === '*' && day !== undefined ? { ...at, kind: 'monthly', day } : undefined
}

/** A schedule in words, as the sidebar and routine pane show it
 *  ("Weekdays 09:00"); a cron no preset makes is shown as is. */
export function describeSchedule(cron: string): string {
  const r = parseRepeat(cron)
  if (r === undefined) return cron.trim()
  const at = `${pad(r.hour)}:${pad(r.minute)}`
  switch (r.kind) {
    case 'minutes': return r.every === 1 ? 'Every minute' : `Every ${r.every} minutes`
    case 'hourly': return `Hourly at :${pad(r.minute)}`
    case 'daily': return `Daily ${at}`
    case 'weekdays': return `Weekdays ${at}`
    case 'weekly': return `${WEEK.filter((d) => r.days.includes(d.day)).map((d) => d.name).join(', ')} ${at}`
    case 'monthly': return `Monthly on day ${r.day} ${at}`
  }
}
