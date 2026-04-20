import { describe, it, expect } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import {
  DaemonError,
  rewriteZValidatorBody,
  toErrorBody,
} from '@/lib/daemon/errors'

describe('daemon errors', () => {
  describe('DaemonError', () => {
    it('uses defaultStatus per code', () => {
      expect(new DaemonError('NOT_FOUND', 'x').httpStatus).toBe(404)
      expect(new DaemonError('VALIDATION', 'x').httpStatus).toBe(400)
      expect(new DaemonError('CONFLICT', 'x').httpStatus).toBe(409)
      expect(new DaemonError('PODMAN_UNAVAILABLE', 'x').httpStatus).toBe(503)
      expect(new DaemonError('AUTH_REQUIRED', 'x').httpStatus).toBe(401)
      expect(new DaemonError('INTERNAL', 'x').httpStatus).toBe(500)
    })

    it('honors an explicit httpStatus override', () => {
      expect(new DaemonError('INTERNAL', 'x', 418).httpStatus).toBe(418)
    })

    it('preserves the message', () => {
      expect(new DaemonError('NOT_FOUND', 'project foo').message).toBe('project foo')
    })
  })

  describe('toErrorBody', () => {
    it('passes through DaemonError fields verbatim', () => {
      const result = toErrorBody(new DaemonError('NOT_FOUND', 'project foo'))
      expect(result.status).toBe(404)
      expect(result.body).toEqual({
        error: { code: 'NOT_FOUND', message: 'project foo' },
      })
    })

    it('classifies podman connection failures as PODMAN_UNAVAILABLE', () => {
      const err = new Error('connect ECONNREFUSED /run/user/1000/podman/podman.sock')
      const result = toErrorBody(err)
      expect(result.status).toBe(503)
      expect(result.body.error.code).toBe('PODMAN_UNAVAILABLE')
    })

    it('falls back to INTERNAL for unrecognized errors', () => {
      const result = toErrorBody(new Error('boom'))
      expect(result.status).toBe(500)
      expect(result.body.error.code).toBe('INTERNAL')
      expect(result.body.error.message).toBe('boom')
    })

    it('maps HTTPException 400 to VALIDATION so validator-body errors surface uniformly', () => {
      const result = toErrorBody(new HTTPException(400, { message: 'Malformed JSON in request body' }))
      expect(result.status).toBe(400)
      expect(result.body.error.code).toBe('VALIDATION')
      expect(result.body.error.message).toBe('Malformed JSON in request body')
    })

    it('handles non-Error values', () => {
      const result = toErrorBody('string thrown directly')
      expect(result.status).toBe(500)
      expect(result.body.error.message).toBe('string thrown directly')
    })
  })

  describe('rewriteZValidatorBody', () => {
    it('reshapes zValidator 400 payloads into { error: { code: VALIDATION, message } }', () => {
      const zValidatorPayload = {
        success: false,
        error: {
          name: 'ZodError',
          message: JSON.stringify([
            { path: ['remoteUrl'], message: 'Invalid input: expected string' },
          ]),
        },
      }
      expect(rewriteZValidatorBody(zValidatorPayload)).toEqual({
        error: { code: 'VALIDATION', message: 'remoteUrl: Invalid input: expected string' },
      })
    })

    it('omits the path prefix for top-level issues', () => {
      const payload = {
        success: false,
        error: {
          name: 'ZodError',
          message: JSON.stringify([{ path: [], message: 'bad' }]),
        },
      }
      expect(rewriteZValidatorBody(payload)).toEqual({
        error: { code: 'VALIDATION', message: 'bad' },
      })
    })

    it('falls back to a generic message if the inner payload is not parseable', () => {
      const payload = { success: false, error: { message: 'not-json' } }
      expect(rewriteZValidatorBody(payload)).toEqual({
        error: { code: 'VALIDATION', message: 'not-json' },
      })
    })

    it('returns null for non-matching shapes (our own DaemonError 400s)', () => {
      expect(rewriteZValidatorBody({ error: { code: 'VALIDATION', message: 'x' } })).toBeNull()
      expect(rewriteZValidatorBody({ success: true })).toBeNull()
      expect(rewriteZValidatorBody(null)).toBeNull()
      expect(rewriteZValidatorBody('hi')).toBeNull()
    })
  })

})
