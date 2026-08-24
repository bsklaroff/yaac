import { describe, it, expect } from 'vitest'

/**
 * Tests for the proxy's body injection logic.
 * These functions mirror the implementation in podman/proxy-sidecar/proxy.ts.
 */

function applyBodyInjections(
  bodyBuffer: Buffer,
  contentType: string | undefined,
  injections: Array<{ name: string; value: string }>,
): Buffer {
  const bodyStr = bodyBuffer.toString('utf8')
  const isJson = contentType && contentType.includes('application/json')

  if (isJson) {
    try {
      const obj = JSON.parse(bodyStr) as Record<string, unknown>
      for (const { name, value } of injections) {
        if (name in obj) obj[name] = value
      }
      return Buffer.from(JSON.stringify(obj), 'utf8')
    } catch {
      // Not valid JSON — fall through to form-encoded
    }
  }

  const params = new URLSearchParams(bodyStr)
  for (const { name, value } of injections) {
    if (params.has(name)) params.set(name, value)
  }
  return Buffer.from(params.toString(), 'utf8')
}

/** The sentinel the OAuth refresh swap is gated on. */
const PLACEHOLDER_REFRESH_TOKEN = 'yaac-ph-refresh'

/**
 * Whether a request body presents the placeholder refresh token — the one
 * fact gating both halves of an OAuth refresh in the proxy. Mirrored here as
 * the rest of this file is; `proxy-codex-oauth.test.ts` covers the predicate
 * itself in detail, so the cases below use it only to compose the decision.
 */
function bodyHasPlaceholderRefreshToken(body: Buffer, contentType: string | undefined): boolean {
  if (body.length === 0) return false
  const bodyStr = body.toString('utf8')
  const isJson = contentType && contentType.includes('application/json')
  if (isJson) {
    try {
      const parsed: unknown = JSON.parse(bodyStr)
      if (parsed && typeof parsed === 'object') {
        return (parsed as Record<string, unknown>).refresh_token === PLACEHOLDER_REFRESH_TOKEN
      }
    } catch {
      // fall through to form-encoded
    }
  }
  try {
    return new URLSearchParams(bodyStr).get('refresh_token') === PLACEHOLDER_REFRESH_TOKEN
  } catch {
    return false
  }
}

