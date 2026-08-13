import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setWorktreeDriver, worktreeDriver } from '@yaac/server/drivers/driver'
import { createContainerlessDriver } from '@yaac/server/drivers/containerless'
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
 * `route-matrix.ts` for why the two share one. What this file adds is the
 * driver: it registers the containerless one in place of the real k8s driver
 * the api project's setup installs, which is safe to do in-process because
 * the registry is a module-level singleton and nothing here launches
 * anything.
 *
 * Registering the real containerless driver rather than a fake is the point.
 * A fake would answer whatever it was told to; this exercises the actual
 * assembly — including every verb that degrades to empty and every route
 * that refuses because this substrate has no such feature.
 */

let previous: ReturnType<typeof worktreeDriver> | null = null

beforeAll(() => {
  previous = worktreeDriver()
  setWorktreeDriver(createContainerlessDriver())
})

afterAll(() => {
  setWorktreeDriver(previous)
})

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
