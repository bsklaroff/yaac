import { describe, it, expect } from 'vitest'
import { compileRepeat, DEFAULT_REPEAT, describeSchedule, EVERY_MINUTES, parseRepeat } from '#lib/routines'

describe('routine schedule presets', () => {
  it('compiles each preset to cron and reads it back as that preset', () => {
    for (const kind of ['minutes', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly'] as const) {
      const cron = compileRepeat({ ...DEFAULT_REPEAT, kind })
      expect(parseRepeat(cron)?.kind, cron).toBe(kind)
    }
    expect(describeSchedule('0 9 * * 1-5')).toBe('At 09:00, Monday through Friday')
  })

  it('offers every-N-minutes only for intervals that divide an hour, leaving the rest to Custom', () => {
    expect(EVERY_MINUTES.every((n) => 60 % n === 0)).toBe(true)
    expect(describeSchedule('*/15 * * * *')).toBe('Every 15 minutes')
    // `*/45` fires at :00 and :45, so it is not every 45 minutes.
    expect(parseRepeat('*/45 * * * *')).toBeUndefined()
  })

  it('describes any cron in words that agree with when croner fires it', () => {
    expect(describeSchedule('0 9,17 * * *')).toBe('Twice daily at 09:00 and 17:00')
    expect(describeSchedule('@midnight')).toBe('Daily at 00:00')
    // Weekdays Monday first, Sunday (0 or 7) once and last.
    expect(describeSchedule('0 9 * * 0,1')).toBe('At 09:00, only on Monday and Sunday')
    expect(describeSchedule('0 9 * * 0,7')).toBe('At 09:00, only on Sunday')
    // Steps that restart unevenly each cycle are spelled out.
    expect(describeSchedule('*/45 * * * *')).toBe('At 0 and 45 minutes past the hour')
    expect(describeSchedule('0 0-23/5 * * *')).toBe('5 times daily at 00:00, 05:00, 10:00, 15:00 and 20:00')
    expect(describeSchedule('0 0 1 */5 *')).toBe('At 00:00, on day 1 of the month, only in January, June, and November')
    expect(describeSchedule('0 0 * * */2')).toBe('At 00:00, only on Tuesday, Thursday, Saturday, and Sunday')
    expect(describeSchedule('0 */6 * * *')).toBe('On the hour, every 6 hours')
    // Day of month and day of week both set fire on either.
    expect(describeSchedule('0 9 1 * 1-5')).toBe('At 09:00, on day 1 of the month, or Monday through Friday')
    expect(describeSchedule('0 9 1 * 1')).toBe('At 09:00, on day 1 of the month, or on Monday')
    // A half cronstrue describes as nothing (`*/1`) still ORs, so it fires daily.
    expect(describeSchedule('0 9 */1 * 1')).toBe('0 9 */1 * 1')
    // croner fires a `?` cron daily, and cronstrue can't read FRI#L.
    expect(describeSchedule('0 9 ? * 1')).toBe('0 9 ? * 1')
    expect(describeSchedule('0 9 * * FRI#L')).toBe('0 9 * * FRI#L')
  })
})
