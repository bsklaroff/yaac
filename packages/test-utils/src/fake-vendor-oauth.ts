import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A stand-in for the Claude and Codex OAuth servers that the tool sign-in
 * flows talk to (packages/server/src/domain/auth/tool-login.ts), on a
 * loopback port. The server dials it in place of every vendor host when
 * `YAAC_E2E_VENDOR_OAUTH_ORIGIN` names its origin.
 *
 * Its authorize pages approve at once, so fetching an authorize URL plays
 * the user approving in a browser: a loopback redirect is answered with a
 * 302 to it carrying a code, and Claude's manual redirect with the
 * `code#state` text its page shows. A code is `fake-code.<challenge>`, and
 * the token endpoints accept it only with the verifier whose S256 hash is
 * that challenge, so a test passes only if the verifier the server kept
 * pairs with the authorize URL it built. A test reading a URL off a CLI
 * prompt can mint the code itself with `codeFor`.
 */

const MANUAL_REDIRECT = 'https://platform.claude.com/oauth/code/callback'

/** The `BROWSER` stand-in: fetches the URL it is given, following the
 *  fake's redirect to the caller's loopback listener. */
export const FAKE_BROWSER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-browser.cjs')

/** The code the fake's authorize page issues for an authorize URL. */
export function codeFor(authorizeUrl: string): string {
  return `fake-code.${new URL(authorizeUrl).searchParams.get('code_challenge') ?? ''}`
}

function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(claims)}.sig`
}

const challengeOf = (verifier: string): string => crypto.createHash('sha256').update(verifier).digest('base64url')

export interface FakeVendorOAuth {
  origin: string
  /** Every request served, oldest first; `body` is the parsed JSON or form. */
  requests: Array<{ method: string; path: string; body: Record<string, string> }>
  /** Answer the next authorize with the user declining. */
  denyNext(): void
  /** Refuse device codes, as Codex does for an account with them off. */
  refuseDeviceCodes(refuse: boolean): void
  /** How many polls a device code answers "pending" before it is entered. */
  setPendingPolls(n: number): void
  close(): Promise<void>
}

export async function startFakeVendorOAuth(): Promise<FakeVendorOAuth> {
  const requests: FakeVendorOAuth['requests'] = []
  let deny = false
  let refuseDevice = false
  let pendingPolls = 1
  const polls = new Map<string, number>()
  let deviceSeq = 0

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d: Buffer) => { raw += d.toString('utf8') })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      const body: Record<string, string> = req.headers['content-type']?.includes('json')
        ? JSON.parse(raw || '{}') as Record<string, string>
        : Object.fromEntries(new URLSearchParams(raw))
      requests.push({ method: req.method ?? 'GET', path: url.pathname, body })
      const json = (status: number, o: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(o))
      }

      if (req.method === 'GET' && (url.pathname === '/cai/oauth/authorize' || url.pathname === '/oauth/authorize')) {
        const redirect = url.searchParams.get('redirect_uri') ?? ''
        const state = url.searchParams.get('state') ?? ''
        const code = codeFor(url.toString())
        if (redirect === MANUAL_REDIRECT) {
          res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`${code}#${state}`)
          return
        }
        const back = new URL(redirect)
        if (deny) {
          deny = false
          back.searchParams.set('error', 'access_denied')
        } else {
          back.searchParams.set('code', code)
        }
        back.searchParams.set('state', state)
        res.writeHead(302, { Location: back.toString() }).end()
        return
      }

      const grantOk = (): boolean => body.grant_type === 'authorization_code'
        && body.code === `fake-code.${challengeOf(body.code_verifier ?? '')}`
      if (req.method === 'POST' && url.pathname === '/v1/oauth/token') {
        if (!grantOk()) return json(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' })
        return json(200, {
          access_token: 'sk-ant-oat01-fake-web-login',
          refresh_token: 'sk-ant-ort01-fake-refresh',
          expires_in: 28_800,
          scope: 'user:inference user:profile',
        })
      }
      if (req.method === 'GET' && url.pathname === '/api/oauth/profile') {
        return json(200, { organization: { organization_type: 'claude_max' } })
      }
      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        if (!grantOk()) return json(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' })
        return json(200, {
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: 'codex-fake-refresh',
          id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fake' } }),
        })
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts/deviceauth/usercode') {
        if (refuseDevice) return json(404, { error: { message: 'device code login is not enabled' } })
        const id = `device-${++deviceSeq}`
        polls.set(id, 0)
        return json(200, { device_auth_id: id, user_code: 'FAKE-0001', interval: '0' })
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts/deviceauth/token') {
        const seen = polls.get(body.device_auth_id ?? '')
        if (seen === undefined) return json(400, { error: 'unknown device code' })
        polls.set(body.device_auth_id ?? '', seen + 1)
        if (seen < pendingPolls) return json(403, { error: 'authorization_pending' })
        const verifier = `verifier-${body.device_auth_id ?? ''}`
        return json(200, { authorization_code: `fake-code.${challengeOf(verifier)}`, code_challenge: challengeOf(verifier), code_verifier: verifier })
      }
      json(404, { error: 'not found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    denyNext: () => { deny = true },
    refuseDeviceCodes: (refuse) => { refuseDevice = refuse },
    setPendingPolls: (n) => { pendingPolls = n },
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
