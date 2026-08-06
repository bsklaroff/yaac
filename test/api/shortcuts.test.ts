import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp } from '@yaac/server/main/server'
import { makeTestApiClient } from '@yaac/test-utils/api'

const chord = { code: 'KeyG', alt: true, ctrl: false, meta: false, shift: false }

/**
 * One data dir for the file, not one per test: a fresh dir costs a PGlite
 * boot plus a migration replay, which dwarfed these four route assertions.
 * Order is load-bearing in exchange — the pristine-state case is declared
 * first, and the reset case (which is also the only other writer) last, so
 * nothing inherits an override it didn't write.
 */
describe('shortcuts route', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await createTempDataDir()
  })

  afterAll(async () => {
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
