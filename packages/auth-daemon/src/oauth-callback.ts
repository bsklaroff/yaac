import http from 'node:http'

/**
 * Catch a vendor's OAuth redirect back from its authorize page, on the
 * loopback port of this machine that the authorize URL's `redirect_uri`
 * names, so a browser opened here completes a sign-in the server runs
 * (docs/tool-sign-in.md). Used by the desktop auth daemon and by
 * `yaac auth update`. Only the code and state come through here; the
 * server holds the PKCE verifier that makes the code worth anything.
 */

export interface AuthorizeRedirect {
  code: string
  state: string
}

export interface RedirectListener {
  /** The redirect's code, or why the vendor sent none (the user declined,
   *  or nobody came back in time). */
  result: Promise<AuthorizeRedirect>
  close(): void
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1'])
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

function page(text: string): string {
  const escaped = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  return '<!doctype html><meta charset="utf-8"><title>yaac sign-in</title>'
    + `<body style="font-family:system-ui;margin:4em auto;max-width:32em">${escaped}</body>`
}

/**
 * Listen for the redirect `authorizeUrl` sends the browser to. Resolves once
 * listening; rejects when the redirect is not a loopback http address or its
 * port is taken. A redirect to `localhost` is caught on both loopback
 * families, since a browser may resolve it to either.
 */
export async function listenForRedirect(authorizeUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RedirectListener> {
  const authorize = new URL(authorizeUrl)
  const redirectParam = authorize.searchParams.get('redirect_uri') ?? ''
  const state = authorize.searchParams.get('state')
  const redirect = URL.canParse(redirectParam) ? new URL(redirectParam) : null
  if (!redirect || redirect.protocol !== 'http:' || !LOOPBACK_HOSTS.has(redirect.hostname) || !redirect.port || !state) {
    throw new Error(`The sign-in does not redirect to a loopback address (${redirectParam || 'none'}).`)
  }

  let resolve!: (r: AuthorizeRedirect) => void
  let reject!: (err: Error) => void
  const result = new Promise<AuthorizeRedirect>((res, rej) => { resolve = res; reject = rej })
  // A listener closed early never settles; one that fails with no caller
  // waiting is not a crash.
  result.catch(() => {})
  const servers: http.Server[] = []
  const timer = setTimeout(() => {
    reject(new Error('Nobody came back from the sign-in page in time.'))
    close()
  }, timeoutMs)
  timer.unref()
  const close = (): void => {
    clearTimeout(timer)
    for (const s of servers) s.close()
  }

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', redirect.origin)
    if (url.pathname !== redirect.pathname) {
      res.writeHead(404).end()
      return
    }
    const reply = (status: number, text: string): void => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(text))
    }
    // A tab left over from an earlier attempt; this flow is still waiting.
    if (url.searchParams.get('state') !== state) {
      reply(400, 'This sign-in link is out of date. Start the sign-in again from yaac.')
      return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      const why = url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'no code'
      reply(400, `Sign-in did not complete: ${why}`)
      reject(new Error(`The sign-in did not complete: ${why}`))
    } else {
      reply(200, 'Signed in. You can close this tab and return to yaac.')
      resolve({ code, state })
    }
    close()
  }

  const bind = (host: string): Promise<void> => new Promise((res, rej) => {
    const server = http.createServer(handle)
    server.once('error', rej)
    server.listen(Number(redirect.port), host, () => {
      server.off('error', rej)
      servers.push(server)
      res()
    })
  })
  try {
    await bind('127.0.0.1')
  } catch (err) {
    close()
    const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
    throw new Error(busy
      ? `Port ${redirect.port} is in use on this machine, so the sign-in cannot complete here.`
      : `Could not listen on port ${redirect.port}: ${(err as Error).message}`)
  }
  if (redirect.hostname === 'localhost') await bind('::1').catch(() => { /* no IPv6 loopback */ })
  return { result, close }
}
