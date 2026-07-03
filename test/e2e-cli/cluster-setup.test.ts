import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createYaacTestEnv, runYaac, type YaacTestEnv } from '@test/helpers/cli'
import { IS_NESTED_YAAC } from '@test/helpers/setup'

/**
 * E2e coverage for `yaac cluster setup` and its `--repair` option. Like the
 * cluster-check suite, the command is host-side (podman/kind/kubectl, no
 * daemon), and the full happy path is destructive — it deletes and recreates
 * the host's kind cluster — so it is exercised manually per the README.
 * These cases cover the guard rails: every path below fails BEFORE the first
 * mutating step, asserted by exit code + diagnostic.
 */

function onPath(bin: string): boolean {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => dir && existsSync(path.join(dir, bin)))
}

/** Strip every PATH entry containing any of the given binaries. */
function stripFromPath(...bins: string[]): string {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir && !bins.some((bin) => existsSync(path.join(dir, bin))))
    .join(path.delimiter)
}

describe('yaac cluster setup (real CLI)', () => {
  let testEnv: YaacTestEnv

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
  })

  afterEach(async () => {
    await testEnv.cleanup()
  })

  it('refuses to run inside a nested yaac session', async () => {
    const { stderr, exitCode } = await runYaac(
      { ...testEnv.env, YAAC_NESTED: '1' },
      'cluster', 'setup',
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/nested yaac session/)
    expect(stderr).toMatch(/outer yaac/)
  }, 30_000)

  it('fails with a complete shopping list when podman and kind are missing', async () => {
    // Drop the nested flag so the missing-binaries preflight (not the
    // nested guard) is what's under test when this suite itself runs
    // inside a nested session.
    const env: NodeJS.ProcessEnv = { ...testEnv.env, PATH: stripFromPath('podman', 'kind') }
    delete env.YAAC_NESTED

    const { stderr, exitCode } = await runYaac(env, 'cluster', 'setup')
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/Missing required tools/)
    expect(stderr).toMatch(/podman/)
    expect(stderr).toMatch(/kind/)
    // Actionable installs accompany each entry.
    expect(stderr).toMatch(/brew install/)
  }, 30_000)

  // Needs a real, working podman+kind pair (`kind get clusters` must
  // succeed), so: not in a nested session (no kind in there), and not on a
  // host missing either binary. Linux-only: on macOS the machine-bootstrap
  // step runs first and could touch real machine state.
  it.skipIf(IS_NESTED_YAAC || process.platform !== 'linux' || !onPath('kind') || !onPath('podman'))(
    '--repair fails fast when the target kind cluster does not exist',
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...testEnv.env,
        // A cluster name that cannot exist: --repair must fail on node
        // enumeration BEFORE ensuring the registry or touching any node.
        YAAC_KIND_CLUSTER: `yaac-e2e-absent-${crypto.randomBytes(4).toString('hex')}`,
      }
      delete env.YAAC_NESTED

      const { stdout, stderr, exitCode } = await runYaac(env, 'cluster', 'setup', '--repair')
      expect(exitCode).toBe(1)
      expect(stderr).toMatch(/not found/)
      expect(stderr).toMatch(/yaac cluster setup/)
      // No fixups were attempted.
      expect(stdout).not.toMatch(/Re-applying node fixups/)
    },
    60_000,
  )
})
