/**
 * Browser auth bootstrap. The daemon prints a one-time
 * `?bootstrap=<code>` URL; the SPA exchanges that code for an HttpOnly
 * session cookie, then scrubs the code out of the address bar.
 */

/** Read the `bootstrap` query param, if present. */
export function readBootstrapCode(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get('bootstrap')
}

/** Remove the `bootstrap` param from the URL without a navigation. */
export function stripBootstrapFromUrl(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete('bootstrap')
  window.history.replaceState({}, '', url.pathname + url.search + url.hash)
}

/** Exchange a bootstrap code for a session cookie. Returns success. */
export async function postBootstrap(code: string): Promise<boolean> {
  const res = await fetch('/auth/bootstrap', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  return res.status === 204
}
