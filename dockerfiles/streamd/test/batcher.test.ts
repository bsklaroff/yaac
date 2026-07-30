// Unit tests for the pty output micro-batcher: leading-edge-immediate
// flush, in-window coalescing, the size cap, and the drain/dispose
// lifecycle around stream teardown.
import { describe, it, expect } from 'vitest'
// Untyped plain-JS module (it runs under bare node in the pod).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { createOutputBatcher } from '../batcher.js'

interface Batcher {
  push(buf: Buffer): void
  flush(): void
  dispose(): void
}

/** Generous window so real-timer tests stay deterministic under load. */
const BATCH_MS = 60

function collect(): { writes: Buffer[]; write: (b: Buffer) => void } {
  const writes: Buffer[] = []
  return { writes, write: (b) => writes.push(b) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('createOutputBatcher', () => {
  it('flushes the first push after quiet immediately (no echo latency)', () => {
    const { writes, write } = collect()
    const b = createOutputBatcher(write, { batchMs: BATCH_MS }) as Batcher
    b.push(Buffer.from('x'))
    expect(writes).toHaveLength(1)
    expect(writes[0].toString('utf8')).toBe('x')
  })

  it('coalesces pushes inside the window into one later write', async () => {
    const { writes, write } = collect()
    const b = createOutputBatcher(write, { batchMs: BATCH_MS }) as Batcher
    b.push(Buffer.from('a')) // leading edge: immediate
    b.push(Buffer.from('b'))
    b.push(Buffer.from('c'))
    expect(writes).toHaveLength(1)
    await sleep(BATCH_MS * 2)
    expect(writes).toHaveLength(2)
    expect(writes[1].toString('utf8')).toBe('bc')
  })

  it('flushes at once when the pending size reaches maxBytes', () => {
    const { writes, write } = collect()
    const b = createOutputBatcher(write, { batchMs: BATCH_MS, maxBytes: 8 }) as Batcher
    b.push(Buffer.from('lead')) // opens the window
    b.push(Buffer.from('12345678')) // ≥ maxBytes → immediate, no timer wait
    expect(writes).toHaveLength(2)
    expect(writes[1].toString('utf8')).toBe('12345678')
  })

  it('flush() drains pending output synchronously (exit-frame barrier)', () => {
    const { writes, write } = collect()
    const b = createOutputBatcher(write, { batchMs: BATCH_MS }) as Batcher
    b.push(Buffer.from('a'))
    b.push(Buffer.from('tail'))
    expect(writes).toHaveLength(1)
    b.flush()
    expect(writes).toHaveLength(2)
    expect(writes[1].toString('utf8')).toBe('tail')
    b.flush() // idempotent with nothing pending
    expect(writes).toHaveLength(2)
  })

  it('dispose() drops pending output and never writes again', async () => {
    const { writes, write } = collect()
    const b = createOutputBatcher(write, { batchMs: BATCH_MS }) as Batcher
    b.push(Buffer.from('a'))
    b.push(Buffer.from('dropped'))
    b.dispose()
    b.push(Buffer.from('ignored'))
    await sleep(BATCH_MS * 2)
    expect(writes).toHaveLength(1)
  })

  it('a push after a quiet window is immediate again', async () => {
    const { writes, write } = collect()
    const b = createOutputBatcher(write, { batchMs: BATCH_MS }) as Batcher
    b.push(Buffer.from('first'))
    await sleep(BATCH_MS * 2)
    b.push(Buffer.from('second'))
    expect(writes).toHaveLength(2)
    expect(writes[1].toString('utf8')).toBe('second')
  })
})
