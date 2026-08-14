import { describe, it, expect } from 'vitest'
import {
  MAMA_MAX_BODY_CHARS,
  MAMA_MAX_PENDING_PER_SESSION,
  MAMA_MAX_PENDING_TOTAL,
  MAMA_TTL_MS,
  MamaQueue,
  parseMamaEnvelope,
  validateMamaRequest,
} from 'yaac-proxy-sidecar/mama-queue'

describe('parseMamaEnvelope', () => {
  it('reads the envelope both substrates send', () => {
    expect(parseMamaEnvelope('{"command":"create","args":{"tool":"claude"},"body":"do it"}'))
      .toEqual({ command: 'create', args: { tool: 'claude' }, body: 'do it' })
  })

  it('defaults the halves a command may legitimately omit', () => {
    // `list` carries neither options nor a positional.
    expect(parseMamaEnvelope('{"command":"list"}'))
      .toEqual({ command: 'list', args: {}, body: '' })
  })

  it('keeps a body whole, whatever the user typed into it', () => {
    const body = 'line one\nline two\ttabbed \\ "quoted" — ünïcode'
    const parsed = parseMamaEnvelope(JSON.stringify({ command: 'create', body }))
    expect(parsed?.body).toBe(body)
  })

  it('rejects anything that is not the envelope', () => {
    expect(parseMamaEnvelope('not json')).toBeNull()
    expect(parseMamaEnvelope('[]')).toBeNull()
    expect(parseMamaEnvelope('null')).toBeNull()
    expect(parseMamaEnvelope('"create"')).toBeNull()
    // A request naming no command cannot be answered by anything.
    expect(parseMamaEnvelope('{"args":{}}')).toBeNull()
    expect(parseMamaEnvelope('{"command":3}')).toBeNull()
  })

  it('hands on a prototype-less arg map, so no name can reach an inherited member', () => {
    const parsed = parseMamaEnvelope('{"command":"list","args":{"tool":"claude"}}')
    expect(Object.getPrototypeOf(parsed!.args)).toBeNull()
    // The point of it: an ordinary-looking lookup finds nothing but what the
    // caller actually sent.
    expect((parsed!.args as Record<string, unknown>).constructor).toBeUndefined()
  })

  it('drops arg values that are not strings rather than refusing the request', () => {
    // They cannot be what any command meant, and the server re-validates
    // whatever survives — so the request still reaches the one place that
    // can explain what was wrong with it.
    expect(parseMamaEnvelope('{"command":"create","args":{"tool":["x"],"model":"opus"}}'))
      .toEqual({ command: 'create', args: { model: 'opus' }, body: '' })
  })
})

/** Enqueue capturing the completion, failing the test on an enqueue reject. */
function enqueue(
  q: MamaQueue,
  worktreeId = 's1',
  now = 0,
): { requestId: string; completed: () => { status: number; body: string } | undefined } {
  let completion: { status: number; body: string } | undefined
  const res = q.enqueue(
    { worktreeId, command: 'create', args: {}, body: 'do the thing' },
    (status: number, body: string) => { completion = { status, body } },
    now,
  )
  if (!res.ok) throw new Error(`enqueue rejected: ${res.status} ${res.error}`)
  return { requestId: res.requestId, completed: () => completion }
}

