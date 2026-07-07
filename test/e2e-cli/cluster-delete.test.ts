import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createYaacTestEnv, runYaac, type YaacTestEnv } from '@test/helpers/cli'
import { IS_NESTED_YAAC } from '@test/helpers/setup'

/**
 * E2e coverage for `yaac cluster delete` and its `-y/--yes` option. Like the
 * cluster-setup suite, the command is host-side (kind/podman, no daemon), and
 * the full happy path is destructive — it deletes the host's kind cluster and
 * registry — so it is exercised manually per the README. These cases cover the
 * guard rails, which all stop BEFORE any mutating step, asserted by exit code
 * + diagnostic (nested guard) or by observing the abort (unconfirmed run).
 */

function onPath(bin: string): boolean {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => dir && existsSync(path.join(dir, bin)))
}

describe('yaac cluster delete (real CLI)', () => {
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
      'cluster', 'delete',
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/nested yaac session/)
    expect(stderr).toMatch(/outer yaac/)
  }, 30_000)

  it('accepts -y/--yes but the nested guard still refuses before any mutation', async () => {
    const { stderr, exitCode } = await runYaac(
      { ...testEnv.env, YAAC_NESTED: '1' },
      'cluster', 'delete', '--yes',
    )
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/nested yaac session/)
  }, 30_000)

  // Needs a real kind/podman pair (`kind get clusters` must succeed) and must
  // NOT be nested (the nested guard fires first). Without --yes and with no
  // TTY, the confirmation gate returns false, so the command aborts BEFORE
  // deleting the cluster or the registry — safe to run against the dev host.
  it.skipIf(IS_NESTED_YAAC || process.platform !== 'linux' || !onPath('kind') || !onPath('podman'))(
    'aborts without deleting when not confirmed (no --yes, non-interactive)',
    async () => {
      const env: NodeJS.ProcessEnv = { ...testEnv.env }
      delete env.YAAC_NESTED

      const { stdout, exitCode } = await runYaac(env, 'cluster', 'delete')
      expect(exitCode).toBe(0)
      expect(stdout).toMatch(/Aborted/)
      expect(stdout).not.toMatch(/Deleting kind cluster/)
      expect(stdout).not.toMatch(/Removing local registry/)
    },
    60_000,
  )
})
