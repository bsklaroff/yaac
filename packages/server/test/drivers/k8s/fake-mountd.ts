import { expect, vi } from 'vitest'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { MOUNTD_PORT, installId, k8sNamespace } from '#drivers/k8s/substrate'
import { readyNodes, serverBuild, watchMountd, type MountdReport } from '#drivers/k8s/cluster'

/**
 * mountd at its HTTP boundary, for unit tests of what the server
 * asks of them (docs/generic-workspace-pods.md "mountd"). `install`
 * seeds a Running mountd pod on each named node and stubs `fetch` to answer
 * its address; a request anywhere else reaches the `fetch` that was there
 * before (the real one, or another fake's). `settle` asks every mountd for
 * its report until the nodes the server counts as ready are the expected
 * ones, since that state lives in the cluster folder and outlives a test.
 * Call `install` from a `beforeEach`, after `fakeCluster.reset()`.
 */

/** One request a mountd received. */
export interface AgentRequest {
  node: string
  method: string
  route: string
  authorization: string | null
  body: unknown
}

const addressOf = (i: number): string => `10.250.0.${String(i + 1)}`

export const fakeMountd = {
  /** Each node's answer to `GET /report`; an Error is a refusal with its message. */
  reports: new Map<string, MountdReport | Error>(),
  /** Refusals of other routes, by `METHOD /route` or `node METHOD /route`,
   *  as mountd's error text. */
  refusals: new Map<string, string>(),
  /** Nodes whose mountd refuses connections, as while its pod is replaced. */
  down: new Set<string>(),
  /** Every request in order, `/report` included. */
  requests: [] as AgentRequest[],

  /** The requests to one route, `/report` aside. */
  sent(route: string): AgentRequest[] {
    return fakeMountd.requests.filter((r) => r.route === route)
  },

  /** A report a ready mountd on this server's build gives. */
  async goodReport(over: Partial<MountdReport> = {}): Promise<MountdReport> {
    return { build: await serverBuild(), arborist: true, freeBytes: 100 * 1024 ** 3, trees: [], ...over }
  },

  /** A mountd on each of `nodes`, every one answering a good report. */
  async install(nodes: string[]): Promise<void> {
    fakeMountd.reports.clear()
    fakeMountd.refusals.clear()
    fakeMountd.down.clear()
    fakeMountd.requests = []
    const byAddress = new Map<string, string>()
    for (const [i, node] of nodes.entries()) {
      byAddress.set(addressOf(i), node)
      fakeMountd.reports.set(node, await fakeMountd.goodReport())
      fakeCluster.seed({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: `yaac-mountd-${node}`,
          namespace: k8sNamespace(),
          labels: { app: 'yaac-mountd', 'yaac.install-id': installId() },
        },
        spec: { nodeName: node },
        status: { phase: 'Running', podIP: addressOf(i) },
      })
    }
    const previous = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(String(input))
      const node = url.port === String(MOUNTD_PORT) ? byAddress.get(url.hostname) : undefined
      if (node === undefined) return previous(input, init)
      const method = init.method ?? 'GET'
      fakeMountd.requests.push({
        node,
        method,
        route: url.pathname,
        authorization: new Headers(init.headers).get('Authorization'),
        body: typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
      })
      if (fakeMountd.down.has(node)) {
        return Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }))
      }
      const route = `${method} ${url.pathname}`
      const refusal = url.pathname === '/report'
        ? fakeMountd.reports.get(node)
        : fakeMountd.refusals.get(`${node} ${route}`) ?? fakeMountd.refusals.get(route)
      if (refusal instanceof Error || typeof refusal === 'string') {
        const error = refusal instanceof Error ? refusal.message : refusal
        return Promise.resolve(new Response(JSON.stringify({ error }), { status: 500 }))
      }
      return Promise.resolve(new Response(url.pathname === '/report' ? JSON.stringify(refusal) : '', { status: 200 }))
    })
  },

  /** Ask every mountd for its report until the ready nodes are `expected`. */
  async settle(expected: string[]): Promise<void> {
    const stop = watchMountd()
    try {
      await vi.waitFor(() => { expect(readyNodes().sort()).toEqual([...expected].sort()) })
    } finally {
      stop()
    }
  },
}
