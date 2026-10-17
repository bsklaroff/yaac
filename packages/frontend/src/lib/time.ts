import { useQuery } from '@tanstack/react-query'
import { api } from '#lib/api'

/** A relative age ("5m ago") from a server timestamp (UTC
 *  'YYYY-MM-DD HH:MM:SS'); '' if unset or unparseable. */
export function relativeAge(utc: string | undefined): string {
  if (!utc) return ''
  const t = Date.parse(utc.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** This browser's IANA time zone. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** This user's time zone setting, which the settings field edits in place. */
export const timeZoneQuery = { queryKey: ['time-zone'], queryFn: () => api.config['time-zone'].$get() }

/**
 * The zone this user reads times in: the one they pinned in settings, or
 * else this device's, which is what Automatic means on the device in hand
 * (the stored zone is whichever device reported last), and what a pinned
 * zone this browser does not know falls back to. Read once per page;
 * pinning from settings updates it in place.
 */
export function useTimeZone(): string {
  const { data } = useQuery({ ...timeZoneQuery, staleTime: Infinity })
  return data?.pinned === true && data.timeZone !== null && knownZone(data.timeZone) ? data.timeZone : deviceTimeZone()
}

/** Whether this browser can format in `timeZone`. A zone pinned from another
 *  device may be newer than this browser's zone data. */
function knownZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone })
    return true
  } catch {
    return false
  }
}

/** When a chat message was sent, as its pane labels it in `timeZone`: the
 *  time of day, and the date too when it was not today there (with the year
 *  when not this one). */
export function messageTime(at: number, timeZone: string, now = Date.now()): string {
  const day = (ms: number): string =>
    new Date(ms).toLocaleDateString('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const [sent, today] = [day(at), day(now)]
  return new Date(at).toLocaleString(undefined, {
    timeZone,
    ...(sent === today ? {} : { month: 'short', day: 'numeric' }),
    ...(sent.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  })
}
