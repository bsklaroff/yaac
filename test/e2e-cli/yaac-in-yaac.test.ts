import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@yaac/server/lib/git'
import { listSessionPods, type SessionPod } from '@yaac/server/lib/k8s/pods'
import { removeSessionVcluster, vclusterName } from '@yaac/server/lib/k8s/vcluster'
import { removeProjectRegistry } from '@yaac/server/lib/k8s/project-registry'
import { PACKAGE_ROOT } from '@yaac/shared/project-paths'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import {
  requirePodman,
  requireCluster,
  execInJob,
  cleanupSessionJobs,
} from '@yaac/test-utils/setup'
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '@yaac/test-utils/mock-remotes'

/**
 * yaac-in-yaac smoke: run yaac's own CLI inside a vcluster session
 * against the session's virtual cluster. Env-gated — the in-session
 * `pnpm install` alone pulls yaac's full dependency tree through the
 * MITM proxy (many minutes), so this never runs in a default sweep:
 *
 *   YAAC_E2E_NESTED_YAAC=1 pnpm vitest run test/e2e-cli/yaac-in-yaac.test.ts
 *
 * Covered: the yaac-in-yaac env preset (YAAC_NESTED / YAAC_DATA_DIR /
 * YAAC_K8S_REGISTRY) and inner `yaac cluster check` — which itself
 * exercises the prefix-host registry path, an inner probe pod synced to
 * the host (registry pull + hostPath write under the VAP guard), and
 * inner NetworkPolicy enforcement via host Cilium. Inner session create
 * is deliberately NOT exercised here: it would build the full session
 * image chain with the in-pod podman (apt + node + agent installers
 * through the proxy — tens of minutes more); run it manually when
 * needed. The vcluster-in-vcluster refusal is asserted, cheaply, from
 * the inner CLI's env gate.
 */
