import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { createTestRepo, addTestProject } from '@yaac/test-utils/setup'

/**
 * E2e coverage for `yaac schedule add/list/rm` — pure server-backed CRUD
 * (no pods are started: the scheduler only fires when a spec comes due, and
 * these specs never do within the test's lifetime). One test env + one real
 * server shared across the file; tests run sequentially in declaration
 * order, and the empty-state list test is declared first.
 */
describe('yaac schedule (real CLI + real server)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer

  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
    server = await spawnYaacServer(testEnv.env)
    const repo = path.join(testEnv.scratchDir, 'repo-sched')
    await createTestRepo(repo)
    await addTestProject(repo)
  })

  afterAll(async () => {
    await server.stop()
    await testEnv.cleanup()
  })

  it('schedule list prints the empty-state hint when no schedules exist', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'schedule', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No schedules')
    expect(stdout).toContain('yaac schedule add')
  })

  it('schedule add requires --cron and --prompt', async () => {
    const noCron = await runYaac(testEnv.env, 'schedule', 'add', 'repo-sched', '--prompt', 'p')
    expect(noCron.exitCode).not.toBe(0)
    expect(noCron.stderr).toMatch(/--cron/)

    const noPrompt = await runYaac(testEnv.env, 'schedule', 'add', 'repo-sched', '--cron', '0 9 * * *')
    expect(noPrompt.exitCode).not.toBe(0)
    expect(noPrompt.stderr).toMatch(/--prompt/)
  })

  it('schedule add rejects a malformed cron expression', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'schedule', 'add', 'repo-sched', '--cron', 'not-a-cron', '--prompt', 'p',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/invalid cron/i)
  })

  it('schedule add rejects an unknown project', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'schedule', 'add', 'ghost-project', '--cron', '0 9 * * *', '--prompt', 'p',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/not found/i)
  })

  it('schedule add + list round-trip, including --tool', async () => {
    const added = await runYaac(
      testEnv.env, 'schedule', 'add', 'repo-sched',
      '--cron', '0 9 * * 1-5', '--prompt', 'triage the overnight failures', '--tool', 'codex',
    )
    expect(added.exitCode).toBe(0)
    expect(added.stdout).toMatch(/Schedule \S+ added/)

    const { stdout, exitCode } = await runYaac(testEnv.env, 'schedule', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('SCHEDULE')
    expect(stdout).toContain('repo-sched')
    expect(stdout).toContain('0 9 * * 1-5')
    expect(stdout).toContain('codex')
    expect(stdout).toContain('never')
    expect(stdout).toContain('triage the overnight failures')

    // The project filter argument narrows (and an unmatched slug is empty).
    const filtered = await runYaac(testEnv.env, 'schedule', 'list', 'repo-sched')
    expect(filtered.stdout).toContain('0 9 * * 1-5')
    const empty = await runYaac(testEnv.env, 'schedule', 'list', 'other-project')
    expect(empty.stdout).toContain('No schedules')
  })

  it('schedule rm removes by short-id prefix; unknown ids fail', async () => {
    const { stdout } = await runYaac(testEnv.env, 'schedule', 'list')
    // The short id is the first 8 chars of a UUID — hex only, which also
    // keeps this from matching the `--------` header divider.
    const shortId = /^([0-9a-f]{8}) /m.exec(stdout)![1]

    const removed = await runYaac(testEnv.env, 'schedule', 'rm', shortId)
    expect(removed.exitCode).toBe(0)
    expect(removed.stdout).toMatch(/removed/i)

    const after = await runYaac(testEnv.env, 'schedule', 'list')
    expect(after.stdout).toContain('No schedules')

    const missing = await runYaac(testEnv.env, 'schedule', 'rm', 'deadbeef')
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr).toMatch(/no schedule/i)
  })
})
