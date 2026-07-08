/**
 * Add the one-time bootstrap code to the renderer URL. `base` is the origin
 * the window loads — the daemon itself in production
 * (`http://127.0.0.1:<port>/`) or the Vite dev server (`:1420`) in dev — so
 * this works for both. The SPA reads `?bootstrap`, exchanges it for the
 * HttpOnly session cookie, and strips the param (src/frontend/lib/bootstrap.ts).
 */
export function buildAuthedRendererUrl(base: string, code: string): string {
  const url = new URL(base)
  url.searchParams.set('bootstrap', code)
  return url.toString()
}

/**
 * Fetch a fresh single-use bootstrap code from the daemon using the bearer
 * secret from the lock file. This is exactly what `yaac open` does
 * (src/daemon/cli.ts `openWebapp`), driven by the app instead of a human so
 * the user never sees or pastes a code.
 */
export async function fetchBootstrapCode(
  port: number,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`http://127.0.0.1:${port}/auth/bootstrap-code`, {
    headers: { authorization: `Bearer ${secret}` },
  })
  if (!res.ok) throw new Error(`failed to fetch bootstrap code (HTTP ${res.status})`)
  const body = (await res.json()) as { code?: unknown }
  if (typeof body.code !== 'string' || body.code.length === 0) {
    throw new Error('daemon returned an empty bootstrap code')
  }
  return body.code
}