describe('validateMamaRequest', () => {
  it('accepts a bare command with a free-text body', () => {
    expect(validateMamaRequest('create', {}, 'fix the tests')).toEqual({ ok: true })
    expect(validateMamaRequest('list', {}, '')).toEqual({ ok: true })
  })

  it('rejects command names outside the safe charset', () => {
    // A shape, not the allowlist — the server holds that, so an unknown but
    // well-formed command is queued and refused there.
    expect(validateMamaRequest('not-a-command', {}, '')).toEqual({ ok: true })
    expect(validateMamaRequest('', {}, '').ok).toBe(false)
    expect(validateMamaRequest('Create', {}, '').ok).toBe(false)
    expect(validateMamaRequest('../etc', {}, '').ok).toBe(false)
    expect(validateMamaRequest('x'.repeat(33), {}, '').ok).toBe(false)
  })

  it('rejects a body over the character cap', () => {
    expect(validateMamaRequest('create', {}, 'x'.repeat(MAMA_MAX_BODY_CHARS)).ok).toBe(true)
    const over = validateMamaRequest('create', {}, 'x'.repeat(MAMA_MAX_BODY_CHARS + 1))
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.status).toBe(400)
  })

  it('rejects an option the envelope does not carry', () => {
    const bad = validateMamaRequest('create', { nope: 'x' }, 'p')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('--nope')
  })

  it('rejects a prototype member by name instead of throwing on it', () => {
    // A truthiness index would return the inherited member here, pass the
    // "unknown option" guard, and then throw on `.test` — inside a request
    // handler, in a process with no uncaughtException handler. One crafted
    // request from any sandbox would take egress down for the whole node.
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      const result = validateMamaRequest('list', { [name]: 'x' }, '')
      expect(result.ok, name).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(400)
        expect(result.error).toContain(`--${name}`)
      }
    }
  })

  it('shape-checks each option value', () => {
    expect(validateMamaRequest('create', { tool: 'claude' }, 'p')).toEqual({ ok: true })
    expect(validateMamaRequest('create', { tool: 'My Tool' }, 'p').ok).toBe(false)
    expect(validateMamaRequest('create', { tool: '../etc' }, 'p').ok).toBe(false)

    expect(validateMamaRequest('create', { model: 'claude-opus-4-8' }, 'p')).toEqual({ ok: true })
    expect(validateMamaRequest('create', { model: 'anthropic/claude-opus-4-8' }, 'p')).toEqual({ ok: true })
    expect(validateMamaRequest('create', { model: "o'pus" }, 'p').ok).toBe(false)
    expect(validateMamaRequest('create', { model: '-opus' }, 'p').ok).toBe(false)

    // Group names are free-form user text, but bounded and single-line so
    // they cannot smuggle a second line into anything rendering them.
    expect(validateMamaRequest('group-move', { group: 'release train' }, 'p')).toEqual({ ok: true })
    expect(validateMamaRequest('group-move', { group: 'a\nb' }, 'p').ok).toBe(false)
    expect(validateMamaRequest('group-move', { group: 'x'.repeat(201) }, 'p').ok).toBe(false)

    expect(validateMamaRequest('group-move', { session: 'a1b2c3d4' }, 'p')).toEqual({ ok: true })
    expect(validateMamaRequest('group-move', { session: 'a/b' }, 'p').ok).toBe(false)
  })
})

