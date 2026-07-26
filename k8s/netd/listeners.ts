/**
 * Choosing — and keeping — this install's listener trio.
 *
 * Two things have to be true at once, and they pull in opposite
 * directions:
 *
 *  - The trio must not collide with a coexisting install's. Several netds
 *    share a node's network namespace (the real `yaac` one plus an e2e
 *    run's `yaac-test-<run-id>`), so the only honest test for "free" is to
 *    try to bind it.
 *  - The trio must not MOVE while flows are using it. Every rule netd
 *    programs names a port, and conntrack pins a flow's DNAT destination
 *    on its first packet.
 *
 * So the choice is probed once and then persisted next to the Envoy config
 * (an emptyDir, i.e. the pod's lifetime). Persistence is not an
 * optimization: netd's container can restart while the Envoy container
 * keeps running and keeps holding the ports, and a re-probing netd would
 * find its OWN listeners occupied and walk to a different trio, silently
 * stranding every established flow.
 *
 * `reset()` is the escape hatch, used when the Envoy gate reports that our
 * listeners were rejected — the one case where the persisted slot is
 * genuinely wrong and re-probing is the fix.
 */

import net from 'node:net'
import fs from 'node:fs/promises'
import { type ListenerRange, type ListenerTrio, slotPreference, trioForSlot, trioPorts } from 'yaac-netd/ports'

/** Where the chosen slot survives a netd container restart. */
export interface TrioStore {
  read: () => Promise<number | null>
  write: (slot: number) => Promise<void>
  clear: () => Promise<void>
}

/** A single-value file store; an unreadable or malformed file reads null. */
export function fileTrioStore(file: string): TrioStore {
  return {
    read: async () => {
      const raw = (await fs.readFile(file, 'utf8').catch(() => '')).trim()
      // Guard the empty string explicitly: Number('') is 0, which would
      // read a missing file as "slot 0 was persisted".
      if (!raw) return null
      const slot = Number(raw)
      return Number.isInteger(slot) && slot >= 0 ? slot : null
    },
    write: async (slot) => {
      const tmp = `${file}.tmp`
      await fs.writeFile(tmp, String(slot))
      await fs.rename(tmp, file)
    },
    clear: () => fs.rm(file, { force: true }),
  }
}

/**
 * Can this process bind every port of `trio` on the node?
 *
 * `exclusive` so the probe never succeeds by joining someone else's
 * SO_REUSEPORT group — the listeners themselves set `enable_reuse_port:
 * false` for the same reason, and a probe with laxer semantics than the
 * real bind would happily hand out an occupied trio.
 */
export async function probeTrioFree(trio: ListenerTrio): Promise<boolean> {
  for (const port of trioPorts(trio)) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer()
      server.once('error', () => { resolve(false) })
      server.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
        server.close(() => { resolve(true) })
      })
    })
    if (!free) return false
  }
  return true
}

export interface TrioAllocatorDeps {
  installNamespace: string
  range: ListenerRange
  store: TrioStore
  /** Injected so tests can decide occupancy without touching real sockets. */
  isFree: (trio: ListenerTrio) => Promise<boolean>
  log: (message: string) => void
}

export interface TrioAllocator {
  /** The trio in force, probing and persisting one on first call. */
  resolve: () => Promise<ListenerTrio>
  /** Forget the current choice so the next resolve() probes again. */
  reset: () => Promise<void>
}

export function createTrioAllocator(deps: TrioAllocatorDeps): TrioAllocator {
  let current: ListenerTrio | null = null

  return {
    resolve: async () => {
      if (current) return current

      // A persisted slot is authoritative and deliberately NOT re-probed:
      // our own Envoy is the process most likely to be holding it.
      const persisted = await deps.store.read()
      if (persisted !== null && persisted < deps.range.slots) {
        current = trioForSlot(persisted, deps.range)
        deps.log(`[netd] listener trio ${trioPorts(current).join('/')} (slot ${persisted}, persisted)`)
        return current
      }

      for (const slot of slotPreference(deps.installNamespace, deps.range)) {
        const trio = trioForSlot(slot, deps.range)
        if (!await deps.isFree(trio)) continue
        await deps.store.write(slot)
        current = trio
        deps.log(`[netd] listener trio ${trioPorts(trio).join('/')} (slot ${slot})`)
        return trio
      }
      // Every slot in the range is held by other installs. Refusing is the
      // fail-closed direction: sharing a port would deliver this install's
      // egress to another install's Envoy.
      throw new Error(
        `netd: no free listener trio in ${deps.range.base}+${deps.range.slots * 3} — `
        + 'every slot on this node is already bound',
      )
    },

    reset: async () => {
      current = null
      await deps.store.clear()
    },
  }
}