describe('applyBodyInjections', () => {
  describe('form-encoded bodies', () => {
    it('replaces existing params in form-encoded body', () => {
      const body = Buffer.from('grant_type=client_credentials&client_id=placeholder&client_secret=placeholder&scope=repo')
      const result = applyBodyInjections(body, 'application/x-www-form-urlencoded', [
        { name: 'client_id', value: 'real-id' },
        { name: 'client_secret', value: 'real-secret' },
      ])
      const params = new URLSearchParams(result.toString())
      expect(params.get('client_id')).toBe('real-id')
      expect(params.get('client_secret')).toBe('real-secret')
      expect(params.get('grant_type')).toBe('client_credentials')
      expect(params.get('scope')).toBe('repo')
    })

    it('does not add params that are not already present', () => {
      const body = Buffer.from('grant_type=client_credentials&client_id=placeholder')
      const result = applyBodyInjections(body, 'application/x-www-form-urlencoded', [
        { name: 'client_id', value: 'real-id' },
        { name: 'client_secret', value: 'real-secret' },
      ])
      const params = new URLSearchParams(result.toString())
      expect(params.get('client_id')).toBe('real-id')
      expect(params.has('client_secret')).toBe(false)
    })

    it('treats missing content-type as form-encoded', () => {
      const body = Buffer.from('client_id=placeholder')
      const result = applyBodyInjections(body, undefined, [
        { name: 'client_id', value: 'real-id' },
      ])
      const params = new URLSearchParams(result.toString())
      expect(params.get('client_id')).toBe('real-id')
    })
  })

  describe('JSON bodies', () => {
    it('replaces existing fields in JSON body', () => {
      const body = Buffer.from(JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'placeholder',
        client_secret: 'placeholder',
        scope: 'repo',
      }))
      const result = applyBodyInjections(body, 'application/json', [
        { name: 'client_id', value: 'real-id' },
        { name: 'client_secret', value: 'real-secret' },
      ])
      const obj = JSON.parse(result.toString()) as Record<string, unknown>
      expect(obj.client_id).toBe('real-id')
      expect(obj.client_secret).toBe('real-secret')
      expect(obj.grant_type).toBe('client_credentials')
      expect(obj.scope).toBe('repo')
    })

    it('does not add fields that are not already present', () => {
      const body = Buffer.from(JSON.stringify({ client_id: 'placeholder' }))
      const result = applyBodyInjections(body, 'application/json', [
        { name: 'client_id', value: 'real-id' },
        { name: 'client_secret', value: 'real-secret' },
      ])
      const obj = JSON.parse(result.toString()) as Record<string, unknown>
      expect(obj.client_id).toBe('real-id')
      expect(obj).not.toHaveProperty('client_secret')
    })

    it('handles application/json with charset', () => {
      const body = Buffer.from(JSON.stringify({ client_id: 'placeholder' }))
      const result = applyBodyInjections(body, 'application/json; charset=utf-8', [
        { name: 'client_id', value: 'real-id' },
      ])
      const obj = JSON.parse(result.toString()) as Record<string, unknown>
      expect(obj.client_id).toBe('real-id')
    })
  })

  describe('the OAuth refresh gate', () => {
    // The gate no longer lives in this function — it is the call site's
    // decision, mirrored here: swaps are assembled only for a request that
    // presented the placeholder we issued.
    //
    // Why it has to exist: a refresh grant SPENDS the token it presents and
    // issues a replacement. Injecting the real token into a request that
    // never held our placeholder rotates the account on behalf of whatever
    // process sent it — any pod can reach this endpoint — while the response
    // capture, gated on the same fact, declines to record the replacement.
    // The host store is then left holding a token the rotation already
    // spent, and every workspace using it is signed out.
    const REAL_REFRESH_TOKEN = 'real-refresh-token'
    const swapsFor = (body: Buffer, contentType: string): Array<{ name: string; value: string }> =>
      bodyHasPlaceholderRefreshToken(body, contentType)
        ? [{ name: 'refresh_token', value: REAL_REFRESH_TOKEN }]
        : []

    const grant = (token: string): Buffer =>
      Buffer.from(JSON.stringify({ grant_type: 'refresh_token', refresh_token: token }))
    const refreshTokenIn = (b: Buffer): unknown =>
      (JSON.parse(b.toString()) as Record<string, unknown>).refresh_token

    it('swaps the real token in for a workspace refresh carrying the placeholder', () => {
      const body = grant(PLACEHOLDER_REFRESH_TOKEN)
      const out = applyBodyInjections(body, 'application/json', swapsFor(body, 'application/json'))
      expect(refreshTokenIn(out)).toBe(REAL_REFRESH_TOKEN)
    })

    it('lets every other refresh travel as itself', () => {
      // A fabricated token from a test fixture, another tool's credential, a
      // stray script — all pass through and fail upstream on their own.
      for (const token of ['someone-elses-token', 'sk-ant-ort01-fabricated', '']) {
        const body = grant(token)
        const out = applyBodyInjections(body, 'application/json', swapsFor(body, 'application/json'))
        expect(refreshTokenIn(out)).toBe(token)
      }
    })

    it('applies the same gate to a form-encoded grant', () => {
      const ct = 'application/x-www-form-urlencoded'
      const mine = Buffer.from(`grant_type=refresh_token&refresh_token=${PLACEHOLDER_REFRESH_TOKEN}`)
      expect(new URLSearchParams(applyBodyInjections(mine, ct, swapsFor(mine, ct)).toString())
        .get('refresh_token')).toBe(REAL_REFRESH_TOKEN)

      const theirs = Buffer.from('grant_type=refresh_token&refresh_token=someone-elses-token')
      expect(new URLSearchParams(applyBodyInjections(theirs, ct, swapsFor(theirs, ct)).toString())
        .get('refresh_token')).toBe('someone-elses-token')
    })

    it('leaves registered secretRef swaps unconditional', () => {
      // Only the OAuth refresh is gated. A configured proxy-secret swap still
      // replaces whatever placeholder its rule names.
      const result = applyBodyInjections(
        Buffer.from(JSON.stringify({ client_secret: 'anything-at-all' })),
        'application/json',
        [{ name: 'client_secret', value: 'real-secret' }],
      )
      expect((JSON.parse(result.toString()) as Record<string, unknown>).client_secret)
        .toBe('real-secret')
    })
  })
})
