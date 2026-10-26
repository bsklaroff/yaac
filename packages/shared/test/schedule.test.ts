import { describe, it, expect } from 'vitest'
import {
  cronError,
  formatDuration,
  formatInZone,
  isTimeZone,
  latestCronRun,
  minutesUntil,
  nextCronRuns,
  parseDuration,
  resolveStartAt,
  zonedTimeToInstant,
} from '#schedule'

describe('parseDuration', () => {
  it('reads whole minutes from combined units, refusing anything finer or malformed', () => {
    expect(parseDuration('45m')).toBe(45)
    expect(parseDuration('1h30m')).toBe(90)
    expect(parseDuration(' 2D ')).toBe(2880)
    expect(parseDuration('30m1d')).toBe(1470)
    for (const bad of ['', '30s', '0m', '1h1h', '90', 'h', '1.5h', '-5m']) expect(parseDuration(bad), bad).toBeUndefined()
  })
})

describe('formatDuration', () => {
  it('writes the largest units first, leaving out zero parts', () => {
    expect(formatDuration(1590)).toBe('1d 2h 30m')
    expect(formatDuration(60)).toBe('1h')
    expect(formatDuration(0)).toBe('0m')
  })
})

describe('isTimeZone', () => {
  it('takes IANA names only', () => {
    expect(isTimeZone('America/New_York')).toBe(true)
    expect(isTimeZone('UTC')).toBe(true)
    expect(isTimeZone('Mars/Olympus')).toBe(false)
    expect(isTimeZone('+05:00')).toBe(false)
  })
})

describe('cronError', () => {
  it('accepts 5-field expressions and nicknames, and says why anything else is not one', () => {
    expect(cronError('0 9 * * 1-5')).toBeUndefined()
    expect(cronError('@daily')).toBeUndefined()
    expect(cronError('0 0 9 * * 1')).toMatch(/5 parts/)
    expect(cronError('every day')).toBeDefined()
  })
})

describe('nextCronRuns', () => {
  it('lists ticks after a time in the zone, across a DST change', () => {
    // New York springs forward on 2026-03-08: 09:00 is 14:00 UTC before, 13:00 after.
    expect(nextCronRuns('0 9 * * *', 'America/New_York', new Date('2026-03-07T12:00:00Z'), 2).map((d) => d.toISOString()))
      .toEqual(['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z'])
  })
})

describe('latestCronRun', () => {
  it('finds the last tick at or before a time, the time itself included', () => {
    expect(latestCronRun('*/5 * * * *', 'UTC', new Date('2026-10-23T15:00:00Z'))).toEqual(new Date('2026-10-23T15:00:00Z'))
    expect(latestCronRun('0 9 * * 1-5', 'UTC', new Date('2026-10-25T12:00:00Z'))).toEqual(new Date('2026-10-23T09:00:00Z'))
  })
})

describe('zonedTimeToInstant', () => {
  it('reads a time a fall-back repeats as its first occurrence, as croner fires, either side of UTC', () => {
    // New York falls back at 02:00 EDT on 2026-11-01; 01:30 EDT is 05:30 UTC.
    expect(zonedTimeToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York'))
      .toEqual(new Date('2026-11-01T05:30:00Z'))
    // Berlin falls back at 03:00 CEST on 2026-10-25; 02:30 CEST is 00:30 UTC.
    expect(zonedTimeToInstant({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, 'Europe/Berlin'))
      .toEqual(new Date('2026-10-25T00:30:00Z'))
    expect(nextCronRuns('30 2 * * *', 'Europe/Berlin', new Date('2026-10-24T12:00:00Z'), 1))
      .toEqual([new Date('2026-10-25T00:30:00Z')])
    // Lord Howe's half-hour shift: 01:45 at +11 is 14:45 UTC the day before.
    expect(zonedTimeToInstant({ year: 2026, month: 4, day: 5, hour: 1, minute: 45 }, 'Australia/Lord_Howe'))
      .toEqual(new Date('2026-04-04T14:45:00Z'))
  })

  it('reads a wall-clock time in a zone, moving one in a DST gap forward', () => {
    expect(zonedTimeToInstant({ year: 2026, month: 10, day: 24, hour: 9, minute: 0 }, 'Asia/Tokyo'))
      .toEqual(new Date('2026-10-24T00:00:00Z'))
    // 02:30 does not exist in New York on 2026-03-08; clocks read 03:30 EDT.
    expect(zonedTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York'))
      .toEqual(new Date('2026-03-08T07:30:00Z'))
  })
})

describe('resolveStartAt', () => {
  const now = new Date('2026-10-23T15:00:00Z') // 11:00 in New York
  it('reads offset-less and HH:MM times in the zone, and takes an offset as given', () => {
    expect(resolveStartAt('2026-10-24T09:00', 'America/New_York', now)).toEqual(new Date('2026-10-24T13:00:00Z'))
    expect(resolveStartAt('2026-10-24 09:00', 'America/New_York', now)).toEqual(new Date('2026-10-24T13:00:00Z'))
    expect(resolveStartAt('2026-10-24T09:00+02:00', 'America/New_York', now)).toEqual(new Date('2026-10-24T07:00:00Z'))
    // Later today, then tomorrow once today's has passed.
    expect(resolveStartAt('12:00', 'America/New_York', now)).toEqual(new Date('2026-10-23T16:00:00Z'))
    expect(resolveStartAt('09:00', 'America/New_York', now)).toEqual(new Date('2026-10-24T13:00:00Z'))
    expect(resolveStartAt('2028-02-29T09:00', 'UTC', now)).toEqual(new Date('2028-02-29T09:00:00Z'))
    // A day the month lacks is refused rather than rolled into the next.
    for (const bad of ['tomorrow', '25:00', '2026-13-01T00:00', '9am', '2026-02-31T09:00', '2026-02-29T09:00Z', '2026-04-31 10:00']) {
      expect(resolveStartAt(bad, 'UTC', now), bad).toBeUndefined()
    }
  })
})

describe('formatInZone', () => {
  it('writes a short date and 24-hour time in the zone', () => {
    expect(formatInZone(new Date('2026-10-23T15:00:00Z'), 'Asia/Tokyo')).toBe('Sat Oct 24 00:00')
  })
})

describe('minutesUntil', () => {
  it('rounds up, and never goes below zero', () => {
    const now = new Date('2026-10-23T15:00:00Z')
    expect(minutesUntil(new Date('2026-10-23T15:00:30Z'), now)).toBe(1)
    expect(minutesUntil(new Date('2026-10-23T14:00:00Z'), now)).toBe(0)
  })
})
