import cronstrue from 'cronstrue'

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

/** The nicknames croner accepts, as the fields they stand for. */
const NICKNAMES: Record<string, string> = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
}

/**
 * A schedule in words, as the sidebar and routine pane show it, via
 * cronstrue ("At 09:00, Monday through Friday"). Its reading is corrected
 * where it would disagree with when croner fires, or read oddly:
 * - a step that restarts unevenly each cycle (`*\/45` fires at :00 and :45,
 *   `*\/5` months in Nov then Jan) is spelled out as the ticks it fires on;
 * - day of month and day of week, when both are set, fire on either (croner
 *   ORs them), where cronstrue reads them as narrowing each other;
 * - weekdays are listed Monday first, so Sunday comes last;
 * - fixed times on every day say so ("Twice daily at 09:00 and 17:00").
 * A cron with a `?` is shown as is, since croner fires it every day whatever
 * the other day field says, and so is one cronstrue can't read.
 */
export function describeSchedule(cron: string): string {
  const expr = cron.trim()
  const fields = (NICKNAMES[expr.toLowerCase()] ?? expr).split(/\s+/)
  if (expr.includes('?')) return expr
  if (fields.length !== 5) return toWords(expr)
  const [mi, h, dom, mon] = [spellOutSteps(fields[0], 0, 59), spellOutSteps(fields[1], 0, 23), fields[2], spellOutSteps(fields[3], 1, 12)]
  let dow = spellOutSteps(fields[4], 0, 6)
  if (/^\d(,\d)*$/.test(dow)) dow = [...new Set(dow.split(',').map((d) => Number(d) || 7))].sort((a, b) => a - b).join(',')

  if (dom !== '*' && dow !== '*') {
    const base = toWords(`${mi} ${h} * * *`)
    const part = (f: string[]): string | undefined => {
      const text = toWords(f.join(' '))
      return text.startsWith(base) ? text.slice(base.length) : undefined
    }
    const [days, weekdays, months] = [part([mi, h, dom, '*', '*']), part([mi, h, '*', '*', dow]), part([mi, h, '*', mon, '*'])]
    if (!days || !weekdays || months === undefined) return expr
    return `${base}${days}, or ${weekdays.replace(/^, (only )?/, '')}${months}`
  }
  const text = toWords([mi, h, dom, mon, dow].join(' '))
  const daily = dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(mi) && /^\d+(,\d+)*$/.test(h)
  if (!daily) return text
  const times = h.split(',').length
  return `${times === 1 ? 'Daily' : times === 2 ? 'Twice daily' : `${times} times daily`} ${text.replace(/^At /, 'at ')}`
}

function toWords(expr: string): string {
  try {
    return cronstrue.toString(expr, { use24HourTimeFormat: true })
  } catch {
    return expr
  }
}

/**
 * `field`, whose values run `lo` to `hi`, with each `*\/n` or `a-b/n` term
 * spelled out as its ticks when it spans the whole cycle without dividing
 * it evenly, so the gap across the wrap differs from `n`. A step over part
 * of the cycle is left alone: cronstrue names its bounds.
 */
function spellOutSteps(field: string, lo: number, hi: number): string {
  return field.split(',').map((term) => {
    const m = /^(?:\*|(\d+)-(\d+))\/(\d+)$/.exec(term)
    if (m === null) return term
    const [from, to] = m[1] === undefined ? [lo, hi] : [Number(m[1]), Number(m[2])]
    const [step, cycle] = [Number(m[3]), hi - lo + 1]
    if (step === 0 || to - from + 1 < cycle || cycle % step === 0) return term
    const ticks: number[] = []
    for (let t = from; t <= to; t += step) ticks.push(t)
    return ticks.join(',')
  }).join(',')
}
