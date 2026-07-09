import { describe, it, expect, vi, afterEach } from 'vitest'
import { consumeNdjsonStream } from '@/shared/ndjson'

function ndjsonResponse(events: unknown[], opts: { trailingNewline?: boolean } = {}): Response {
  const body = events.map((e) => JSON.stringify(e)).join('\n')
    + (opts.trailingNewline === false ? '' : '\n')
  return new Response(body)
}

function chunkedResponse(chunks: string[]): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk))
      controller.close()
    },
  }))
}

describe('consumeNdjsonStream', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the terminal result payload', async () => {
    const res = ndjsonResponse([
      { type: 'progress', message: 'step 1' },
      { type: 'result', result: { sessionId: 's-1', jobName: 'j-1' } },
    ])
    const result = await consumeNdjsonStream<{ sessionId: string }>(res, () => {})
    expect(result).toEqual({ sessionId: 's-1', jobName: 'j-1' })
  })

  it('fans each progress message out to onProgress in order', async () => {
    const seen: string[] = []
    const res = ndjsonResponse([
      { type: 'progress', message: 'one' },
      { type: 'progress', message: 'two' },
      { type: 'result', result: {} },
    ])
    await consumeNdjsonStream(res, (m) => seen.push(m))
    expect(seen).toEqual(['one', 'two'])
  })

  it('prints progress with console.log by default (CLI behavior)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await consumeNdjsonStream(ndjsonResponse([
      { type: 'progress', message: 'building...' },
      { type: 'result', result: {} },
    ]))
    expect(logSpy).toHaveBeenCalledWith('building...')
  })

  it('throws the daemon message on an error event', async () => {
    const res = ndjsonResponse([
      { type: 'progress', message: 'step 1' },
      { type: 'error', error: { code: 'VALIDATION', message: 'no github token' } },
    ])
    await expect(consumeNdjsonStream(res, () => {})).rejects.toThrow('no github token')
  })

  it('processes a trailing line that arrives without a final newline', async () => {
    const res = ndjsonResponse([
      { type: 'progress', message: 'almost there' },
      { type: 'result', result: { ok: true } },
    ], { trailingNewline: false })
    const seen: string[] = []
    const result = await consumeNdjsonStream(res, (m) => seen.push(m))
    expect(seen).toEqual(['almost there'])
    expect(result).toEqual({ ok: true })
  })

  it('reassembles events split across chunk boundaries', async () => {
    const line = JSON.stringify({ type: 'result', result: { sessionId: 's-2' } }) + '\n'
    const res = chunkedResponse([
      JSON.stringify({ type: 'progress', message: 'split' }).slice(0, 10),
      JSON.stringify({ type: 'progress', message: 'split' }).slice(10) + '\n' + line.slice(0, 5),
      line.slice(5),
    ])
    const seen: string[] = []
    const result = await consumeNdjsonStream(res, (m) => seen.push(m))
    expect(seen).toEqual(['split'])
    expect(result).toEqual({ sessionId: 's-2' })
  })

  it('throws when the stream ends without a result event', async () => {
    const res = ndjsonResponse([{ type: 'progress', message: 'started' }])
    await expect(consumeNdjsonStream(res, () => {})).rejects.toThrow(/without a result/)
  })

  it('throws on a response with no body', async () => {
    await expect(consumeNdjsonStream(new Response(null), () => {}))
      .rejects.toThrow('empty response body')
  })
})
