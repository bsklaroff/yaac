/**
 * Mask a bearer-like secret for display: first 8 chars — enough to
 * correlate with a stored value, useless to authenticate with.
 */
export function maskToken(token: string): string {
  return `${token.slice(0, 8)}…`
}
