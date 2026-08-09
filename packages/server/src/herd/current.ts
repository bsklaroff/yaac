import type { HerdClient } from './contract'

/**
 * The herd this server is driving.
 *
 * A module-level handle rather than a constructor argument threaded through
 * every route: the callers are Hono apps and reconcile steps built at module
 * scope, and the server drives exactly one herd (more than one is deferred —
 * see docs/plans/herd-split.md). The accessor is what keeps the swap to a
 * remote implementation a one-line change at startup.
 */
let client: HerdClient | null = null

/** Install the herd every `herd()` call is answered from. Replaces any
 *  previous one (last registration wins). */
export function setHerd(next: HerdClient): void {
  client = next
}

/**
 * The installed herd.
 *
 * Throws when there is none, on purpose: every caller is answering a request
 * or running a reconcile step, and there is no meaningful degraded behavior
 * for either — a herd-less server has nothing to say about a workspace. A
 * unit test that exercises a path reaching the herd installs a fake.
 */
export function herd(): HerdClient {
  if (!client) throw new Error('no herd is attached to this server')
  return client
}

/** Test helper: drop the installed herd. */
export function _resetHerdForTests(): void {
  client = null
}

/** A herd stub: any subset of any group's methods. */
export type HerdStub = { [G in keyof HerdClient]?: Partial<HerdClient[G]> }

/**
 * Test helper: install a herd answering only the calls a test stubs.
 *
 * Anything else throws by name rather than as `undefined is not a function`,
 * so a path that reaches unexpectedly across the boundary says which call it
 * made — which is most of what these tests are for.
 */
export function _setHerdForTests(stub: HerdStub): void {
  const groups = stub as Record<string, Record<string, unknown> | undefined>
  client = new Proxy({} as HerdClient, {
    get: (_target, group: string) => new Proxy({}, {
      get: (_g, name: string) => {
        const fn = groups[group]?.[name]
        if (typeof fn === 'function') return fn
        return () => {
          throw new Error(`herd stub: ${group}.${name} was called but not stubbed`)
        }
      },
    }),
  })
}
