import { spawn } from 'node:child_process'
import { resolveServerTarget, type ServerTarget } from '@yaac/shared/server-api'
import { ensureAuthDaemonSpawned } from '@yaac/shared/auth-daemon'
import { startServer } from '#main/lifecycle'

export function buildWebappUrl(baseUrl: string, token: string | null): string {
  return token === null ? `${baseUrl}/` : `${baseUrl}/?token=${token}`
}

/**
 * Ask the server (via public `/health`) whether it needs a credential. A
 * loopback-only or nested server doesn't, so `yaac open` can skip the
 * one-time token entirely. Defaults to `true` (mint the token) on any hiccup
 * or an older server that doesn't report the field — never hand out a
 * tokenless URL for a server that might reject it.
 */
async function serverNeedsCredential(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/health`, {})
    if (!res.ok) return true
    const body = await res.json() as { authRequired?: unknown }
    return body.authRequired !== false
  } catch {
    return true
  }
}

export interface OpenWebappOptions {
  /** Print the URL instead of launching a browser. */
  noBrowser?: boolean
  // Injected for tests; default to the real implementations.
  ensureServer?: () => Promise<void>
  resolveTarget?: () => Promise<ServerTarget>
  fetchImpl?: typeof fetch
  launch?: (url: string) => void
}

/**
 * Entry point for `yaac open`. Resolves the server target, mints a
 * one-time exchange token over the authenticated /tokens API (the same
 * endpoint every client registers through), and launches the browser
 * straight into the authenticated webapp — no log-scraping or
 * token-pasting. The URL is always printed (stdout) so it's scriptable.
 *
 * The local server is auto-started only when resolution fails on the
 * local-lock path; a configured remote (or the test hatch) resolves
 * up front and must never trigger a local server spawn.
 */
export async function openWebapp(opts: OpenWebappOptions = {}): Promise<void> {
  const ensureServer = opts.ensureServer ?? startServer
  const resolveTarget = opts.resolveTarget ?? resolveServerTarget
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  const launch = opts.launch ?? openBrowser

  let target: ServerTarget
  try {
    target = await resolveTarget()
  } catch {
    // Only the local-lock branch throws (server down / build mismatch).
    // Start it and re-resolve; a second failure surfaces to the user.
    await ensureServer()
    target = await resolveTarget()
  }

  // Best-effort: the webapp's sign-in cards need the login broker on
  // this machine. Never block or fail `yaac open` on it.
  try {
    await ensureAuthDaemonSpawned()
  } catch {
    // resolution/spawn hiccup — sign-in cards will say what to run
  }

  // Skip the token when the server doesn't require one (loopback-only or
  // nested) — the webapp authenticates with no credential there.
  let token: string | null = null
  if (await serverNeedsCredential(target.baseUrl, fetchImpl)) {
    const res = await fetchImpl(`${target.baseUrl}/tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'one-time' }),
    })
    if (!res.ok) throw new Error(`failed to mint a one-time token (HTTP ${res.status})`)
    token = (await res.json() as { token: string }).token
  }

  const url = buildWebappUrl(target.baseUrl, token)
  console.log(url)
  if (opts.noBrowser) return
  launch(url)
}

function openBrowser(url: string): void {
  const { cmd, args } = process.platform === 'darwin'
    ? { cmd: 'open', args: [url] }
    : process.platform === 'win32'
      ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
      : { cmd: 'xdg-open', args: [url] }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      console.error(`[yaac] couldn't launch a browser — open this URL manually:\n  ${url}`)
    })
    child.unref()
  } catch {
    console.error(`[yaac] couldn't launch a browser — open this URL manually:\n  ${url}`)
  }
}
