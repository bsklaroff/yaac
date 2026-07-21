import { describe, it, expect, vi } from 'vitest'
import { createClusterApp, type ClusterRouteDeps } from '#routes/cluster'
import { buildApp } from '#main/server'
import { ClusterSetupError } from '#features/cluster/setup'
import type { CheckResult, ClusterSetupEvent } from '@yaac/shared/types'

const PASS: CheckResult = { name: 'kubectl', status: 'pass', detail: 'installed' }
const FAIL: CheckResult = { name: 'cluster', status: 'fail', detail: 'no kind cluster', fix: 'yaac cluster setup' }

function fakeDeps(over: Partial<ClusterRouteDeps> = {}): ClusterRouteDeps {
  return {
    check: () => Promise.resolve({ ok: true, results: [PASS] }),
    setup: () => Promise.resolve(true),
    ...over,
  }
}

function parseNdjson(text: string): ClusterSetupEvent[] {
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as ClusterSetupEvent)
}

describe('cluster routes', () => {
  it('GET /check passes the deps result through', async () => {
    const app = createClusterApp(fakeDeps({
      check: () => Promise.resolve({ ok: false, results: [PASS, FAIL] }),
    }))
    const res = await app.request('/check')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, results: [PASS, FAIL] })
  })

  it('POST /setup streams progress lines then the result', async () => {
    const app = createClusterApp(fakeDeps({
      setup: (onProgress) => {
        onProgress('Creating kind cluster…')
        onProgress('Installing Cilium…')
        return Promise.resolve(true)
      },
    }))
    const res = await app.request('/setup', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(parseNdjson(await res.text())).toEqual([
      { type: 'progress', message: 'Creating kind cluster…' },
      { type: 'progress', message: 'Installing Cilium…' },
      { type: 'result', ok: true },
    ])
  })

  it('POST /setup reports a not-ok finishing check as result ok:false', async () => {
    const app = createClusterApp(fakeDeps({ setup: () => Promise.resolve(false) }))
    const events = parseNdjson(await (await app.request('/setup', { method: 'POST' })).text())
    expect(events).toEqual([{ type: 'result', ok: false }])
  })

  it('POST /setup emits a thrown ClusterSetupError as an error event', async () => {
    const app = createClusterApp(fakeDeps({
      setup: () => Promise.reject(new ClusterSetupError('podman machine is not running')),
    }))
    const res = await app.request('/setup', { method: 'POST' })
    // The stream already started, so the status stays 200 — the error
    // travels in-band as the final NDJSON event.
    expect(res.status).toBe(200)
    expect(parseNdjson(await res.text())).toEqual([
      { type: 'error', error: { message: 'podman machine is not running' } },
    ])
  })

  it('POST /setup stringifies a non-Error throw', async () => {
    const app = createClusterApp(fakeDeps({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      setup: () => Promise.reject('boom'),
    }))
    expect(parseNdjson(await (await app.request('/setup', { method: 'POST' })).text())).toEqual([
      { type: 'error', error: { message: 'boom' } },
    ])
  })

  it('is mounted behind auth in buildApp', async () => {
    const check = vi.fn(() => Promise.resolve({ ok: true, results: [PASS] }))
    const app = buildApp({
      secret: 'shh', buildId: 'test-build-id',
      cluster: fakeDeps({ check }),
    })
    expect((await app.request('/cluster/check')).status).toBe(401)
    const res = await app.request('/cluster/check', { headers: { authorization: 'Bearer shh' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, results: [PASS] })
    expect(check).toHaveBeenCalledTimes(1)
  })
})
