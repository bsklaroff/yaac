import { describe, it, expect } from 'vitest'
import { MissingToolError, ServerError, defaultStatus, type ErrorCode } from '#errors'

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
        MISSING_TOOL: 400,
        TOO_LARGE: 413,
        INTERNAL: 500,
      }
      for (const [code, status] of Object.entries(expected)) {
        expect(defaultStatus(code as ErrorCode)).toBe(status)
      }
    })
  })

  describe('MissingToolError', () => {
    it('carries whether yaac can fetch the tool, which the code cannot say', () => {
      // Both are MISSING_TOOL and both are 400; what separates them is
      // whether an install-and-retry could ever work, and only a client that
      // can read that avoids offering one that cannot.
      const npm = new MissingToolError('"codex" is not on this host\'s PATH', true)
      const system = new MissingToolError('"socat" is not on this host\'s PATH', false)
      expect(npm.code).toBe('MISSING_TOOL')
      expect(npm.httpStatus).toBe(400)
      expect(npm.installable).toBe(true)
      expect(system.installable).toBe(false)
      // Still a ServerError, so every route and adapter that handles one
      // handles these unchanged.
      expect(system).toBeInstanceOf(ServerError)
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
