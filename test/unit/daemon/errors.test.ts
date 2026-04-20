import { describe, it, expect } from 'vitest'
import {
  DaemonError,
  exitCodeForError,
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

    it('handles non-Error values', () => {
      const result = toErrorBody('string thrown directly')
      expect(result.status).toBe(500)
      expect(result.body.error.message).toBe('string thrown directly')
    })
  })

  describe('exitCodeForError', () => {
    it('VALIDATION → 2', () => {
      expect(exitCodeForError('VALIDATION')).toBe(2)
    })

    it('every other code → 1', () => {
      const codes = ['NOT_FOUND', 'CONFLICT', 'PODMAN_UNAVAILABLE', 'AUTH_REQUIRED', 'INTERNAL'] as const
      for (const code of codes) expect(exitCodeForError(code)).toBe(1)
    })
  })
})
