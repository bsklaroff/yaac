import { describe, it, expect } from 'vitest'
import { ServerError, defaultStatus, type ErrorCode } from '#errors'

describe('shared errors', () => {
  describe('defaultStatus', () => {
    it('maps every code to its HTTP status', () => {
      const expected: Record<ErrorCode, number> = {
        NOT_FOUND: 404,
        VALIDATION: 400,
        CONFLICT: 409,
        RUNTIME_UNAVAILABLE: 503,
        AUTH_REQUIRED: 401,
        AUTH_AGENT_DISCONNECTED: 503,
        BAD_BEARER: 401,
        UNAUTHENTICATED: 401,
        BAD_HOST: 403,
        NOT_SUPPORTED: 501,
        INTERNAL: 500,
      }
      for (const [code, status] of Object.entries(expected)) {
        expect(defaultStatus(code as ErrorCode)).toBe(status)
      }
    })
  })

  describe('ServerError', () => {
    it('uses defaultStatus per code', () => {
      expect(new ServerError('NOT_FOUND', 'x').httpStatus).toBe(404)
      expect(new ServerError('VALIDATION', 'x').httpStatus).toBe(400)
      expect(new ServerError('CONFLICT', 'x').httpStatus).toBe(409)
      expect(new ServerError('RUNTIME_UNAVAILABLE', 'x').httpStatus).toBe(503)
      expect(new ServerError('AUTH_REQUIRED', 'x').httpStatus).toBe(401)
      expect(new ServerError('INTERNAL', 'x').httpStatus).toBe(500)
    })

    it('preserves the message', () => {
      expect(new ServerError('NOT_FOUND', 'project foo').message).toBe('project foo')
    })
  })
})
