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
 * Every route, against a containerless server.
 *
 * The twin of `routes-k8s.test.ts`, over the same table (see
 * `route-matrix.ts`).
 *
 * This project's setup file registers the real containerless driver, not a
 * fake, so the test covers every verb that degrades to empty and every
 * route that refuses because this substrate lacks the feature.
 */

const app = (): ReturnType<typeof buildApp> => buildApp({ buildId: 'matrix' })

const request = (route: RouteCase): Promise<Response> => requestRoute(app(), route)

describe('every route, containerless', () => {
  it('the matrix names every route the server registers', () => {
    assertMatrixCoversEveryRoute()
  })

  it('runs against the containerless driver', () => {
    expect(workspaceDriver().kind).toBe('containerless')
  })

  for (const route of ROUTE_MATRIX) {
    it(`${label(route)} answers as the matrix says`, async () => {
      const res = await request(route)
      expect(expectedFor(route, 'containerless'), `${label(route)} → ${String(res.status)}`)
        .toContain(res.status)
    })
  }

  // A client that renders per driver never sees a refusal, so whoever does
  // is a human who needs a readable reason.
  for (const route of ROUTE_MATRIX.filter((r) => r.containerless === 501)) {
    it(`${label(route)} says why it is unsupported`, async () => {
      const res = await request(route)
      const body = await res.json() as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('NOT_SUPPORTED')
      expect(body.error?.message).toMatch(/This server /)
    })
  }
})

describeNonOwner('containerless')
