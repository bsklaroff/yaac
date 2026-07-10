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
        if (name in obj) {
          obj[name] = value
        }
      }
      return Buffer.from(JSON.stringify(obj), 'utf8')
    } catch {
      // Not valid JSON — fall through to form-encoded
    }
  }

  const params = new URLSearchParams(bodyStr)
  for (const { name, value } of injections) {
    if (params.has(name)) {
      params.set(name, value)
    }
  }
  return Buffer.from(params.toString(), 'utf8')
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
})