describe('MamaQueue', () => {
  it('round-trips enqueue → drain → complete(ok) as a 200 with the output', () => {
    const q = new MamaQueue()
    const { requestId, completed } = enqueue(q)
    const drained = q.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0].requestId).toBe(requestId)
    expect(drained[0].worktreeId).toBe('s1')
    expect(drained[0].command).toBe('create')
    expect(drained[0].body).toBe('do the thing')
    expect(q.complete({ requestId, ok: true, output: 'new-id' })).toBe(true)
    // The envelope shape, which is also what the containerless route
    // answers — one parser in the script serves both substrates.
    expect(completed()).toEqual({ status: 200, body: '{"output":"new-id"}' })
  })

  it('answers a legacy caller in the bare-text shape its script can read', () => {
    // A worktree created before the envelope has yaac-spawn mounted
    // read-only for its whole life; it prints the body verbatim and would
    // show JSON to the user (docs/legacy-compat-shims.md).
    const q = new MamaQueue()
    let completion: { status: number; body: string } | undefined
    const res = q.enqueue(
      { worktreeId: 's1', command: 'create', args: {}, body: 'p', reply: 'text' },
      (status: number, body: string) => { completion = { status, body } },
    )
    if (!res.ok) throw new Error('enqueue rejected')
    q.drain()
    q.complete({ requestId: res.requestId, ok: true, output: 'new-id' })
    expect(completion).toEqual({ status: 200, body: 'new-id' })

    const fail = q.enqueue(
      { worktreeId: 's1', command: 'create', args: {}, body: 'p', reply: 'text' },
      (status: number, body: string) => { completion = { status, body } },
    )
    if (!fail.ok) throw new Error('enqueue rejected')
    q.drain()
    q.complete({ requestId: fail.requestId, ok: false, error: 'nope' })
    expect(completion).toEqual({ status: 422, body: 'nope' })
  })

  it('carries the command and its options through enqueue → drain', () => {
    const q = new MamaQueue()
    let completion: unknown
    const res = q.enqueue(
      {
        worktreeId: 's1',
        command: 'create',
        args: { tool: 'claude', model: 'claude-opus-4-8', group: 'review' },
        body: 'p',
      },
      () => { completion = true },
      0,
    )
    if (!res.ok) throw new Error('enqueue rejected')
    const drained = q.drain()
    expect(drained[0].args).toEqual({ tool: 'claude', model: 'claude-opus-4-8', group: 'review' })
    expect(completion).toBeUndefined()
  })

  it('completes an ok result with no output as an empty 200', () => {
    // A command whose whole answer is "it worked" still has to release the
    // caller, not hang until the TTL.
    const q = new MamaQueue()
    const { requestId, completed } = enqueue(q)
    q.drain()
    expect(q.complete({ requestId, ok: true })).toBe(true)
    expect(completed()).toEqual({ status: 200, body: '{"output":""}' })
  })

  it('completes a failed result as a 422 with the error text', () => {
    const q = new MamaQueue()
    const { requestId, completed } = enqueue(q)
    q.drain()
    expect(q.complete({ requestId, ok: false, error: 'nope' })).toBe(true)
    expect(completed()).toEqual({ status: 422, body: '{"error":"nope"}' })
  })

  it('drain claims: a second drain returns nothing', () => {
    const q = new MamaQueue()
    enqueue(q)
    expect(q.drain()).toHaveLength(1)
    expect(q.drain()).toHaveLength(0)
  })

  it('complete on an unknown or already-completed request returns false', () => {
    const q = new MamaQueue()
    expect(q.complete({ requestId: 'missing', ok: true, output: 'x' })).toBe(false)
    const { requestId } = enqueue(q)
    q.drain()
    expect(q.complete({ requestId, ok: true, output: 'x' })).toBe(true)
    expect(q.complete({ requestId, ok: true, output: 'x' })).toBe(false)
  })

  it('expires pending AND claimed requests past the TTL with a 504', () => {
    const q = new MamaQueue()
    const pending = enqueue(q, 's1', 0)
    const claimed = enqueue(q, 's2', 0)
    q.drain()
    const fresh = enqueue(q, 's3', MAMA_TTL_MS - 1)

    q.expire(MAMA_TTL_MS)
    expect(pending.completed()?.status).toBe(504)
    expect(claimed.completed()?.status).toBe(504)
    expect(fresh.completed()).toBeUndefined()
    // Expired entries are gone: their results no longer land anywhere.
    expect(q.complete({ requestId: pending.requestId, ok: true, output: 'x' })).toBe(false)
  })

  it('tells a timed-out caller whether its command could have run', () => {
    // The difference decides whether retrying is safe: `create` is not
    // idempotent, so a blind retry after a CLAIMED timeout duplicates a
    // worktree. Pending never reached the server; claimed did.
    const q = new MamaQueue()
    // Handed over, then never answered.
    const claimed = enqueue(q, 's1', 0)
    q.drain()
    // Enqueued after the drain, so it is still waiting to be picked up.
    const pending = enqueue(q, 's2', 0)

    q.expire(MAMA_TTL_MS)
    expect(pending.completed()?.body).toContain('nothing ran')
    expect(claimed.completed()?.body).toContain('MAY have run')
    expect(claimed.completed()?.body).toContain('yaac-mama list')
  })

  it('caps pending requests per worktree at 429, counting claimed ones too', () => {
    const q = new MamaQueue()
    for (let i = 0; i < MAMA_MAX_PENDING_PER_SESSION - 1; i++) enqueue(q, 's1')
    q.drain() // claimed entries still count toward the worktree cap
    enqueue(q, 's1')
    const rejected = q.enqueue(
      { worktreeId: 's1', command: 'create', args: {}, body: 'p' }, () => {},
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.status).toBe(429)
    // Other worktrees are unaffected.
    enqueue(q, 's2')
  })

  it('caps total pending requests across worktrees', () => {
    const q = new MamaQueue()
    for (let i = 0; i < MAMA_MAX_PENDING_TOTAL; i++) {
      // Spread across worktrees so the per-worktree cap never trips first.
      enqueue(q, `s${Math.floor(i / (MAMA_MAX_PENDING_PER_SESSION - 1))}`)
    }
    const rejected = q.enqueue(
      { worktreeId: 'fresh', command: 'create', args: {}, body: 'p' }, () => {},
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.status).toBe(429)
  })

  it('frees capacity when requests complete', () => {
    const q = new MamaQueue()
    const held = Array.from(
      { length: MAMA_MAX_PENDING_PER_SESSION },
      () => enqueue(q, 's1'),
    )
    q.drain()
    expect(q.enqueue(
      { worktreeId: 's1', command: 'create', args: {}, body: 'p' }, () => {},
    ).ok).toBe(false)
    q.complete({ requestId: held[0].requestId, ok: true, output: 'x' })
    expect(q.enqueue(
      { worktreeId: 's1', command: 'create', args: {}, body: 'p' }, () => {},
    ).ok).toBe(true)
  })
})
