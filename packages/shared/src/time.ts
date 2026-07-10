/**
 * Epoch ms → 'YYYY-MM-DD HH:MM:SS' (UTC) — the wire shape shared by session
 * list / deleted-session `createdAt`, provisioning rows, and image-build
 * entries, so every row sorts and ages the same way in the UI.
 */
export function formatUtcTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19)
}
