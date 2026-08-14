import { describe, it, expect } from 'vitest'
import { worktreeDriver } from '@yaac/server/drivers/driver'
import { buildApp } from '@yaac/server/main/server'
import {
  ROUTE_MATRIX,
  assertMatrixCoversEveryRoute,
  expectedFor,
  label,
  type RouteCase,
} from './route-matrix'

/**
 * Every route, against a k8s server.
 *
 * The twin of `routes-containerless.test.ts`, over the SAME table — see
 * `route-matrix.ts` for why the two share one, and for what these assert
 * (the status class a caller sees against an empty server, not behavior;
 * that is `write-routes.test.ts` and the e2e tiers).
 *
 * No driver is installed here: the api project's setup registers the real
 * k8s one at module scope, standing in for the composition root. Several
 * expectations therefore allow 503 alongside 404 — a route that has to reach
 * the substrate answers RUNTIME_UNAVAILABLE when the cluster is not up, and
 * pinning it either way would make this file a cluster-health check rather
 * than a route-parity one.
 */

const app = (): ReturnType<typeof buildApp> => buildApp({ secret: 'shh', buildId: 'matrix' })

async function request(route: RouteCase): Promise<Response> {
  const path = route.request ?? route.path
  const init: RequestInit = { method: route.method }
  if (route.body !== undefined) {
    init.body = JSON.stringify(route.body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  return await app().request(path, init)
}

describe('every route, k8s', () => {
  it('the matrix names every route the server registers', () => {
    assertMatrixCoversEveryRoute()
  })

  it('runs against the k8s driver', () => {
    expect(worktreeDriver().kind).toBe('k8s')
  })

  for (const route of ROUTE_MATRIX) {
    it(`${label(route)} answers as the matrix says`, async () => {
      const res = await request(route)
      expect(expectedFor(route, 'k8s'), `${label(route)} → ${String(res.status)}`)
        .toContain(res.status)
    })
  }

  // A 501 here means a guard fired on the wrong driver — with one honest
  // exception, which the matrix has to have declared: the in-worktree
  // command channel is the containerless half of a pair whose k8s half is
  // the egress proxy's queue, so it is this substrate that lacks the route.
  // Anything else refusing is the bug this test exists for.
  it('refuses only what the matrix declares unsupported here', async () => {
    for (const route of ROUTE_MATRIX) {
      const status = (await request(route)).status
      if (expectedFor(route, 'k8s').includes(501)) continue
      expect(status, label(route)).not.toBe(501)
    }
  })
})