describe.skipIf(process.env.YAAC_E2E_NESTED_YAAC !== '1')(
  'yaac-in-yaac (env-gated smoke)', () => {
    let testEnv: YaacTestEnv
    let server: SpawnedServer | null = null
    let mockLLM: MockLLM | null = null
    let mockGit: MockGit | null = null
    let serverEnv: NodeJS.ProcessEnv
    const createdSlugs: string[] = []
    const createdVclusters: string[] = []

    beforeAll(async () => {
      await requirePodman()
      await requireCluster()
    })

    async function seedCredentials(): Promise<void> {
      const credsDir = path.join(testEnv.dataDir, '.credentials')
      await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
      await fs.writeFile(path.join(credsDir, 'github.json'), JSON.stringify({
        tokens: [{ pattern: 'test-org/*', token: 'fake-ghp-token' }],
      }) + '\n')
      await fs.writeFile(path.join(credsDir, 'claude.json'), JSON.stringify({
        kind: 'api-key',
        savedAt: new Date().toISOString(),
        apiKey: 'sk-ant-fake-real-key',
      }) + '\n')
    }

    async function setupProject(slug: string): Promise<void> {
      await seedMockGitRepo(mockGit!, slug, { files: { 'README.md': '# demo\n' } })
      const projectPath = path.join(testEnv.dataDir, 'projects', slug)
      const repoPath = path.join(projectPath, 'repo')
      await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
      await cloneRepo(path.join(mockGit!.reposDir, `${slug}.git`), repoPath, null)
      const fakeRemote = `https://github.com/test-org/${slug}.git`
      await simpleGit(repoPath).remote(['set-url', 'origin', fakeRemote])
      await fs.writeFile(path.join(projectPath, 'project.json'), JSON.stringify({
        slug, remoteUrl: fakeRemote, addedAt: new Date().toISOString(),
      }) + '\n')
      const configDir = path.join(projectPath, 'config')
      await fs.mkdir(configDir, { recursive: true })
      await fs.writeFile(
        path.join(configDir, 'yaac-config.json'),
        JSON.stringify({
          virtualCluster: true,
          // The outer yaac source, read-only — the smoke copies it into
          // the workspace and installs deps there (linux binaries).
          bindMounts: [
            { hostPath: PACKAGE_ROOT, containerPath: '/yaac-src', mode: 'ro' },
          ],
        }, null, 2) + '\n',
      )
      createdSlugs.push(slug)
    }

    beforeEach(async () => {
      testEnv = await createYaacTestEnv()
      await seedCredentials()
      await fs.writeFile(
        testEnv.gitConfigPath,
        '[user]\n\tname = Test User\n\temail = test@example.com\n',
      )
      mockLLM = await startMockLLM()
      mockGit = await startMockGit()
      const llmTarget = { host: mockLLM.host, port: mockLLM.port, tls: false }
      const gitTarget = { host: mockGit.host, port: mockGit.port, tls: false }
      serverEnv = {
        ...testEnv.env,
        YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify({
          'github.com': gitTarget,
          'api.github.com': gitTarget,
          'api.anthropic.com': llmTarget,
        }),
        YAAC_E2E_SKIP_FETCH: '1',
        YAAC_E2E_NO_ATTACH: '1',
      }
      server = await spawnYaacServer(serverEnv)
    })

    afterEach(async () => {
      if (server) await server.stop()
      server = null
      await cleanupSessionJobs()
      for (const name of createdVclusters.splice(0)) {
        await removeSessionVcluster(name).catch(() => { /* gone */ })
      }
      for (const slug of createdSlugs.splice(0)) {
        await removeProjectRegistry(slug).catch(() => { /* gone */ })
      }
      await cleanupMocks([mockLLM, mockGit])
      mockLLM = null
      mockGit = null
      await testEnv.cleanup()
    })

    it('inner yaac cluster check passes against the vcluster', async () => {
      const slug = 'yaac-in-yaac'
      await setupProject(slug)
      const { stdout, stderr, exitCode } = await runYaac(
        serverEnv, 'session', 'create', slug, '--tool', 'claude',
      )
      if (exitCode !== 0) {
        throw new Error(`session create failed\n${stdout}\n${stderr}`)
      }
      const pods: SessionPod[] = await listSessionPods(slug)
      const session = pods[0]
      createdVclusters.push(vclusterName(session.sessionId))
      const name = session.jobName

      // The preset is in place.
      const { stdout: envOut } = await execInJob(name, [
        'sh', '-c', 'echo "$YAAC_NESTED|$YAAC_DATA_DIR|$YAAC_K8S_REGISTRY"',
      ])
      // YAAC_K8S_REGISTRY is the project registry host:port, no path prefix
      // (projectRegistryHost — the registry is already project-scoped).
      expect(envOut).toMatch(/^1\|\/.*nested-yaac\|yaac-reg-.*\.svc:5000\s*$/)

      // Copy the source in and install deps (linux natives) through the
      // proxy — registry.npmjs.org is on the default allowlist.
      await execInJob(name, [
        'sh', '-c',
        // Unanchored excludes: the workspace layout nests node_modules (and
        // apps/frontend/dist) below the root, not just at it.
        'mkdir -p /tmp/yaac && tar -C /yaac-src '
        + '--exclude node_modules --exclude dist --exclude .git '
        + '-cf - . | tar -C /tmp/yaac -xf -',
      ], { timeout: 300_000, maxAttempts: 1 })
      await execInJob(name, [
        'sh', '-c', 'cd /tmp/yaac && pnpm install --frozen-lockfile 2>&1 | tail -5',
      ], { timeout: 1_800_000, maxAttempts: 1 })

      // Inner cluster check: the inner server-free preflight against the
      // vcluster. The probe builds nothing — it pushes busybox through the
      // in-pod podman to the project registry and runs a synced probe pod
      // from it under the VAP guard. The egress / envoy-config / nested-mount
      // / vap gates self-skip under YAAC_NESTED (egress is enforced
      // host-side, the rest have no in-vcluster equivalent).
      const { stdout: checkOut } = await execInJob(name, [
        'sh', '-c', 'cd /tmp/yaac && node_modules/.bin/tsx apps/cli/src/cli.ts cluster check 2>&1; echo "EXIT:$?"',
      ], { timeout: 900_000, maxAttempts: 1 })
      expect(checkOut).toContain('✓ cluster')
      expect(checkOut).toContain('✓ registry')
      expect(checkOut).toContain('✓ namespace')
      expect(checkOut).toContain('✓ probe')
      expect(checkOut).toContain('- egress')
      expect(checkOut).toMatch(/EXIT:0/)

      // (The vcluster-in-vcluster refusal is pinned by a unit test on
      // createSession — it is a pure env gate, no cluster needed.)
      await runYaac(serverEnv, 'session', 'delete', session.sessionId)
    }, 3_600_000)
  },
)
