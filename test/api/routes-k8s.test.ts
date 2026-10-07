import { describe, it, expect } from 'vitest'
import { workspaceDriver } from '@yaac/server/drivers/driver'
import { buildApp } from '@yaac/server/main/server'
import {
  ROUTE_MATRIX,
  assertMatrixCoversEveryRoute,
  describeNonOwner,
  expectedFor,
  label,
  requestRoute,
  type RouteCase,
} from './route-matrix'

/**
 * Every route, against a k8s server.
 *
 * The twin of `routes-containerless.test.ts`, over the same table (see
 * `route-matrix.ts` for what these assert).
 *
 * The project's setup file registers the real k8s driver. Several
 * expectations allow 503 alongside 404, because a route that reaches the
 * substrate answers RUNTIME_UNAVAILABLE when no cluster is up.
 */

const app = (): ReturnType<typeof buildApp> => buildApp({ buildId: 'matrix' })

const request = (route: RouteCase): Promise<Response> => requestRoute(app(), route)

describe('every route, k8s', () => {
  it('the matrix names every route the server registers', () => {
    assertMatrixCoversEveryRoute()
  })

  it('runs against the k8s driver', () => {
    expect(workspaceDriver().kind).toBe('k8s')
  })

  for (const route of ROUTE_MATRIX) {
    it(`${label(route)} answers as the matrix says`, async () => {
      const res = await request(route)
      expect(expectedFor(route, 'k8s'), `${label(route)} → ${String(res.status)}`)
        .toContain(res.status)
    })
  }

  // A 501 here means a guard fired on the wrong driver, unless the matrix
  // declares it (the in-workspace command channel, which k8s serves through
  // the egress proxy instead).
  it('refuses only what the matrix declares unsupported here', async () => {
    for (const route of ROUTE_MATRIX) {
      const status = (await request(route)).status
      if (expectedFor(route, 'k8s').includes(501)) continue
      expect(status, label(route)).not.toBe(501)
    }
  })
})

describeNonOwner('k8s')
