import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchPlans, fetchPlanDoc, newPlan, continuePlan, promotePlan } from '@/frontend/lib/plansApi'
import { streamSessionOp } from '@/frontend/lib/createSession'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function jsonFetch(body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

/** NDJSON streaming response made of the given event objects. */
function ndjsonFetch(events: unknown[]): ReturnType<typeof vi.fn> {
  const payload = new TextEncoder().encode(events.map((e) => JSON.stringify(e) + '\n').join(''))
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(payload)
        controller.close()
      },
    }),
  })
}

describe('fetchPlans', () => {
  it('hits the project-scoped plans endpoint', async () => {
    const data = { available: true, docs: [] }
    const fetchMock = jsonFetch(data)
    globalThis.fetch = fetchMock as unknown as typeof fetch
    expect(await fetchPlans('my proj')).toEqual(data)
    expect(fetchMock.mock.calls[0][0] as string).toBe('/project/my%20proj/plans')
  })
})

describe('fetchPlanDoc', () => {
  it('passes the doc path as a query param', async () => {
    const fetchMock = jsonFetch({ content: '# x', draftSessionId: null })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await fetchPlanDoc('p', 'a b.md')
    expect(fetchMock.mock.calls[0][0] as string).toBe('/project/p/plans/doc?path=a%20b.md')
  })
})

describe('streamSessionOp', () => {
  it('forwards progress events and resolves with the result', async () => {
    const fetchMock = ndjsonFetch([
      { type: 'progress', message: 'one' },
      { type: 'progress', message: 'two' },
      { type: 'result', result: { sessionId: 's1' } },
    ])
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const seen: string[] = []
    const result = await streamSessionOp('/x', { a: 1 }, (m) => seen.push(m))
    expect(seen).toEqual(['one', 'two'])
    expect(result).toEqual({ sessionId: 's1' })
    expect(fetchMock.mock.calls[0][0] as string).toBe('/x')
  })

  it('throws the daemon error message from error events', async () => {
    globalThis.fetch = ndjsonFetch([
      { type: 'error', error: { message: 'no wiki' } },
    ]) as unknown as typeof fetch
    await expect(streamSessionOp('/x', {}, () => {})).rejects.toThrow('no wiki')
  })
})

describe('newPlan / promotePlan', () => {
  it('post to the plans endpoints and unwrap the result', async () => {
    const result = { sessionId: 's1', containerName: 'c', tool: 'claude', doc: 'x.md' }
    const fetchMock = ndjsonFetch([{ type: 'result', result }])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    expect(await newPlan('p', 'topic', () => {})).toEqual(result)
    expect(fetchMock.mock.calls[0][0] as string).toBe('/project/p/plans/new')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({ topic: 'topic' })

    globalThis.fetch = ndjsonFetch([{ type: 'result', result }]) as unknown as typeof fetch
    expect(await promotePlan('p', 'x.md', () => {})).toEqual(result)

    const continueMock = ndjsonFetch([{ type: 'result', result }])
    globalThis.fetch = continueMock as unknown as typeof fetch
    expect(await continuePlan('p', 'x.md', () => {})).toEqual(result)
    expect(continueMock.mock.calls[0][0] as string).toBe('/project/p/plans/continue')
  })
})
