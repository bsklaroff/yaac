import { describe, it, expect } from 'vitest'
import { readJsonBody, readStringArray } from '@/lib/daemon/body'
import { DaemonError } from '@/lib/daemon/errors'

function jsonRequest(body: string | null): Request {
  const init: RequestInit = body === null
    ? { method: 'POST' }
    : { method: 'POST', body, headers: { 'content-type': 'application/json' } }
  return new Request('http://127.0.0.1/x', init)
}

describe('readJsonBody', () => {
  it('returns the parsed object', async () => {
    const body = await readJsonBody(jsonRequest('{"a":1}'))
    expect(body).toEqual({ a: 1 })
  })

  it('throws VALIDATION on malformed JSON', async () => {
    await expect(readJsonBody(jsonRequest('{not-json'))).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  it('throws VALIDATION on array body', async () => {
    await expect(readJsonBody(jsonRequest('[]'))).rejects.toBeInstanceOf(DaemonError)
  })

  it('throws VALIDATION on primitive body', async () => {
    await expect(readJsonBody(jsonRequest('"hi"'))).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  it('throws VALIDATION when there is no body at all', async () => {
    await expect(readJsonBody(jsonRequest(null))).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })
})

describe('readStringArray', () => {
  it('returns undefined for undefined input', () => {
    expect(readStringArray(undefined, 'f')).toBeUndefined()
  })

  it('returns the array unchanged', () => {
    expect(readStringArray(['a', 'b'], 'f')).toEqual(['a', 'b'])
  })

  it('throws VALIDATION for non-array values', () => {
    expect(() => readStringArray('nope', 'field')).toThrow(DaemonError)
  })

  it('throws VALIDATION for arrays with non-string entries', () => {
    expect(() => readStringArray(['a', 42], 'field')).toThrow(DaemonError)
  })
})
