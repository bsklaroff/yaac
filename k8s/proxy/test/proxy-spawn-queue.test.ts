import { describe, it, expect } from 'vitest'
import {
  SPAWN_MAX_PENDING_PER_SESSION,
  SPAWN_MAX_PENDING_TOTAL,
  SPAWN_MAX_PROMPT_CHARS,
  SPAWN_TTL_MS,
  SpawnQueue,
  validateSpawnRequest,
} from 'yaac-proxy-sidecar/spawn-queue'

/** Enqueue capturing the completion, failing the test on an enqueue reject. */
function enqueue(
  q: SpawnQueue,
  sessionId = 's1',
  now = 0,
): { requestId: string; completed: () => { status: number; body: string } | undefined } {
  let completion: { status: number; body: string } | undefined
  const res = q.enqueue(
    { sessionId, prompt: 'do the thing' },
    (status, body) => { completion = { status, body } },
    now,
  )
  if (!res.ok) throw new Error(`enqueue rejected: ${res.status} ${res.error}`)
  return { requestId: res.requestId, completed: () => completion }
}

describe('validateSpawnRequest', () => {
  it('accepts a plain prompt with no tool', () => {
    expect(validateSpawnRequest('fix the tests', undefined)).toEqual({ ok: true })
  })

  it('rejects empty and whitespace-only prompts', () => {
    expect(validateSpawnRequest('', undefined).ok).toBe(false)
    expect(validateSpawnRequest('  \n\t ', undefined).ok).toBe(false)
  })

  it('rejects prompts over the character cap', () => {
    expect(validateSpawnRequest('x'.repeat(SPAWN_MAX_PROMPT_CHARS), undefined).ok).toBe(true)
    const over = validateSpawnRequest('x'.repeat(SPAWN_MAX_PROMPT_CHARS + 1), undefined)
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.status).toBe(400)
  })

  it('rejects tool values outside the safe charset', () => {
    expect(validateSpawnRequest('p', 'claude')).toEqual({ ok: true })
    expect(validateSpawnRequest('p', 'My Tool').ok).toBe(false)
    expect(validateSpawnRequest('p', '../etc').ok).toBe(false)
    expect(validateSpawnRequest('p', 'x'.repeat(33)).ok).toBe(false)
  })

  it('accepts model ids and rejects values outside the safe charset', () => {
    expect(validateSpawnRequest('p', 'claude', 'claude-opus-4-8')).toEqual({ ok: true })
    expect(validateSpawnRequest('p', undefined, 'opus')).toEqual({ ok: true })
    expect(validateSpawnRequest('p', 'claude', "o'pus").ok).toBe(false)
    expect(validateSpawnRequest('p', 'claude', 'a model').ok).toBe(false)
    expect(validateSpawnRequest('p', 'claude', '-opus').ok).toBe(false)
    expect(validateSpawnRequest('p', 'claude', 'x'.repeat(101)).ok).toBe(false)
  })
})

describe('SpawnQueue', () => {
  it('round-trips enqueue → drain → complete(ok) as a 200 with the session id', () => {
    const q = new SpawnQueue()
    const { requestId, completed } = enqueue(q)
    const drained = q.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0].requestId).toBe(requestId)
    expect(drained[0].sessionId).toBe('s1')
    expect(drained[0].prompt).toBe('do the thing')
    expect(q.complete({ requestId, ok: true, sessionId: 'new-id' })).toBe(true)
    expect(completed()).toEqual({ status: 200, body: 'new-id' })
  })

  it('carries tool and model through enqueue → drain', () => {
    const q = new SpawnQueue()
    let completion: unknown
    const res = q.enqueue(
      { sessionId: 's1', prompt: 'p', tool: 'claude', model: 'claude-opus-4-8' },
      () => { completion = true },
      0,
    )
    if (!res.ok) throw new Error('enqueue rejected')
    const drained = q.drain()
    expect(drained[0].tool).toBe('claude')
    expect(drained[0].model).toBe('claude-opus-4-8')
    expect(completion).toBeUndefined()
  })

  it('completes a failed result as a 422 with the error text', () => {
    const q = new SpawnQueue()
    const { requestId, completed } = enqueue(q)
    q.drain()
    expect(q.complete({ requestId, ok: false, error: 'nope' })).toBe(true)
    expect(completed()).toEqual({ status: 422, body: 'nope' })
  })

  it('drain claims: a second drain returns nothing', () => {
    const q = new SpawnQueue()
    enqueue(q)
    expect(q.drain()).toHaveLength(1)
    expect(q.drain()).toHaveLength(0)
  })

  it('complete on an unknown or already-completed request returns false', () => {
    const q = new SpawnQueue()
    expect(q.complete({ requestId: 'missing', ok: true, sessionId: 'x' })).toBe(false)
    const { requestId } = enqueue(q)
    q.drain()
    expect(q.complete({ requestId, ok: true, sessionId: 'x' })).toBe(true)
    expect(q.complete({ requestId, ok: true, sessionId: 'x' })).toBe(false)
  })

  it('expires pending AND claimed requests past the TTL with a 504', () => {
    const q = new SpawnQueue()
    const pending = enqueue(q, 's1', 0)
    const claimed = enqueue(q, 's2', 0)
    q.drain()
    const fresh = enqueue(q, 's3', SPAWN_TTL_MS - 1)

    q.expire(SPAWN_TTL_MS)
    expect(pending.completed()?.status).toBe(504)
    expect(claimed.completed()?.status).toBe(504)
    expect(fresh.completed()).toBeUndefined()
    // Expired entries are gone: their results no longer land anywhere.
    expect(q.complete({ requestId: pending.requestId, ok: true, sessionId: 'x' })).toBe(false)
  })

  it('caps pending requests per session at 429, counting claimed ones too', () => {
    const q = new SpawnQueue()
    for (let i = 0; i < SPAWN_MAX_PENDING_PER_SESSION - 1; i++) enqueue(q, 's1')
    q.drain() // claimed entries still count toward the session cap
    enqueue(q, 's1')
    const rejected = q.enqueue({ sessionId: 's1', prompt: 'p' }, () => {})
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.status).toBe(429)
    // Other sessions are unaffected.
    enqueue(q, 's2')
  })

  it('caps total pending requests across sessions', () => {
    const q = new SpawnQueue()
    for (let i = 0; i < SPAWN_MAX_PENDING_TOTAL; i++) {
      // Spread across sessions so the per-session cap never trips first.
      enqueue(q, `s${Math.floor(i / (SPAWN_MAX_PENDING_PER_SESSION - 1))}`)
    }
    const rejected = q.enqueue({ sessionId: 'fresh', prompt: 'p' }, () => {})
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.status).toBe(429)
  })

  it('frees capacity when requests complete', () => {
    const q = new SpawnQueue()
    const held = Array.from(
      { length: SPAWN_MAX_PENDING_PER_SESSION },
      () => enqueue(q, 's1'),
    )
    q.drain()
    expect(q.enqueue({ sessionId: 's1', prompt: 'p' }, () => {}).ok).toBe(false)
    q.complete({ requestId: held[0].requestId, ok: true, sessionId: 'x' })
    expect(q.enqueue({ sessionId: 's1', prompt: 'p' }, () => {}).ok).toBe(true)
  })
})
