import { describe, it, expect } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import { ServerError } from '@yaac/shared/errors'
import { toErrorBody } from '#errors'

describe('server errors', () => {
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

  describe('toErrorBody', () => {
    it('passes through ServerError fields verbatim', () => {
      const result = toErrorBody(new ServerError('NOT_FOUND', 'project foo'))
      expect(result.status).toBe(404)
      expect(result.body).toEqual({
        error: { code: 'NOT_FOUND', message: 'project foo' },
      })
    })

    it('classifies podman (build engine) connection failures as RUNTIME_UNAVAILABLE', () => {
      const err = new Error('connect ECONNREFUSED /run/user/1000/podman/podman.sock')
      const result = toErrorBody(err)
      expect(result.status).toBe(503)
      expect(result.body.error.code).toBe('RUNTIME_UNAVAILABLE')
    })

    it('classifies kubectl / cluster connection failures as RUNTIME_UNAVAILABLE', () => {
      for (const message of [
        'Command failed: kubectl get pods -n yaac',
        'Kubernetes cluster is not reachable.',
      ]) {
        const result = toErrorBody(new Error(message))
        expect(result.status).toBe(503)
        expect(result.body.error.code).toBe('RUNTIME_UNAVAILABLE')
      }
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

})
