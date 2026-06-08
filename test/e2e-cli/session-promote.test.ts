import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { requirePodman, podmanRetry } from '@test/helpers/setup'

/**
 * E2e coverage for the `yaac session promote <session-id>` debug command.
 *
 * The command routes through the daemon, which resolves the session's project
 * from its per-session graphroot volume labels, then runs the real
 * `promoteSessionImages` and streams its log lines back. Both cases here avoid
 * standing up a full nestedContainers session (slow + environment-gated): the
 * resolution and streaming paths are driven by hand-created labeled volumes,
 * and the promoter is exercised against an empty graphroot (a deterministic
 * "found 0 images" run that exits 0 on any host with the prebuilt nestable
 * image).
 */
describe('yaac session promote', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null
  let daemonEnv: NodeJS.ProcessEnv

  beforeAll(async () => {
    await requirePodman()
  })

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    daemonEnv = { ...testEnv.env }
    daemon = await spawnYaacDaemon(daemonEnv)
  })

  afterEach(async () => {
    if (daemon) await daemon.stop()
    daemon = null
    try {
      const { stdout } = await podmanRetry([
        'volume', 'ls', '--filter', `label=yaac.data-dir=${testEnv.dataDir}`,
        '--format', '{{.Name}}',
      ])
      const vols = stdout.split('\n').filter(Boolean)
      if (vols.length > 0) await podmanRetry(['volume', 'rm', '-f', ...vols])
    } catch { /* ok */ }
    await testEnv.cleanup()
  })

  it('errors cleanly when no graphroot volume exists for the session', async () => {
    const { exitCode, stdout, stderr } = await runYaac(
      daemonEnv, 'session', 'promote', 'does-not-exist',
    )
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toMatch(/No per-session graphroot volume/)
  })

  it('streams promoter output and exits 0 for a session with a graphroot volume', async () => {
    const sessionId = `promote-e2e-${Date.now()}`
    const slug = 'promote-e2e-proj'
    const graphroot = `yaac-podmanstorage-${sessionId}`
    const cache = `yaac-imagecache-${slug}`

    // The graphroot volume's labels are what the daemon resolves the session
    // from; create it (empty) plus the project-shared cache the promoter
    // writes into.
    await podmanRetry([
      'volume', 'create',
      '--label', 'yaac.podmanstorage=true',
      '--label', `yaac.data-dir=${testEnv.dataDir}`,
      '--label', `yaac.session-id=${sessionId}`,
      '--label', `yaac.project=${slug}`,
      graphroot,
    ])
    await podmanRetry([
      'volume', 'create',
      '--label', 'yaac.imagecache=true',
      '--label', `yaac.data-dir=${testEnv.dataDir}`,
      '--label', `yaac.project=${slug}`,
      cache,
    ])

    const { exitCode, stdout, stderr } = await runYaac(
      daemonEnv, 'session', 'promote', sessionId,
    )
    const out = stdout + stderr
    // The daemon's header line names the resolved project + image, and the
    // promoter streams its own `[promoter] ...` log lines.
    expect(out).toContain(`project "${slug}"`)
    expect(out).toContain('[promoter]')
    expect(out).toMatch(/found 0 image id\(s\)/)
    expect(exitCode).toBe(0)
  }, 120_000)
})
