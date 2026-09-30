/** Epoch ms → 'YYYY-MM-DD HH:MM:SS' (UTC), the timestamp format on the wire. */
export function formatUtcTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19)
}
