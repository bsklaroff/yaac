/**
 * The reconciler both resident forwarders share — `createForwardSet`.
 *
 * `startForward` is stubbed here (it has its own suite, over real
 * sockets): what this file is about is which forwards are started, which
 * are left alone, and which are let go when the desired set moves.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const startForward = vi.hoisted(() => vi.fn())
vi.mock('#port-tunnel', () => ({ startForward }))

import { createForwardSet } from '#port-tunnel-set'
import type { ForwardSpec } from '#port-tunnel'

const TARGET = { baseUrl: 'http://127.0.0.1:8787', secret: 's' }

function spec(session: string, containerPort: number, hostPort = containerPort): ForwardSpec {
  return { session, containerPort, hostPort }
}

/** Every handle handed out, so a test can see which were closed. */
let handles: Array<{ spec: ForwardSpec; close: ReturnType<typeof vi.fn> }>

beforeEach(() => {
  handles = []
  startForward.mockReset()
  startForward.mockImplementation((_t: unknown, s: ForwardSpec) => {
    const close = vi.fn()
    handles.push({ spec: s, close })
    return Promise.resolve({ hostPort: s.hostPort, close })
  })
})

describe('createForwardSet', () => {
  it('starts what is new and leaves an unchanged forward alone', async () => {
    // The substance of reconciling by identity: a session that gains a
    // port must not cost the others their open connections.
    const set = createForwardSet(TARGET)
    await set.reconcile([spec('a', 3000)])
    await set.reconcile([spec('a', 3000), spec('b', 5173)])

    expect(startForward).toHaveBeenCalledTimes(2)
    expect(handles[0].close).not.toHaveBeenCalled()
    expect(set.live()).toEqual([spec('a', 3000), spec('b', 5173)])
  })

  it('drops a forward the server no longer offers', async () => {
    const set = createForwardSet(TARGET)
    await set.reconcile([spec('a', 3000), spec('b', 5173)])
    await set.reconcile([spec('a', 3000)])

    expect(handles[1].close).toHaveBeenCalledTimes(1)
    expect(set.live()).toEqual([spec('a', 3000)])
  })

  it('treats a moved host port as a different forward', async () => {
    // The listener is what changed, so the old one has to go — leaving it
    // bound would serve the previous mapping forever.
    const set = createForwardSet(TARGET)
    await set.reconcile([spec('a', 3000, 3000)])
    await set.reconcile([spec('a', 3000, 3001)])

    expect(handles[0].close).toHaveBeenCalledTimes(1)
    expect(set.live()).toEqual([spec('a', 3000, 3001)])
  })

  it('reports a forward that cannot bind and brings the rest up anyway', async () => {
    // Something else on this machine holds the port — unknowable to the
    // server, and no reason for the other forwards to fail.
    startForward.mockImplementationOnce(() => Promise.reject(new Error('EADDRINUSE')))
    const failures: Array<[number, string]> = []
    const set = createForwardSet(TARGET, {
      onBindError: (s, m) => failures.push([s.hostPort, m]),
    })

    await set.reconcile([spec('a', 3000), spec('b', 5173)])

    expect(failures).toEqual([[3000, 'EADDRINUSE']])
    expect(set.live()).toEqual([spec('b', 5173)])
  })

  it('retries a failed bind on the next reconcile', async () => {
    startForward.mockImplementationOnce(() => Promise.reject(new Error('EADDRINUSE')))
    const set = createForwardSet(TARGET)

    await set.reconcile([spec('a', 3000)])
    expect(set.live()).toEqual([])
    await set.reconcile([spec('a', 3000)])

    expect(set.live()).toEqual([spec('a', 3000)])
  })

  it('announces each forward coming up and going away', async () => {
    const events: string[] = []
    const set = createForwardSet(TARGET, {
      onChange: (s, state) => events.push(`${state} ${String(s.hostPort)}`),
    })

    await set.reconcile([spec('a', 3000)])
    await set.reconcile([])

    expect(events).toEqual(['up 3000', 'down 3000'])
  })

  it('closes everything, and stays closed', async () => {
    // The tray quitting must not leave a listener behind, and a reconcile
    // racing the quit must not put one back.
    const set = createForwardSet(TARGET)
    await set.reconcile([spec('a', 3000)])

    set.close()
    await set.reconcile([spec('a', 3000), spec('b', 5173)])

    expect(handles[0].close).toHaveBeenCalledTimes(1)
    expect(set.live()).toEqual([])
    expect(startForward).toHaveBeenCalledTimes(1)
  })
})
