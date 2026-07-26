import { describe, expect, it } from 'vitest'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs/promises'
import {
  type TrioStore,
  createTrioAllocator,
  fileTrioStore,
  probeTrioFree,
} from 'yaac-netd/listeners'
import { type ListenerRange, slotPreference, trioForSlot, trioPorts } from 'yaac-netd/ports'

const RANGE: ListenerRange = { base: 15100, slots: 8 }
const NS = 'yaac-test-alloc'

function memoryStore(initial: number | null = null): TrioStore & { slot: number | null } {
  const store = {
    slot: initial,
    read: () => Promise.resolve(store.slot),
    write: (slot: number) => { store.slot = slot; return Promise.resolve() },
    clear: () => { store.slot = null; return Promise.resolve() },
  }
  return store
}

function allocator(store: TrioStore, occupied: number[] = []) {
  const logs: string[] = []
  const taken = new Set(occupied)
  const alloc = createTrioAllocator({
    installNamespace: NS,
    range: RANGE,
    store,
    isFree: (trio) => Promise.resolve(!trioPorts(trio).some((p) => taken.has(p))),
    log: (m) => { logs.push(m) },
  })
  return { alloc, logs, taken }
}

describe('createTrioAllocator', () => {
  it('takes its hashed first choice when the node is empty', async () => {
    const { alloc } = allocator(memoryStore())
    const want = trioForSlot(slotPreference(NS, RANGE)[0], RANGE)
    expect(await alloc.resolve()).toEqual(want)
  })

  it('persists the slot it chose', async () => {
    const store = memoryStore()
    const { alloc } = allocator(store)
    await alloc.resolve()
    expect(store.slot).toBe(slotPreference(NS, RANGE)[0])
  })

  it('probes past a trio another install already holds', async () => {
    const order = slotPreference(NS, RANGE)
    const blocked = trioPorts(trioForSlot(order[0], RANGE))
    const { alloc } = allocator(memoryStore(), blocked)
    expect(await alloc.resolve()).toEqual(trioForSlot(order[1], RANGE))
  })

  it('treats a trio as taken when ANY of its three ports is', async () => {
    const order = slotPreference(NS, RANGE)
    const onePort = [trioPorts(trioForSlot(order[0], RANGE))[2]]
    const { alloc } = allocator(memoryStore(), onePort)
    expect(await alloc.resolve()).toEqual(trioForSlot(order[1], RANGE))
  })

  it('reuses a persisted slot WITHOUT re-probing it', async () => {
    // Load-bearing: netd's container can restart while its Envoy keeps
    // running and keeps holding the ports. A re-probing netd would see its
    // own listeners as "taken", move to another trio, and strand every
    // established flow at the old one.
    const persisted = 5
    const held = trioPorts(trioForSlot(persisted, RANGE))
    const { alloc } = allocator(memoryStore(persisted), held)
    expect(await alloc.resolve()).toEqual(trioForSlot(persisted, RANGE))
  })

  it('ignores a persisted slot outside the current range', async () => {
    const { alloc } = allocator(memoryStore(RANGE.slots + 3))
    expect(await alloc.resolve()).toEqual(trioForSlot(slotPreference(NS, RANGE)[0], RANGE))
  })

  it('resolves once and caches — later passes never re-probe', async () => {
    const store = memoryStore()
    let probes = 0
    const alloc = createTrioAllocator({
      installNamespace: NS,
      range: RANGE,
      store,
      isFree: () => { probes++; return Promise.resolve(true) },
      log: () => { /* quiet */ },
    })
    await alloc.resolve()
    await alloc.resolve()
    expect(probes).toBe(1)
  })

  it('re-probes after reset(), which is the bind-rejection path', async () => {
    const store = memoryStore()
    const order = slotPreference(NS, RANGE)
    const { alloc, taken } = allocator(store)
    expect(await alloc.resolve()).toEqual(trioForSlot(order[0], RANGE))

    // Envoy reported the trio unusable; the slot another install won is
    // now visibly occupied, so the retry must land elsewhere.
    await alloc.reset()
    expect(store.slot).toBeNull()
    for (const port of trioPorts(trioForSlot(order[0], RANGE))) taken.add(port)
    expect(await alloc.resolve()).toEqual(trioForSlot(order[1], RANGE))
  })

  it('throws rather than sharing a trio when every slot is held', async () => {
    // Sharing would deliver this install's egress into another install's
    // Envoy; refusing costs egress, which is the fail-closed direction.
    const all = slotPreference(NS, RANGE).flatMap((s) => trioPorts(trioForSlot(s, RANGE)))
    const { alloc } = allocator(memoryStore(), all)
    await expect(alloc.resolve()).rejects.toThrow(/no free listener trio/)
  })

  it('logs the trio it settled on, for triage', async () => {
    const { alloc, logs } = allocator(memoryStore())
    const trio = await alloc.resolve()
    expect(logs.join('\n')).toContain(trioPorts(trio).join('/'))
  })
})

describe('fileTrioStore', () => {
  it('round-trips a slot and clears it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'netd-trio-'))
    const store = fileTrioStore(path.join(dir, 'trio.slot'))
    expect(await store.read()).toBeNull()
    await store.write(17)
    expect(await store.read()).toBe(17)
    await store.clear()
    expect(await store.read()).toBeNull()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('reads null from a malformed file rather than a bogus slot', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'netd-trio-'))
    const file = path.join(dir, 'trio.slot')
    await fs.writeFile(file, 'not-a-number')
    expect(await fileTrioStore(file).read()).toBeNull()
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('probeTrioFree', () => {
  it('reports a free trio as free', async () => {
    // Ports well above the reserved range so a real netd on this host
    // cannot make the test flaky.
    expect(await probeTrioFree({ https: 29431, http: 29432, tunnel: 29433 })).toBe(true)
  })

  it('reports a trio as taken when one port is bound', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen({ port: 29442, host: '0.0.0.0' }, resolve))
    try {
      expect(await probeTrioFree({ https: 29441, http: 29442, tunnel: 29443 })).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => { resolve() }))
    }
  })
})
