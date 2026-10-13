import { vi } from 'vitest'
import { registryHost } from '#drivers/k8s/cluster/registry'

/** The real `fetch`, captured before any test stubs it. */
const realFetch = globalThis.fetch

/**
 * A fake main registry at the network boundary, for unit tests of code
 * that asks the registry which tags it holds. `install()` points the
 * registry client at the in-cluster Service (`YAAC_IN_CLUSTER`), so no
 * port-forward is spawned, and stubs `fetch` to answer `/v2/` and manifest
 * HEADs from `tags`. Requests to any other URL reach the real `fetch`.
 * Call `install()` from a `beforeEach`; it starts empty and reachable.
 */
export const fakeRegistry = {
  /** `repo:tag` strings the registry holds. */
  tags: new Set<string>(),
  /** When set, the registry holds every tag asked about. */
  holdsAll: false,
  /** When set, every request fails the way an unreachable registry's does. */
  down: false,
  /** Each tag a manifest HEAD asked about, in order. */
  lookups: [] as string[],

  install(): void {
    fakeRegistry.tags.clear()
    fakeRegistry.holdsAll = false
    fakeRegistry.down = false
    fakeRegistry.lookups.length = 0
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    const origin = `http://${registryHost()}`
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith(origin)) return realFetch(input, init)
      if (fakeRegistry.down) return Promise.reject(new TypeError('fetch failed'))
      const route = url.slice(origin.length)
      const manifest = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(route)
      const tag = manifest ? `${manifest[1]}:${manifest[2]}` : null
      if (tag) fakeRegistry.lookups.push(tag)
      const found = tag ? fakeRegistry.holdsAll || fakeRegistry.tags.has(tag) : route === '/v2/'
      return Promise.resolve(new Response(null, { status: found ? 200 : 404 }))
    })
  },
}
