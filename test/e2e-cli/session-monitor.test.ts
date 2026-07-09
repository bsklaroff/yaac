import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { addTestProject, createTestRepo, requireCluster } from '@test/helpers/setup'

describe('yaac session monitor (real CLI + real daemon)', () => {
  // Each render calls session list, which queries pods via kubectl, so
  // even the empty-state renders need a reachable cluster.
  beforeAll(async () => {
    await requireCluster()
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

  /**
   * Spawn `yaac session monitor <args>` as a long-running child (it
   * re-renders forever), mirroring the `daemon logs -f` e2e pattern:
   * wait for the first render, assert on it, then kill the child.
   */
  async function runMonitorUntilFirstRender(...args: string[]): Promise<string> {
    const child: ChildProcess = spawn(process.execPath, [
      path.resolve('node_modules/tsx/dist/cli.mjs'),
      path.resolve('src/cli.ts'),
      'session', 'monitor', ...args,
    ], { env: testEnv.env, stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    try {
      // First render = header line plus the session list body.
      await waitFor(
        () => stdout.includes('yaac session monitor') && stdout.includes('No active sessions'),
        30_000,
        () => `monitor never rendered.\nstdout: ${stdout}\nstderr: ${stderr}`,
      )
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
    return stdout
  }

  it('renders the header with the default interval and the empty session list', async () => {
    const stdout = await runMonitorUntilFirstRender()
    expect(stdout).toMatch(/yaac session monitor {2}\(every 5s/)
    expect(stdout).toContain('Press Ctrl+C to exit')
    expect(stdout).toContain('No active sessions')
  })

  it('filters by the [project] argument and honors -n <seconds>', async () => {
    const repo = path.join(testEnv.scratchDir, 'proj-mon')
    await createTestRepo(repo)
    await addTestProject(repo)

    const stdout = await runMonitorUntilFirstRender('proj-mon', '-n', '1')
    expect(stdout).toMatch(/\(every 1s/)
    expect(stdout).toContain('No active sessions for project "proj-mon"')
  })

  it('honors the long-form --interval option', async () => {
    const stdout = await runMonitorUntilFirstRender('--interval', '2')
    expect(stdout).toMatch(/\(every 2s/)
  })
})

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  describeFailure: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(describeFailure())
}
