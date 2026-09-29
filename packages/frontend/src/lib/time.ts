/** Human relative age ("5m ago") from a UTC 'YYYY-MM-DD HH:MM:SS' time — the
 *  wire shape of every server timestamp (`formatUtcTimestamp`); '' if unset
 *  or unparseable. */
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
