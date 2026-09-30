/**
 * Chooses this install's listener trio and keeps it stable.
 *
 * Several installs' netds can share a node's network namespace, so a free
 * trio is found by trying to bind it. Once chosen, the slot is persisted
 * in the Envoy config emptyDir: if the netd container restarts while Envoy
 * keeps running, re-probing would find netd's own listeners busy and move
 * to another trio, breaking established flows.
 *
 * `reset()` forgets the slot. netd calls it when Envoy rejects the
 * listeners, the one case where re-probing is correct.
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
      // Number('') is 0, so an empty read must not reach Number().
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
 * Can this process bind every port of `trio` on the node? Binds with
 * `exclusive` to match Envoy's `enable_reuse_port: false`, so the probe
 * never succeeds by sharing a port with another listener.
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

      // Not re-probed: our own Envoy is likely holding it.
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
