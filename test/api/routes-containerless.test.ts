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
 * Every route, against a containerless server.
 *
 * The twin of `routes-k8s.test.ts`, over the SAME table — see
 * `route-matrix.ts` for why the two share one.
 *
 * No driver is installed here: this file's own project registers the real
 * containerless one at module scope, standing in for the composition root.
 * The REAL driver rather than a fake is the point — a fake would answer
 * whatever it was told to, while this exercises the actual assembly,
 * including every verb that degrades to empty and every route that refuses
 * because this substrate has no such feature.
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

describe('every route, containerless', () => {
  it('the matrix names every route the server registers', () => {
    assertMatrixCoversEveryRoute()
  })

  // The project's setup file is what installed it, so this is also the
  // check that the split did not leave this file running against the k8s
  // driver its twin uses.
  it('runs against the containerless driver', () => {
    expect(worktreeDriver().kind).toBe('containerless')
  })

  for (const route of ROUTE_MATRIX) {
    it(`${label(route)} answers as the matrix says`, async () => {
      const res = await request(route)
      expect(expectedFor(route, 'containerless'), `${label(route)} → ${String(res.status)}`)
        .toContain(res.status)
    })
  }

  // A refusal has to be legible, not just a status: a client that renders
  // per driver never sees one, so whoever does is a human reading it.
  for (const route of ROUTE_MATRIX.filter((r) => r.containerless === 501)) {
    it(`${label(route)} says why it is unsupported`, async () => {
      const res = await request(route)
      const body = await res.json() as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('NOT_SUPPORTED')
      expect(body.error?.message).toMatch(/This server /)
    })
  }
})
