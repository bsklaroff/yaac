/**
 * Browser session mint. `yaac open` (and the server's start banner)
 * builds a `?token=<one-time token>` URL; the SPA exchanges that token
 * for an HttpOnly session cookie, then scrubs it out of the address bar.
 * The splash's paste box goes through the same exchange — a durable
 * token works there too.
 */

/** Read the `token` query param, if present. */
export function readExchangeToken(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get('token')
}

/** Remove the `token` param from the URL without a navigation. */
export function stripTokenFromUrl(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete('token')
  window.history.replaceState({}, '', url.pathname + url.search + url.hash)
}

/** Exchange a token for a session cookie. Returns success. */
export async function postWebSession(token: string): Promise<boolean> {
  const res = await fetch('/auth/web-session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  return res.status === 204
}
