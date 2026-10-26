import { describe, it, expect } from 'vitest'
import { compileRepeat, DEFAULT_REPEAT, describeSchedule, EVERY_MINUTES, parseRepeat } from '#lib/routines'

describe('routine schedule presets', () => {
  it('compiles each preset to cron and reads it back as that preset', () => {
    for (const kind of ['minutes', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly'] as const) {
      const cron = compileRepeat({ ...DEFAULT_REPEAT, kind })
      expect(parseRepeat(cron)?.kind, cron).toBe(kind)
    }
    expect(describeSchedule('0 9 * * 1-5')).toBe('Weekdays 09:00')
  })

  it('offers every-N-minutes only for intervals that divide an hour, leaving the rest to Custom', () => {
    expect(EVERY_MINUTES.every((n) => 60 % n === 0)).toBe(true)
    expect(describeSchedule('*/15 * * * *')).toBe('Every 15 minutes')
    // `*/45` fires at :00 and :45, so it is not every 45 minutes.
    expect(parseRepeat('*/45 * * * *')).toBeUndefined()
    expect(describeSchedule('*/45 * * * *')).toBe('*/45 * * * *')
  })
})
