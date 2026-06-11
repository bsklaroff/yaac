import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createYaacTestEnv, runYaac, type YaacTestEnv } from '@test/helpers/cli'

/**
 * E2e coverage for `yaac cluster check` (no options). The command is a
 * host-side preflight — it talks to kubectl/podman/the registry directly,
 * never to the daemon — so these failure-path cases run without a cluster
 * (and without a daemon): we sabotage the environment and assert the
 * diagnostic output + exit code.
 *
 * The happy path (all checks pass, exit 0) requires a fully wired kind
 * cluster and is exercised by running the command manually per the README.
 */
describe('yaac cluster check (real CLI)', () => {
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await testEnv.cleanup()
  })

  it('fails with a kubectl diagnostic when kubectl is not on PATH', async () => {
    // Strip every PATH entry that contains a kubectl binary. Node itself
    // is spawned via an absolute path (process.execPath), so trimming
    // PATH only affects the CLI's child-process lookups — exactly the
    // `execFile('kubectl', ...)` probe under test.
    const strippedPath = (process.env.PATH ?? '')
      .split(path.delimiter)
      .filter((dir) => dir && !existsSync(path.join(dir, 'kubectl')))
      .join(path.delimiter)

    const { stdout, stderr, exitCode } = await runYaac(
      { ...testEnv.env, PATH: strippedPath },
      'cluster', 'check',
    )
    expect(exitCode).toBe(1)
    expect(stdout).toContain('✗ kubectl')
    expect(stdout).toMatch(/not found on PATH/)
    // Actionable fix line accompanies the failure.
    expect(stdout).toMatch(/Install kubectl/)
    expect(stderr).toMatch(/Cluster is not ready/)
  }, 30_000)

  it('fails with a cluster diagnostic when kubectl is present but the API server is unreachable', async () => {
    // A KUBECONFIG pointing at a nonexistent file makes kubectl fall back
    // to an empty config, so `kubectl version` (server half) fails with a
    // connection error no matter what clusters the host knows about.
    const { stdout, stderr, exitCode } = await runYaac(
      { ...testEnv.env, KUBECONFIG: path.join(testEnv.scratchDir, 'no-such-kubeconfig') },
      'cluster', 'check',
    )
    expect(exitCode).toBe(1)
    // kubectl itself passes...
    expect(stdout).toContain('✓ kubectl')
    // ...but the API-server check fails with the cluster diagnostic.
    expect(stdout).toContain('✗ cluster')
    expect(stdout).toMatch(/API server unreachable/)
    expect(stderr).toMatch(/Cluster is not ready/)
  }, 30_000)
})
