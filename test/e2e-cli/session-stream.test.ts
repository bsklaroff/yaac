import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { createTestRepo, addTestProject, requirePodman } from '@test/helpers/setup'

describe('yaac session stream (real CLI + real daemon)', () => {
  // pickNextStreamSession always calls podman.listContainers to filter
  // running sessions, even when the projects dir is empty — so this
  // test file needs a live podman.
  beforeAll(async () => {
    await requirePodman()
  })

  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    daemon = await spawnYaacDaemon(testEnv.env)
  })

  afterEach(async () => {
    await daemon.stop()
    await testEnv.cleanup()
  })

  it('exits with the empty-state message when no projects exist', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'session', 'stream')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No projects found')
  })

  it('exits after the user cancels the project-selection prompt', async () => {
    const repoA = path.join(testEnv.scratchDir, 'proj-a')
    const repoB = path.join(testEnv.scratchDir, 'proj-b')
    await createTestRepo(repoA)
    await createTestRepo(repoB)
    await addTestProject(repoA)
    await addTestProject(repoB)

    // Send a non-numeric answer so the CLI hits the "Invalid selection."
    // branch and returns "No project selected. Exiting session stream."
    const { stdout, exitCode } = await runYaac(
      testEnv.env, 'session', 'stream', { stdin: 'x\n' },
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Select a project')
    expect(stdout).toContain('proj-a')
    expect(stdout).toContain('proj-b')
    expect(stdout).toContain('No project selected')
  })

  it('errors when the --tool flag is not claude or codex', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'stream', '--tool', 'mystery',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr.toLowerCase()).toMatch(/tool|mystery/)
  })
})
