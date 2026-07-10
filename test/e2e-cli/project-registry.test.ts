import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@yaac/server/lib/git'
import { listSessionPods, type SessionPod } from '@yaac/server/lib/k8s/pods'
import { k8sNamespace, kubectlGetJson, kubectlWithRetry } from '@yaac/server/lib/k8s/kubectl'
import {
  ensureProjectRegistry,
  gcOrphanProjectRegistries,
  projectRegistryHost,
  projectRegistryHostname,
  projectRegistryName,
  removeProjectRegistry,
} from '@yaac/server/lib/k8s/project-registry'
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
  IS_NESTED_YAAC,
} from '@yaac/test-utils/setup'
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '@yaac/test-utils/mock-remotes'

// The per-project registry test creates a virtualCluster session, which
// createSession refuses inside a nested yaac (no vcluster-in-vcluster).
describe.skipIf(IS_NESTED_YAAC)('yaac per-project registry (real CLI + real server + real cluster)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let serverEnv: NodeJS.ProcessEnv
  /** Slugs whose registries the test created — swept in afterEach. */
  const createdSlugs: string[] = []

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
    await seedMockGitRepo(mockGit!, slug, {
      files: { 'README.md': '# demo\n' },
    })
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
      JSON.stringify({ virtualCluster: true }, null, 2) + '\n',
    )
    createdSlugs.push(slug)
  }

  async function createSession(slug: string): Promise<SessionPod> {
    const { stdout, stderr, exitCode } = await runYaac(
      serverEnv, 'session', 'create', slug, '--tool', 'claude',
    )
    if (exitCode !== 0) {
      throw new Error(`session create failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    const pods = (await listSessionPods(slug)).sort((a, b) => a.createdAtMs - b.createdAtMs)
    if (!pods[0]) throw new Error(`no session pod found for project ${slug}`)
    return pods[0]
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
    for (const slug of createdSlugs.splice(0)) {
      await removeProjectRegistry(slug).catch(() => { /* already gone */ })
    }
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  it('provisions the registry; sessions push by svc name; the node pulls via hosts.toml; persists and GCs', async () => {
    const slug = 'vc-registry'
    await setupProject(slug)
    const session = await createSession(slug)
    const name = session.jobName

    const regName = projectRegistryName(slug)
    const regHost = projectRegistryHost(slug)

    // --- Appears, with an allocator-assigned (no longer pinned) ClusterIP ---
    const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
      'get', 'service', regName, '-n', k8sNamespace(),
    ])
    const regVip = svc?.spec?.clusterIP
    expect(regVip).toBeTruthy()

    // The proxy's split-horizon DNS forwards `*.svc` to cluster DNS, so the
    // registry name resolves to its live ClusterIP from inside the session —
    // no hostAliases, no pin.
    const { stdout: hostsOut } = await execInJob(name, [
      'getent', 'hosts', projectRegistryHostname(slug),
    ])
    expect(hostsOut).toContain(regVip)

    // The per-project sessions NetworkPolicy is the SOLE hole through the
    // session-egress CNP's default-deny (no blanket in-cluster allowance
    // anymore): plain-HTTP :5000 answers from inside the session.
    const { stdout: ping } = await execInJob(name, [
      'sh', '-c', `curl -fsS --max-time 5 http://${regHost}/v2/ >/dev/null && echo REG_OK`,
    ], { timeout: 30_000 })
    expect(ping).toContain('REG_OK')

    // --- Cross-project isolation (issue #17) ---
    // Stand up a SECOND project's registry (no session needed) and assert
    // this project's session cannot reach it: nothing admits the flow —
    // the session-egress CNP has no in-cluster allowance, the other
    // project's sessions NetworkPolicy does not select this pod, and the
    // other registry's ingress CNP does not admit it. curl must time out
    // (policy drop), not answer.
    const otherSlug = 'vc-registry-other'
    createdSlugs.push(otherSlug)
    await ensureProjectRegistry(otherSlug)
    const { stdout: cross } = await execInJob(name, [
      'sh', '-c',
      `curl -sS --max-time 5 http://${projectRegistryHost(otherSlug)}/v2/ >/dev/null 2>&1`
      + ' && echo CROSS_REACHED || echo CROSS_BLOCKED',
    ], { timeout: 30_000 })
    expect(cross).toContain('CROSS_BLOCKED')

    // The insecure drop-in scopes plain-HTTP trust to exactly this host.
    const { stdout: conf } = await execInJob(name, [
      'cat', '/home/yaac/.config/containers/registries.conf.d/yaac-project-registry.conf',
    ])
    expect(conf).toContain(`location = "${regHost}"`)
    expect(conf).toContain('insecure = true')

    // --- Push from the session by svc name ---
    // The registry is already project-scoped, so the ref needs no
    // per-project repo prefix — push straight to <host>/probe:v1.
    await execInJob(name, [
      'sh', '-c',
      'mkdir -p /tmp/p && cd /tmp/p && '
      + 'echo reg-probe > marker && '
      + 'printf "FROM scratch\\nCOPY marker /marker\\n" > Dockerfile && '
      + `docker build -t ${regHost}/probe:v1 . && `
      + `docker push ${regHost}/probe:v1`,
    ], { timeout: 240_000 })
    const { stdout: tags } = await execInJob(name, [
      'sh', '-c', `curl -fsS --max-time 5 http://${regHost}/v2/probe/tags/list`,
    ], { timeout: 30_000 })
    expect((JSON.parse(tags) as { tags: string[] }).tags).toContain('v1')

    // --- Node containerd pulls the pushed ref via hosts.toml ---
    // The image is FROM scratch (no entrypoint), so a SUCCESSFUL pull
    // ends in a container-create error — what this asserts is that the
    // pull itself never fails (ErrImagePull would mean the node could
    // not resolve the svc host to the pinned-VIP URL).
    const podName = `reg-pull-probe-${crypto.randomBytes(3).toString('hex')}`
    await kubectlWithRetry([
      'run', podName, `--image=${regHost}/probe:v1`,
      '--restart=Never', '-n', k8sNamespace(),
    ])
    try {
      interface PodStatus {
        status?: {
          containerStatuses?: Array<{
            state?: {
              waiting?: { reason?: string }
              terminated?: object
            }
          }>
        }
      }
      const deadline = Date.now() + 120_000
      let verdict = ''
      while (Date.now() < deadline && !verdict) {
        const pod = await kubectlGetJson<PodStatus>([
          'get', 'pod', podName, '-n', k8sNamespace(),
        ])
        const state = pod?.status?.containerStatuses?.[0]?.state
        const waiting = state?.waiting?.reason ?? ''
        if (waiting === 'ErrImagePull' || waiting === 'ImagePullBackOff') {
          verdict = 'PULL_FAILED'
        } else if (
          state?.terminated
          || ['CreateContainerError', 'RunContainerError', 'CrashLoopBackOff'].includes(waiting)
        ) {
          verdict = 'PULLED'
        } else {
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
      expect(verdict).toBe('PULLED')
    } finally {
      await kubectlWithRetry([
        'delete', 'pod', podName, '-n', k8sNamespace(), '--ignore-not-found', '--grace-period=1',
      ]).catch(() => { /* best-effort */ })
    }

    // --- Persists across session delete (per-project, not per-session) ---
    const { exitCode: delExit } = await runYaac(serverEnv, 'session', 'delete', session.sessionId)
    expect(delExit).toBe(0)
    const depAfterDelete = await kubectlGetJson<{ metadata?: { name?: string } }>([
      'get', 'deployment', regName, '-n', k8sNamespace(),
    ])
    expect(depAfterDelete?.metadata?.name).toBe(regName)

    // --- GCs once the project dir is gone (server-start sweep) ---
    await fs.rm(path.join(testEnv.dataDir, 'projects', slug), { recursive: true, force: true })
    await gcOrphanProjectRegistries()
    const svcAfterGc = await kubectlGetJson<{ metadata?: { name?: string } }>([
      'get', 'service', regName, '-n', k8sNamespace(),
    ])
    expect(svcAfterGc).toBeNull()
    const depAfterGc = await kubectlGetJson<{ metadata?: { name?: string } }>([
      'get', 'deployment', regName, '-n', k8sNamespace(),
    ])
    expect(depAfterGc).toBeNull()
  }, 900_000)
})
