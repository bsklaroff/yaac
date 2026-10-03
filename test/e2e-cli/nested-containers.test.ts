import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { git } from '@yaac/test-utils/git'
import { cloneRepo } from '@yaac/server/domain/git'
import { listWorkspacePods, type PodInfo } from '@yaac/server/drivers/k8s/substrate/pods'
import { deleteObject, k8sNamespace, listObjects, readObject } from '@yaac/server/drivers/k8s/substrate/api'
import { kubectl } from '@yaac/test-utils/kubectl'
import {
  ORPHAN_REGISTRY_MIN_AGE_MS,
  ensureProjectRegistry,
  gcOrphanProjectRegistries,
  projectRegistryHost,
  projectRegistryHostname,
  projectRegistryName,
  removeProjectRegistry,
} from '@yaac/server/drivers/k8s/cluster/project-registry'
import { DONE_MARKER } from '@yaac/server/drivers/k8s/images/store-writer'
import { nodeLocalHostPath } from '@yaac/server/drivers/k8s/substrate/mount-sources'
import { imageStoreDir } from '@yaac/shared/project-paths'
import { serverLogPath } from '@yaac/shared/paths'
import {
  createYaacTestEnv,
  spawnYaacServer,
  setTestGitIdentity,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { assignTestGitCredential, makeServerApiClient, registerTestProject } from '@yaac/test-utils/api'
import {
  requirePodman,
  requireCluster,
  execInJob,
  cleanupWorkspaceJobs,
  testContainerOwnerLabel,
} from '@yaac/test-utils/setup'
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '@yaac/test-utils/mock-remotes'

const execFileAsync = promisify(execFile)

const UPSTREAM_REGISTRY_PORT = 5000
/** The busybox image the mock upstream serves. */
const UPSTREAM_IMAGE_REF = 'docker.io/library/probe-busybox:1'
const BUSYBOX_SOURCE = 'docker.io/library/busybox:1.36'

interface MockUpstreamRegistry {
  /** kind-network IP, the proxy's upstream-redirect target. */
  host: string
  port: number
  stop: () => Promise<void>
}

/**
 * Stand-in for registry-1.docker.io: a registry:2 podman container on the
 * kind network, seeded with busybox through its published loopback port.
 * The proxy's upstream redirects send registry-1.docker.io here, so an
 * in-workspace `docker pull` takes the real egress and allowlist path
 * without the internet. registry:2 needs no auth, so auth.docker.io is
 * never called.
 *
 * It is a host container rather than a pod because `podman push` may run
 * inside a podman machine VM, which can reach a published container port
 * but not a host-side port-forward.
 */
async function startMockUpstreamRegistry(): Promise<MockUpstreamRegistry> {
  // Usually present already (the local registry runs it). The owner label
  // lets the global setup sweep a leaked container.
  try {
    await execFileAsync('podman', ['image', 'inspect', 'docker.io/library/registry:2'])
  } catch {
    await execFileAsync('podman', ['pull', 'docker.io/library/registry:2'], { timeout: 120_000 })
  }
  await execFileAsync('podman', ['tag', 'docker.io/library/registry:2', 'yaac-test-upstream-registry:2'])

  const name = `yaac-test-mock-upstream-${crypto.randomBytes(4).toString('hex')}`
  await execFileAsync('podman', [
    'run', '-d', '--name', name,
    '--label', testContainerOwnerLabel(),
    '--network', 'kind',
    '-p', '127.0.0.1::5000',
    'yaac-test-upstream-registry:2',
  ])
  const stop = async (): Promise<void> => {
    await execFileAsync('podman', ['rm', '-f', '--ignore', name]).catch(() => { /* gone */ })
  }

  try {
    const { stdout: portOut } = await execFileAsync('podman', ['port', name, '5000/tcp'])
    const hostPort = Number(/:(\d+)\s*$/m.exec(portOut.trim())?.[1])
    if (!hostPort) throw new Error(`could not parse published port from "${portOut}"`)
    const { stdout: ipOut } = await execFileAsync('podman', [
      'inspect', name, '--format', '{{(index .NetworkSettings.Networks "kind").IPAddress}}',
    ])
    const networkIp = ipOut.trim()
    if (!networkIp) throw new Error('mock upstream registry has no kind-network IP')

    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${hostPort}/v2/`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) break
      } catch { /* registry still starting */ }
      if (i === 39) throw new Error('mock upstream registry never answered /v2/')
      await new Promise((r) => setTimeout(r, 250))
    }

    try {
      await execFileAsync('podman', ['image', 'inspect', BUSYBOX_SOURCE])
    } catch {
      await execFileAsync('podman', ['pull', BUSYBOX_SOURCE], { timeout: 120_000 })
    }
    await execFileAsync('podman', [
      'push', '--tls-verify=false', BUSYBOX_SOURCE,
      `127.0.0.1:${hostPort}/library/probe-busybox:1`,
    ], { timeout: 120_000 })

    return { host: networkIp, port: UPSTREAM_REGISTRY_PORT, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

describe('yaac nested containers (real CLI + real server + real cluster)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let mockRegistry: MockUpstreamRegistry | null = null
  let serverEnv: NodeJS.ProcessEnv
  /**
   * One nested-containers workspace shared by the network, registry and
   * CA-bundle cases. The layer-cache case creates its own, since it asserts
   * on what survives a workspace stop.
   */
  let sharedJob = ''
  let sharedSessionId = ''
  /** The shared project's id, read off its pod's `yaac.project-id` label. */
  let sharedProjectId = ''
  /** A registry stood up for an id no project holds (the isolation test). */
  let orphanRegistryId = ''
  /** Project ids a registry was created for, swept in afterAll. */
  const createdRegistries: string[] = []

  async function seedCredentials(): Promise<void> {
    const credsDir = path.join(testEnv.dataDir, 'server-local', '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(credsDir, 'claude.json'), JSON.stringify({
      kind: 'api-key',
      savedAt: new Date().toISOString(),
      apiKey: 'sk-ant-fake-real-key',
    }) + '\n')
  }

  /** `seeded`: the mock remote already holds the repo (a re-add). */
  async function setupProject(slug: string, opts: { seeded?: boolean } = {}): Promise<void> {
    if (!opts.seeded) {
      await seedMockGitRepo(mockGit!, slug, {
        files: { 'README.md': '# demo\n' },
      })
    }
    const projectPath = path.join(testEnv.dataDir, 'global', 'projects', slug)
    const repoPath = path.join(projectPath, 'repo')
    await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit!.reposDir, `${slug}.git`), repoPath, null)
    const fakeRemote = `https://github.com/test-org/${slug}.git`
    await git(repoPath, ['remote', 'set-url', 'origin', fakeRemote])
    await registerTestProject(server!, slug, fakeRemote)
    // The first add's credential outlives the project, so a re-add needs a
    // new name.
    await assignTestGitCredential(
      server!, slug, 'fake-ghp-token', opts.seeded ? `${slug} token (re-add)` : undefined,
    )
    const configDir = path.join(projectPath, 'config')
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(
      path.join(configDir, 'yaac-config.json'),
      JSON.stringify({ nestedContainers: true }, null, 2) + '\n',
    )
  }

  async function findWorkspacePod(slug: string, exclude: Set<string> = new Set()): Promise<PodInfo> {
    const pods = (await listWorkspacePods(slug))
      .filter((p) => !exclude.has(p.workspaceId))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
    if (!pods[0]) throw new Error(`no session pod found for project ${slug}`)
    return pods[0]
  }

  async function createWorkspace(slug: string): Promise<PodInfo> {
    const { stdout, stderr, exitCode } = await runYaac(
      serverEnv, 'workspace', 'create', slug, '--tool', 'claude',
    )
    if (exitCode !== 0) {
      throw new Error(`session create failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    const pod = await findWorkspacePod(slug)
    if (!pod.projectId) throw new Error(`session pod ${pod.jobName} carries no project id`)
    createdRegistries.push(pod.projectId)
    return pod
  }

  /** Wait for the detached cleanup (image salvage, then job delete) to finish. */
  async function waitForJobGone(jobName: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const job = await readObject({ apiVersion: 'batch/v1', kind: 'Job', name: jobName, namespace: k8sNamespace() })
      if (!job) return
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`job ${jobName} still exists after ${timeoutMs}ms`)
  }

  // One server, mock set and upstream registry for the whole file.
  beforeAll(async () => {
    await requirePodman()
    await requireCluster()

    testEnv = await createYaacTestEnv()
    await seedCredentials()
    mockLLM = await startMockLLM()
    mockGit = await startMockGit()
    mockRegistry = await startMockUpstreamRegistry()

    const llmTarget = { host: mockLLM.host, port: mockLLM.port, tls: false }
    const gitTarget = { host: mockGit.host, port: mockGit.port, tls: false }
    const registryTarget = { host: mockRegistry.host, port: mockRegistry.port, tls: false }
    serverEnv = {
      ...testEnv.env,
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify({
        'github.com': gitTarget,
        'api.github.com': gitTarget,
        'api.anthropic.com': llmTarget,
        'registry-1.docker.io': registryTarget,
      }),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
    }
    server = await spawnYaacServer(serverEnv)
    await setTestGitIdentity(serverEnv)

    await setupProject('nested-shared')
    const shared = await createWorkspace('nested-shared')
    sharedJob = shared.jobName
    sharedSessionId = shared.workspaceId
    sharedProjectId = shared.projectId
  }, 900_000)

  afterAll(async () => {
    if (sharedSessionId) {
      await runYaac(serverEnv, 'workspace', 'stop', sharedSessionId).catch(() => { /* best-effort */ })
    }
    if (server) await server.stop()
    server = null
    await cleanupWorkspaceJobs()
    for (const id of createdRegistries.splice(0)) {
      await removeProjectRegistry(id).catch(() => { /* already gone */ })
    }
    await cleanupMocks([mockLLM, mockGit, mockRegistry])
    mockLLM = null
    mockGit = null
    mockRegistry = null
    await testEnv.cleanup()
  }, 300_000)

  /**
   * Wait until every node has a complete image-store generation for the
   * project (a `gen-*` dir with the writer pod's DONE marker). A new pod
   * mounts only a complete generation, and the next workspace may land on
   * any node. The store is node-local and not bound to the host, so it is
   * read with `podman exec` on the kind node container.
   */
  async function waitForStoreGeneration(projectId: string, timeoutMs: number): Promise<void> {
    const parent = nodeLocalHostPath(imageStoreDir(projectId))
    const nodes = (await listObjects<{ metadata: { name: string } }>('v1', 'Node')).map((n) => n.metadata.name)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pending: string[] = []
      for (const node of nodes) {
        const complete = await execFileAsync('podman', [
          'exec', node, 'sh', '-c', `ls -d ${parent}/*/${DONE_MARKER} 2>/dev/null | head -1`,
        ]).then(({ stdout }) => stdout.trim() !== '', () => false)
        if (!complete) pending.push(node)
      }
      if (pending.length === 0) return
      if (Date.now() > deadline) {
        throw new Error(`no complete image-store generation under ${parent} on ${pending.join(', ')} within ${timeoutMs}ms`)
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  /**
   * Failure diagnostics for a workspace whose engine cannot see the store,
   * captured now because the cluster is gone by the time anyone reads
   * them: pod placement, each node's store generations, the workspace's
   * mounts, and the server's store and prewarm log lines.
   */
  async function podPlacement(job: string): Promise<string> {
    const pods = await listObjects<{ metadata: { name: string; labels?: Record<string, string> }; spec: { nodeName?: string } }>(
      'v1', 'Pod', { namespace: k8sNamespace(), labelSelector: `job-name=${job}` },
    ).catch(() => [])
    const pod = pods.at(0)
    const prewarm = Object.entries(pod?.metadata.labels ?? {}).filter(([k]) => /prewarm|spare/.test(k))
    return `${job}: pod ${pod?.metadata.name ?? '?'} on ${pod?.spec.nodeName ?? '?'}`
      + `${prewarm.length ? ` (${prewarm.map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`
  }

  async function storeDiagnosis(placements: string[], last: string, projectId: string): Promise<string> {
    const lines = [...placements, await podPlacement(last)]
    const parent = nodeLocalHostPath(imageStoreDir(projectId))
    const nodes = (await listObjects<{ metadata: { name: string } }>('v1', 'Node').catch(() => []))
      .map((n) => n.metadata.name)
    for (const node of nodes) {
      const { stdout } = await execFileAsync('podman', ['exec', node, 'sh', '-c', `ls -la --time-style=+%T ${parent}/ ${parent}/*/ 2>&1`])
        .catch((err: unknown) => ({ stdout: String(err) }))
      lines.push(`--- ${node}: ${parent}\n${stdout.trim()}`)
    }
    const { stdout: mounts } = await execInJob(last, ['sh', '-c', 'grep shared-images /proc/mounts; ls -la /var/lib/shared-images 2>&1 | head -20'])
      .catch((err: unknown) => ({ stdout: String(err) }))
    lines.push(`--- ${last}: shared-images\n${mounts.trim()}`)
    const log = await fs.readFile(serverLogPath(), 'utf8').catch(() => '')
    lines.push(`--- server log (store, prewarm, salvage):\n${log.split('\n')
      .filter((l) => /image-store|prewarm|salvage|claim/i.test(l)).slice(-60).join('\n')}`)
    return lines.join('\n')
  }

  it('builds with in-pod podman and reuses layers across sessions via the project registry', async () => {
    const slug = 'nested-cache'
    await setupProject(slug)

    const session1 = await createWorkspace(slug)
    const name1 = session1.jobName

    // The docker CLI talks to the rootful in-pod podman, the engine uses
    // the node-local image store (a cache of the project registry) as a
    // read-only store, and the project registry is configured as plain
    // HTTP.
    const { stdout: dockerVer } = await execInJob(name1, ['docker', 'version'], { timeout: 30_000 })
    expect(dockerVer.toLowerCase()).toContain('podman')
    const { stdout: storageConf } = await execInJob(name1, [
      'cat', '/etc/containers/storage.conf',
    ])
    expect(storageConf).toContain('additionalimagestores = ["/var/lib/shared-images"]')
    const { stdout: regConf } = await execInJob(name1, [
      'cat', '/etc/containers/registries.conf.d/yaac-project-registry.conf',
    ])
    const registryHost = /location = "([^"]+)"/.exec(regConf)?.[1] ?? ''
    // Named by project id, not slug.
    expect(registryHost.startsWith(`yaac-reg-${session1.projectId}.`), registryHost).toBe(true)
    expect(registryHost.endsWith(':5000'), registryHost).toBe(true)
    expect(regConf).toContain('insecure = true')

    // The rootful graphroot (/var/lib/containers) is writable by root.
    const { stdout: graphProbe } = await execInJob(name1, [
      'sh', '-c',
      'sudo sh -c "echo probe > /var/lib/containers/.yaac-write-probe" && echo WRITABLE',
    ])
    expect(graphProbe.trim()).toBe('WRITABLE')

    // A two-step FROM scratch build, so it leaves an intermediate image
    // that a later divergent build can reuse if the salvage kept it.
    const buildProbe = (tag: string, lastStep: string): string =>
      'mkdir -p /tmp/b && cd /tmp/b && '
      + 'echo cache-payload > marker && '
      + `printf "FROM scratch\\nCOPY marker /marker\\nCOPY marker /${lastStep}\\n" > Dockerfile && `
      + `docker build -t ${tag} .`
    await execInJob(name1, ['sh', '-c', buildProbe('yaac-cache-probe:v1', 'marker2')], {
      timeout: 120_000,
    })
    const inspect = async (job: string, ref: string, field: string): Promise<string> => {
      const { stdout } = await execInJob(job, [
        'sh', '-c', `docker image inspect --format "{{.${field}}}" ${ref} 2>&1 || echo MISSING`,
      ])
      return stdout.trim()
    }
    const imageId1 = await inspect(name1, 'yaac-cache-probe:v1', 'Id')
    const parentId1 = await inspect(name1, 'yaac-cache-probe:v1', 'Parent')
    // diff_ids digest the uncompressed layers, so recompression cannot
    // change them, and podman's build cache matches on them.
    const layers1 = await inspect(name1, 'yaac-cache-probe:v1', 'RootFS.Layers')
    expect(layers1).toMatch(/sha256:[0-9a-f]{64}/)
    // Real ids, including a non-empty parent, so the comparisons below are
    // not vacuous.
    expect(imageId1).toMatch(/^(sha256:)?[0-9a-f]{64}$/)
    expect(parentId1).toMatch(/^(sha256:)?[0-9a-f]{64}$/)

    // Stopping runs the image salvage (push to the project registry), then
    // deletes the job. Record placement first for diagnostics.
    const session1Placement = await podPlacement(name1)
    const { exitCode: delExit } = await runYaac(serverEnv, 'workspace', 'stop', session1.workspaceId)
    expect(delExit).toBe(0)
    await waitForJobGone(name1, 300_000)

    // The salvage triggers a store rebuild. Create never waits for it, so
    // the test does.
    await waitForStoreGeneration(session1.projectId, 600_000)

    const session2 = await createWorkspace(slug)
    expect(session2.workspaceId).not.toBe(session1.workspaceId)

    // The store is read-only even to in-pod root. gVisor's gofer enforces
    // that outside the sandbox, protecting a store every workspace on the
    // node shares. Probed on workspace 2, since workspace 1 had no store.
    const { stdout: roProbe } = await execInJob(session2.jobName, [
      'sh', '-c', 'sudo touch /var/lib/shared-images/probe 2>&1 || echo READ-ONLY',
    ])
    expect(roProbe).toContain('READ-ONLY')

    // The salvaged image is in the project registry, with its ancestors
    // under `yaac-cache-<tag>-<n>` tags in the same repo.
    const { stdout: catalog } = await execInJob(session2.jobName, [
      'sh', '-c', `curl -fsS --max-time 20 http://${registryHost}/v2/_catalog`,
    ], { timeout: 30_000 })
    // Exactly one repo, named as the engine knows the image. docker
    // resolves an unqualified tag to docker.io (Dockerfile.nestable's
    // unqualified-search-registries), and the salvage keeps that name so
    // it resolves again in workspace 2. A second alias repo would share no
    // layer blobs with the first.
    const probeRepos = (JSON.parse(catalog) as { repositories: string[] })
      .repositories.filter((r) => r.endsWith('yaac-cache-probe'))
    expect(probeRepos).toEqual(['docker.io/library/yaac-cache-probe'])
    const probeRepo = probeRepos[0]
    const { stdout: tags } = await execInJob(session2.jobName, [
      'sh', '-c',
      `curl -fsS --max-time 20 http://${registryHost}/v2/${probeRepo}/tags/list`,
    ], { timeout: 30_000 })
    expect(tags).toContain('"v1"')
    expect(tags).toContain('"yaac-cache-v1-1"')

    // Workspace 2's engine sees the same image by name, with the same
    // layers.
    const s2Id = await inspect(session2.jobName, 'yaac-cache-probe:v1', 'Id')
    if (!/^(sha256:)?[0-9a-f]{64}$/.test(s2Id)) {
      throw new Error(`session 2 cannot resolve yaac-cache-probe:v1 (${s2Id})\n`
        + await storeDiagnosis([session1Placement], session2.jobName, session2.projectId))
    }
    const s2Parent = await inspect(session2.jobName, 'yaac-cache-probe:v1', 'Parent')
    expect(await inspect(session2.jobName, 'yaac-cache-probe:v1', 'RootFS.Layers')).toBe(layers1)
    // Identical image and parent ids: the salvage must not rewrite the
    // image. Forcing a compression the manifest type cannot express (see
    // SALVAGE_COMPRESSION) would change its type, and buildah would then
    // stop matching it as a cache candidate.
    expect(s2Id).toBe(imageId1)
    expect(s2Parent).toBe(parentId1)

    // An identical rebuild must reuse the salvaged layers. Check "Using
    // cache", since a re-run COPY yields the same ids anyway.
    const { stdout: v2Out } = await execInJob(session2.jobName, ['sh', '-c',
      buildProbe('yaac-cache-probe:v2', 'marker2') + ' 2>&1'], { timeout: 120_000 })
    expect(v2Out, `identical rebuild re-ran its steps:\n${v2Out}`).toContain('Using cache')

    // A build that diverges at the last step still reuses the shared
    // prefix from the salvaged ancestor (`yaac-cache-v1-1`).
    const { stdout: v3Out } = await execInJob(session2.jobName, ['sh', '-c',
      buildProbe('yaac-cache-probe:v3', 'marker3') + ' 2>&1'], { timeout: 120_000 })
    expect(v3Out, `divergent rebuild reused no prefix:\n${v3Out}`).toContain('Using cache')
    expect(await inspect(session2.jobName, 'yaac-cache-probe:v3', 'Parent')).toBe(s2Parent)

    await runYaac(serverEnv, 'workspace', 'stop', session2.workspaceId)
  }, 900_000)

  it('pulls through the proxy, serves on localhost, runs compose builds, and denies non-allowlisted pulls', async () => {
    const name = sharedJob
    // Poll until the container has bound its port.
    const curlUntil = async (url: string): Promise<string> => {
      for (let i = 0; i < 40; i++) {
        try {
          const { stdout } = await execInJob(name, [
            'sh', '-c', `curl -fsS --max-time 2 ${url}`,
          ], { timeout: 10_000 })
          return stdout
        } catch {
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      return ''
    }

    // Allowlisted pull: registry-1.docker.io goes through the egress
    // redirect to the proxy, which checks the allowlist (extended for
    // nested workspaces), MITMs it (the engine trusts the proxy CA via
    // SSL_CERT_FILE), and forwards to the mock registry.
    await execInJob(name, [
      'sh', '-c', `docker pull ${UPSTREAM_IMAGE_REF}`,
    ], { timeout: 180_000 })

    // Nested containers share the pod's network namespace, so their DNS
    // and egress go through the proxy too:
    //  (a) external names resolve to the proxy's DNS sinkhole address.
    const { stdout: nestedDns } = await execInJob(name, [
      'sh', '-c',
      `docker run --rm ${UPSTREAM_IMAGE_REF} nslookup registry-1.docker.io 2>&1 `
      + '| grep -c 198.18.0.1 || true',
    ], { timeout: 120_000 })
    expect(Number(nestedDns.trim())).toBeGreaterThan(0)
    //  (b) a TCP connect to an allowlisted host:443 succeeds.
    const { stdout: nestedTcp } = await execInJob(name, [
      'sh', '-c',
      `docker run --rm ${UPSTREAM_IMAGE_REF} `
      + `sh -c 'nc -w 5 -z registry-1.docker.io 443 && echo NESTED_NET_OK || echo NESTED_NET_FAIL'`,
    ], { timeout: 120_000 })
    expect(nestedTcp).toContain('NESTED_NET_OK')
    //  (c) plain HTTP to a non-allowlisted host gets the proxy's 403
    //      (HTTP so busybox needs no TLS).
    const { stdout: nestedBlocked } = await execInJob(name, [
      'sh', '-c',
      `docker run --rm ${UPSTREAM_IMAGE_REF} `
      + `sh -c 'wget -S -O /dev/null -T 8 http://example.com/ 2>&1 | grep -c " 403 " || true'`,
    ], { timeout: 120_000 })
    expect(Number(nestedBlocked.trim())).toBeGreaterThan(0)

    // With the shared network namespace, a container's listener is on the
    // workspace's localhost (no `-p` needed).
    await execInJob(name, [
      'sh', '-c',
      `docker run -d --name web ${UPSTREAM_IMAGE_REF} `
      + `sh -c 'mkdir -p /www && echo hello-from-nested > /www/index.html && exec httpd -f -p 18080 -h /www'`,
    ], { timeout: 120_000 })
    expect((await curlUntil('http://localhost:18080/')).trim()).toBe('hello-from-nested')

    // compose up --build: the RUN step exercises the build's mounts under
    // gVisor, and network_mode: host keeps the service on localhost.
    await execInJob(name, [
      'sh', '-c',
      'mkdir -p /tmp/composeproj && cd /tmp/composeproj && '
      + `printf 'FROM ${UPSTREAM_IMAGE_REF}\\nRUN mkdir -p /www && echo hello-from-compose > /www/index.html\\nCMD ["httpd", "-f", "-p", "18081", "-h", "/www"]\\n' > Dockerfile && `
      + `printf 'services:\\n  web:\\n    build: .\\n    network_mode: host\\n' > docker-compose.yml && `
      + 'docker compose up -d --build',
    ], { timeout: 240_000 })
    expect((await curlUntil('http://localhost:18081/')).trim()).toBe('hello-from-compose')
    await execInJob(name, [
      'sh', '-c', 'cd /tmp/composeproj && docker compose down',
    ], { timeout: 60_000 }).catch(() => { /* best-effort */ })

    // A RUN step with lots of output. Under gVisor, buildah's default oci
    // isolation dies with EPIPE after a few tens of KB of output, so the
    // engine uses BUILDAH_ISOLATION=chroot (yaac-workspace-init).
    const { stdout: floodOut } = await execInJob(name, [
      'sh', '-c',
      'mkdir -p /tmp/floodbuild && cd /tmp/floodbuild && '
      + `printf 'FROM ${UPSTREAM_IMAGE_REF}\\nRUN i=0; while [ $i -lt 20000 ]; do echo line-$i; i=$((i+1)); done; echo FINAL_MARKER\\n' > Dockerfile && `
      + 'docker build --no-cache -t yaac-flood-probe /tmp/floodbuild 2>&1 | tail -c 4000',
    ], { timeout: 240_000 })
    expect(floodOut).toContain('FINAL_MARKER')
    expect(floodOut).not.toContain('broken pipe')

    // A non-allowlisted pull fails fast rather than hanging.
    const started = Date.now()
    let blockedFailed = false
    try {
      await execInJob(name, [
        'sh', '-c', 'docker pull example.com/some/image:latest',
      ], { timeout: 90_000 })
    } catch {
      blockedFailed = true
    }
    expect(blockedFailed).toBe(true)
    expect(Date.now() - started).toBeLessThan(60_000)
  }, 900_000)

  it('serves the project registry by svc name, isolated per project and pullable by the node', async () => {
    const name = sharedJob
    const regName = projectRegistryName(sharedProjectId)
    const regHost = projectRegistryHost(sharedProjectId)

    const svc = await readObject<{ spec?: { clusterIP?: string } }>({
      apiVersion: 'v1', kind: 'Service', name: regName, namespace: k8sNamespace(),
    })
    const regVip = svc?.spec?.clusterIP
    expect(regVip).toBeTruthy()

    // The proxy's DNS forwards cluster names to cluster DNS, so the
    // registry resolves to its ClusterIP from the workspace.
    const { stdout: hostsOut } = await execInJob(name, [
      'getent', 'hosts', projectRegistryHostname(sharedProjectId),
    ])
    expect(hostsOut).toContain(regVip)

    // The per-project NetworkPolicy is the only in-cluster exception to
    // the workspace egress default-deny.
    const { stdout: ping } = await execInJob(name, [
      'sh', '-c', `curl -fsS --max-time 5 http://${regHost}/v2/ >/dev/null && echo REG_OK`,
    ], { timeout: 30_000 })
    expect(ping).toContain('REG_OK')

    // Another project's registry must be unreachable: no policy admits
    // this pod, so curl times out.
    const other = { slug: 'nested-registry-other', id: crypto.randomUUID() }
    orphanRegistryId = other.id
    createdRegistries.push(other.id)
    await ensureProjectRegistry(other)
    const { stdout: cross } = await execInJob(name, [
      'sh', '-c',
      `curl -sS --max-time 5 http://${projectRegistryHost(other.id)}/v2/ >/dev/null 2>&1`
      + ' && echo CROSS_REACHED || echo CROSS_BLOCKED',
    ], { timeout: 30_000 })
    expect(cross).toContain('CROSS_BLOCKED')

    // Push by Service name. The registry is per project, so no repo prefix.
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

    // The node can pull the pushed ref (via hosts.toml). The image has no
    // entrypoint, so a successful pull ends in a container-create error;
    // only ErrImagePull counts as failure.
    const podName = `reg-pull-probe-${crypto.randomBytes(3).toString('hex')}`
    await kubectl([
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
        const pod = await readObject<PodStatus>({ apiVersion: 'v1', kind: 'Pod', name: podName, namespace: k8sNamespace() })
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
      await deleteObject(
        { apiVersion: 'v1', kind: 'Pod', name: podName, namespace: k8sNamespace() },
        { wait: true, gracePeriodSeconds: 1 },
      ).catch(() => { /* best-effort */ })
    }
  }, 900_000)

  it('trusts the MITM CA for own-bundle tools (curl) via the combined bundle', async () => {
    // Tools like curl, requests, cargo and git ignore SSL_CERT_FILE and use
    // a single *_CA_BUNDLE file, so it must hold the public roots plus the
    // proxy CA (docs/nested-containers.md). Checks that the bundle works,
    // contains both, and reaches nested containers and build RUN steps.
    const name = sharedJob

    // (1) curl validates the proxy's leaf for github.com (MITM'd to the
    // mock git server). Any HTTP status means TLS passed; a rejected cert
    // gives 000.
    let httpCode = ''
    for (let i = 0; i < 20; i++) {
      try {
        const { stdout } = await execInJob(name, [
          'sh', '-c',
          'curl -sS -o /dev/null -w "%{http_code}" --max-time 8 https://github.com/',
        ], { timeout: 15_000 })
        httpCode = stdout.trim()
        if (/^[1-9]\d{2}$/.test(httpCode)) break
      } catch { /* warmup: DNS stub / redirect not ready yet */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(httpCode).toMatch(/^[1-9]\d{2}$/)

    // (2) The bundle has the public roots and the proxy CA.
    const { stdout: subjects } = await execInJob(name, [
      'sh', '-c',
      'openssl crl2pkcs7 -nocrl -certfile /etc/yaac/certs/ca-bundle.pem '
      + '| openssl pkcs7 -print_certs -noout',
    ], { timeout: 30_000 })
    const certCount = (subjects.match(/^subject/gm) ?? []).length
    expect(certCount).toBeGreaterThan(100)        // public roots present
    expect(subjects).toContain('yaac Proxy CA')   // proxy MITM CA present

    // (3a) containers.conf mounts the bundle into nested containers and
    // points every *_CA_BUNDLE var at it.
    const { stdout: nestedEnv } = await execInJob(name, [
      'sh', '-c',
      `docker run --rm ${UPSTREAM_IMAGE_REF} sh -c `
      + `'printf "%s\\n" "$CURL_CA_BUNDLE" "$REQUESTS_CA_BUNDLE" "$CARGO_HTTP_CAINFO" "$GIT_SSL_CAINFO"; `
      + `grep -c "BEGIN CERTIFICATE" /etc/yaac/certs/ca-bundle.pem'`,
    ], { timeout: 120_000 })
    const nestedLines = nestedEnv.trim().split('\n')
    expect(nestedLines.slice(0, 4)).toEqual([
      '/etc/yaac/certs/ca-bundle.pem',
      '/etc/yaac/certs/ca-bundle.pem',
      '/etc/yaac/certs/ca-bundle.pem',
      '/etc/yaac/certs/ca-bundle.pem',
    ])
    expect(Number(nestedLines[4])).toBeGreaterThan(100)

    // (3b) buildah applies containers.conf volumes but not env to RUN
    // steps, so build-time trust is a ca-certificates drop-in: the proxy CA
    // is mounted into /usr/local/share/ca-certificates/ for
    // `update-ca-certificates` to pick up. The RUN steps check that
    //   (i)  the drop-in is the proxy CA, and
    //   (ii) the OS bundle can still be replaced the way
    //        update-ca-certificates does it (temp file + `mv`), which a
    //        bind mount over that file would block with EBUSY.
    const dropIn = '/usr/local/share/ca-certificates/yaac-proxy-ca.crt'
    const osStore = '/etc/ssl/certs/ca-certificates.crt'
    const dockerfile =
      `FROM ${UPSTREAM_IMAGE_REF}\\n`
      + `RUN diff -q ${dropIn} /etc/yaac/certs/proxy-ca.pem\\n`
      + `RUN mkdir -p /etc/ssl/certs && cp ${dropIn} ${osStore}.new && mv ${osStore}.new ${osStore}\\n`
    await execInJob(name, [
      'sh', '-c',
      'mkdir -p /tmp/curlbuild && cd /tmp/curlbuild && '
      + `printf '${dockerfile}' > Dockerfile && `
      + 'docker build --no-cache -t yaac-curl-trust:v1 .',
    ], { timeout: 180_000 })
  }, 900_000)

  // Runs last: it stops the shared workspace and removes the project.
  it('keeps the project registry across workspace stop, and never hands it to a re-added project', async () => {
    const slug = 'nested-shared'
    const regName = projectRegistryName(sharedProjectId)

    const { exitCode } = await runYaac(serverEnv, 'workspace', 'stop', sharedSessionId)
    expect(exitCode).toBe(0)
    sharedSessionId = ''

    // The registry is per project, so it outlives the workspace.
    const depAfterDelete = await readObject({ apiVersion: 'apps/v1', kind: 'Deployment', name: regName, namespace: k8sNamespace() })
    expect(depAfterDelete?.metadata?.name).toBe(regName)

    // Remove the project (API only; no CLI verb) and re-add the same
    // remote. The new project id gets a new, empty registry.
    const removed = await makeServerApiClient(server!).project[':slug'].$delete({ param: { slug } })
    expect(removed.ok, await removed.text()).toBe(true)
    await setupProject(slug, { seeded: true })
    const readded = await createWorkspace(slug)
    expect(readded.projectId).toBeTruthy()
    expect(readded.projectId).not.toBe(sharedProjectId)
    const newRegName = projectRegistryName(readded.projectId)
    const newSvc = await readObject({ apiVersion: 'v1', kind: 'Service', name: newRegName, namespace: k8sNamespace() })
    expect(newSvc?.metadata?.name).toBe(newRegName)
    const { stdout: catalog } = await execInJob(readded.jobName, [
      'sh', '-c', `curl -fsS --max-time 20 http://${projectRegistryHost(readded.projectId)}/v2/_catalog`,
    ], { timeout: 60_000 })
    expect((JSON.parse(catalog) as { repositories: string[] }).repositories).toEqual([])
    // The old registry was removed with the project.
    expect(await readObject({ apiVersion: 'v1', kind: 'Service', name: regName, namespace: k8sNamespace() })).toBeNull()

    // A registry whose id no project holds is swept. `now` is pushed past
    // the sweep's minimum age.
    const otherName = projectRegistryName(orphanRegistryId)
    await gcOrphanProjectRegistries(
      new Set(createdRegistries.filter((id) => id !== orphanRegistryId && id !== sharedProjectId)),
      Date.now() + ORPHAN_REGISTRY_MIN_AGE_MS,
    )
    expect(await readObject({ apiVersion: 'v1', kind: 'Service', name: otherName, namespace: k8sNamespace() })).toBeNull()
    expect(await readObject({ apiVersion: 'apps/v1', kind: 'Deployment', name: otherName, namespace: k8sNamespace() })).toBeNull()
    expect(await readObject({ apiVersion: 'v1', kind: 'Service', name: newRegName, namespace: k8sNamespace() }))
      .toMatchObject({ metadata: { name: newRegName } })
    await runYaac(serverEnv, 'workspace', 'stop', readded.workspaceId).catch(() => { /* best-effort */ })
  }, 900_000)
})
