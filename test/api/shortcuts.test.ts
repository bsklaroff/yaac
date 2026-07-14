import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp } from '@yaac/server/server'
import { makeTestApiClient } from '@yaac/test-utils/api'

const chord = { code: 'KeyG', alt: true, ctrl: false, meta: false, shift: false }

describe('shortcuts route', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('GET /shortcuts/get returns no overrides initially', async () => {
    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.shortcuts.get.$get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ overrides: {} })
  })

  it('POST /shortcuts/set persists a rebind that GET then reflects', async () => {
    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const set = await client.shortcuts.set.$post({ json: { id: 'new-session', chord } })
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({ ok: true })

    const get = await client.shortcuts.get.$get()
    expect(await get.json()).toEqual({ overrides: { 'new-session': chord } })
  })

  it('POST /shortcuts/set rejects a malformed chord', async () => {
    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.shortcuts.set.$post({
      // @ts-expect-error — chord is missing modifier flags on purpose
      json: { id: 'new-session', chord: { code: 'KeyG' } },
    })
    expect(res.status).toBe(400)
  })

  it('POST /shortcuts/reset clears every override', async () => {
    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    await client.shortcuts.set.$post({ json: { id: 'new-session', chord } })
    const reset = await client.shortcuts.reset.$post()
    expect(reset.status).toBe(200)
    const get = await client.shortcuts.get.$get()
    expect(await get.json()).toEqual({ overrides: {} })
  })
})
