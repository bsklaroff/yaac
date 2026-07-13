import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import {
  createYaacTestEnv,
  runYaac,
  acquireServerMutex,
  type YaacTestEnv,
} from '@yaac/test-utils/cli'

// These tests spawn detached servers via the CLI (`server start`), so hold
// the cross-worker server mutex for the whole file, like server.test.ts.
let releaseServerMutex: (() => Promise<void>) | null = null
beforeAll(async () => {
  releaseServerMutex = await acquireServerMutex()
})
afterAll(async () => {
  await releaseServerMutex?.()
  releaseServerMutex = null
})

describe('yaac tool get/set (real CLI + real server)', () => {
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await runYaac(testEnv.env, 'server', 'stop')
    await testEnv.cleanup()
  })

  it('set persists the default tool across a server restart', async () => {
    const start = await runYaac(testEnv.env, 'server', 'start')
    expect(start.exitCode).toBe(0)

    const unset = await runYaac(testEnv.env, 'tool', 'get')
    expect(unset.exitCode).toBe(0)
    expect(unset.stdout).toMatch(/No default tool configured/)

    const set = await runYaac(testEnv.env, 'tool', 'set', 'codex')
    expect(set.exitCode).toBe(0)
    expect(set.stdout).toContain('Default tool set to "codex"')

    const got = await runYaac(testEnv.env, 'tool', 'get')
    expect(got.exitCode).toBe(0)
    expect(got.stdout.trim()).toBe('codex')

    // The preference lives in the server's on-disk DB, so a fresh server
    // process must still see it.
    const restart = await runYaac(testEnv.env, 'server', 'restart')
    expect(restart.exitCode).toBe(0)

    const after = await runYaac(testEnv.env, 'tool', 'get')
    expect(after.exitCode).toBe(0)
    expect(after.stdout.trim()).toBe('codex')
  })

  it('set rejects an unknown tool', async () => {
    const start = await runYaac(testEnv.env, 'server', 'start')
    expect(start.exitCode).toBe(0)

    const bad = await runYaac(testEnv.env, 'tool', 'set', 'gemini')
    expect(bad.exitCode).not.toBe(0)
    expect(bad.stderr).toMatch(/Invalid tool/)
  })
})
