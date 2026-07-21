import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@yaac/server/platform/git'
import { listSessionPods, type SessionPod } from '@yaac/server/platform/k8s/pods'
import { k8sNamespace, kubectlGetJson } from '@yaac/server/platform/k8s/kubectl'
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

const execFileAsync = promisify(execFile)

const UPSTREAM_REGISTRY_PORT = 5000
/** The image the mock upstream serves; pullable + runnable (busybox). */
const UPSTREAM_IMAGE_REF = 'docker.io/library/probe-busybox:1'
const BUSYBOX_SOURCE = 'docker.io/library/busybox:1.36'

interface MockUpstreamRegistry {
  /** kind-network IP — the proxy's upstream-redirect target. */
  host: string
  port: number
  stop: () => Promise<void>
}

/**
 * Stand-in for registry-1.docker.io: a plain registry:2 podman container
 * on the kind network (the same wiring as the local registry — cluster
 * pods reach kind-network containers through the node's SNAT), seeded
 * with a runnable busybox image pushed through its published loopback
 * port. The proxy's upstreamRedirects map swaps the MITM'd
 * registry-1.docker.io hop for this container, so in-session
 * `docker pull` exercises the full redirect → relay → proxy →
 * SNI-allowlist path without touching the real internet. registry:2
 * answers /v2/ unauthenticated, so no token round-trip to auth.docker.io
 * happens.
 *
 * Not a cluster pod on purpose: seeding a pod-hosted registry would need
 * a host-side `kubectl port-forward`, but `podman push` executes inside
 * the podman machine VM, whose loopback is not the host's — a published
 * container port is bound in the VM too, which is exactly what the push
 * can reach.
 */
async function startMockUpstreamRegistry(): Promise<MockUpstreamRegistry> {
  // The image the local registry already runs — normally present; pull as
  // a fallback. The yaac-test- tag keeps leaked containers visible to the
  // global-setup test-container sweep.
  try {
    await execFileAsync('podman', ['image', 'inspect', 'docker.io/library/registry:2'])
  } catch {
    await execFileAsync('podman', ['pull', 'docker.io/library/registry:2'], { timeout: 120_000 })
  }
  await execFileAsync('podman', ['tag', 'docker.io/library/registry:2', 'yaac-test-upstream-registry:2'])

  const name = `yaac-test-mock-upstream-${crypto.randomBytes(4).toString('hex')}`
  await execFileAsync('podman', [
    'run', '-d', '--name', name,
    '--label', 'yaac.test=true',
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

// In-pod podman builds rely on a `kind` podman network and host topology
// that don't exist inside a nested (vcluster) session.
describe.skipIf(IS_NESTED_YAAC)('yaac nested containers (real CLI + real server + real cluster)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let mockRegistry: MockUpstreamRegistry | null = null
  let serverEnv: NodeJS.ProcessEnv

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
      JSON.stringify({ nestedContainers: true }, null, 2) + '\n',
    )
  }

  async function findSessionPod(slug: string, exclude: Set<string> = new Set()): Promise<SessionPod> {
    const pods = (await listSessionPods(slug))
      .filter((p) => !exclude.has(p.sessionId))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
    if (!pods[0]) throw new Error(`no session pod found for project ${slug}`)
    return pods[0]
  }

  async function createSession(slug: string): Promise<SessionPod> {
    const { stdout, stderr, exitCode } = await runYaac(
      serverEnv, 'session', 'create', slug, '--tool', 'claude',
    )
    if (exitCode !== 0) {
      throw new Error(`session create failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    return findSessionPod(slug)
  }

  /** Wait for the detached cleanup (image salvage → job delete) to finish. */
  async function waitForJobGone(jobName: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const job = await kubectlGetJson<{ metadata?: { name?: string } }>([
        'get', 'job', jobName, '-n', k8sNamespace(),
      ])
      if (!job) return
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`job ${jobName} still exists after ${timeoutMs}ms`)
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
  })

  afterEach(async () => {
    if (server) await server.stop()
    server = null
    await cleanupSessionJobs()
    await cleanupMocks([mockLLM, mockGit, mockRegistry])
    mockLLM = null
    mockGit = null
    mockRegistry = null
    await testEnv.cleanup()
  })

  it('builds with in-pod podman and reuses layers across sessions via the shared store', async () => {
    const slug = 'nested-cache'
    await setupProject(slug)

    // --- Session 1 ---
    const session1 = await createSession(slug)
    const name1 = session1.jobName

    // Architectural wiring: the docker CLI speaks to the ROOTFUL in-pod
    // podman socket, the shared store is mounted rw (root-owned — the
    // rootful engine and the salvage survey use it as root), and the system
    // storage.conf points additionalimagestores at it.
    const { stdout: dockerVer } = await execInJob(name1, ['docker', 'version'], { timeout: 30_000 })
    expect(dockerVer.toLowerCase()).toContain('podman')
    const { stdout: storageConf } = await execInJob(name1, [
      'cat', '/etc/containers/storage.conf',
    ])
    expect(storageConf).toContain('/var/lib/shared-images')
    // Root-owned hostPath (DirectoryOrCreate) — no chown-init under rootful.
    const { stdout: storeOwner } = await execInJob(name1, [
      'stat', '-c', '%u', '/var/lib/shared-images',
    ])
    expect(storeOwner.trim()).toBe('0')

    // The rootful graphroot (a root-owned tmpfs at /var/lib/containers) is
    // populated by the engine; assert a root write lands.
    const { stdout: graphProbe } = await execInJob(name1, [
      'sh', '-c',
      'sudo sh -c "echo probe > /var/lib/containers/.yaac-write-probe" && echo WRITABLE',
    ])
    expect(graphProbe.trim()).toBe('WRITABLE')

    // The shared image store's two mounts are the SAME directory: a write
    // through the salvage's -dst mount is visible via the additional-store
    // mount the session reads. Both are root-owned (the rootful survey
    // writes them), so probe via sudo.
    await execInJob(name1, [
      'sh', '-c', 'sudo sh -c "echo dst-probe > /var/lib/shared-images-dst/.yaac-write-probe"',
    ])
    const { stdout: storeProbe } = await execInJob(name1, [
      'sh', '-c', 'cat /var/lib/shared-images/.yaac-write-probe',
    ])
    expect(storeProbe.trim()).toBe('dst-probe')

    // Build a tiny image (FROM scratch — no network involved).
    await execInJob(name1, [
      'sh', '-c',
      'mkdir -p /tmp/b && cd /tmp/b && '
      + 'echo cache-payload > marker && '
      + 'printf "FROM scratch\\nCOPY marker /marker\\n" > Dockerfile && '
      + 'docker build -t yaac-cache-probe:v1 .',
    ], { timeout: 120_000 })
    const { stdout: id1raw } = await execInJob(name1, [
      'sh', '-c', 'docker image inspect --format "{{.Id}}" yaac-cache-probe:v1',
    ])
    const imageId1 = id1raw.trim()
    expect(imageId1).toBeTruthy()

    // --- Delete session 1 ---
    // Detached cleanup order: image salvage (in-pod survey+save → node-side
    // writer load) → job delete. Job absence proves the whole pipeline ran.
    const { exitCode: delExit } = await runYaac(serverEnv, 'session', 'delete', session1.sessionId)
    expect(delExit).toBe(0)
    await waitForJobGone(name1, 300_000)

    // --- Session 2 ---
    const session2 = await createSession(slug)
    expect(session2.sessionId).not.toBe(session1.sessionId)

    // Rebuild the identical Dockerfile: with session 1's layers promoted
    // into the shared store, this is a pure cache hit — identical image id.
    await execInJob(session2.jobName, [
      'sh', '-c',
      'mkdir -p /tmp/b && cd /tmp/b && '
      + 'echo cache-payload > marker && '
      + 'printf "FROM scratch\\nCOPY marker /marker\\n" > Dockerfile && '
      + 'docker build -t yaac-cache-probe:v2 .',
    ], { timeout: 120_000 })
    const { stdout: id2raw } = await execInJob(session2.jobName, [
      'sh', '-c', 'docker image inspect --format "{{.Id}}" yaac-cache-probe:v2',
    ])
    expect(id2raw.trim()).toBe(imageId1)

    // Salvage tag restore: session 1's image is reachable in
    // session 2 by NAME, not just by layer id. The save/load handoff moves
    // images by id (podman save of an id carries no names), so without the
    // writer's tag pass the image would exist in the store but be unreferenceable as
    // `yaac-cache-probe:v1`. A by-name inspect against session 2's fresh
    // graphroot (which never built :v1) can only resolve through the
    // additional store, so a hit proves the restore ran.
    const { stdout: byName } = await execInJob(session2.jobName, [
      'sh', '-c',
      'docker image inspect --format "{{.Id}}" yaac-cache-probe:v1 2>&1 || echo TAG_MISSING',
    ])
    expect(byName.trim()).toBe(imageId1)

    await runYaac(serverEnv, 'session', 'delete', session2.sessionId)
  }, 900_000)

  it('pulls through the proxy, serves on localhost, runs compose builds, and denies non-allowlisted pulls', async () => {
    const slug = 'nested-net'
    await setupProject(slug)
    const session = await createSession(slug)
    const name = session.jobName

    // Helper: poll an in-session curl until it succeeds (the container
    // takes a beat to bind after `docker run`/`compose up`).
    const curlUntil = async (url: string): Promise<string> => {
      for (let i = 0; i < 40; i++) {
        try {
          const { stdout } = await execInJob(name, [
            'sh', '-c', `curl -fsS --max-time 2 ${url}`,
          ], { timeout: 10_000, maxAttempts: 1 })
          return stdout
        } catch {
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      return ''
    }

    // Allowlisted pull: docker.io resolves to registry-1.docker.io, whose
    // 443 dial rides the pod-netns REDIRECT → relay → proxy transparent
    // listener (PP2 session identity), is judged against the allowlist
    // (auto-extended for nested sessions), MITM'd (the engine trusts the
    // proxy CA via SSL_CERT_FILE), and upstream-redirected to the mock
    // registry.
    await execInJob(name, [
      'sh', '-c', `docker pull ${UPSTREAM_IMAGE_REF}`,
    ], { timeout: 180_000 })

    // A process INSIDE a nested container reaches the network too: under
    // netns=host the container shares the pod netns, so its DNS hits the
    // relay stub and its egress rides the same REDIRECT → relay → proxy
    // path as the engine's pulls above. Three signals prove the container
    // is on the managed network and the proxy governs it:
    //  (a) DNS resolves to the relay stub's dummy IP (the container uses
    //      the pod resolver, whose udp/53 is REDIRECTed to the stub).
    const { stdout: nestedDns } = await execInJob(name, [
      'sh', '-c',
      `docker run --rm ${UPSTREAM_IMAGE_REF} nslookup registry-1.docker.io 2>&1 `
      + '| grep -c 198.18.0.1 || true',
    ], { timeout: 120_000 })
    expect(Number(nestedDns.trim())).toBeGreaterThan(0)
    //  (b) a TCP connect to an allowlisted host:443 is accepted — the
    //      container's outbound 443 is REDIRECTed to the loopback relay
    //      (which forwards to the proxy), so the connection establishes.
    const { stdout: nestedTcp } = await execInJob(name, [
      'sh', '-c',
      `docker run --rm ${UPSTREAM_IMAGE_REF} `
      + `sh -c 'nc -w 5 -z registry-1.docker.io 443 && echo NESTED_NET_OK || echo NESTED_NET_FAIL'`,
    ], { timeout: 120_000 })
    expect(nestedTcp).toContain('NESTED_NET_OK')
    //  (c) an HTTP request to a NON-allowlisted host is denied by the proxy
    //      with 403 — fail-closed governance applies to nested containers,
    //      not just the engine. (HTTP, not HTTPS, so busybox needs no TLS;
    //      the 403 proves the request reached the proxy and was judged.)
    const { stdout: nestedBlocked } = await execInJob(name, [
      'sh', '-c',
      `docker run --rm ${UPSTREAM_IMAGE_REF} `
      + `sh -c 'wget -S -O /dev/null -T 8 http://example.com/ 2>&1 | grep -c " 403 " || true'`,
    ], { timeout: 120_000 })
    expect(Number(nestedBlocked.trim())).toBeGreaterThan(0)

    // docker run: nested containers share the pod netns (netns="host"), so
    // a container's listener is directly reachable on the session's
    // loopback at its own port — `curl localhost:<port>` just works. (The
    // `-p` publish flag is a no-op under host networking; the app binds
    // the port itself.)
    await execInJob(name, [
      'sh', '-c',
      `docker run -d --name web ${UPSTREAM_IMAGE_REF} `
      + `sh -c 'mkdir -p /www && echo hello-from-nested > /www/index.html && exec httpd -f -p 18080 -h /www'`,
    ], { timeout: 120_000 })
    expect((await curlUntil('http://localhost:18080/')).trim()).toBe('hello-from-nested')

    // docker compose up --build: the Dockerfile's RUN step exercises the
    // build path's overlay/proc/tmpfs mounts under the sentry.
    // network_mode: host keeps the service on the pod netns (the same
    // localhost-reachability as `docker run` above).
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

    // Chatty RUN step: floods stdout past the sentry's stdio-relay break
    // (buildah's default oci isolation dies with EPIPE after a few tens
    // of KB of RUN output — killing e.g. apt-get in real base builds —
    // while quiet builds pass). The engine runs with
    // BUILDAH_ISOLATION=chroot (session-create's engine start) exactly so
    // this survives; FINAL_MARKER proves the step ran to completion.
    const { stdout: floodOut } = await execInJob(name, [
      'sh', '-c',
      'mkdir -p /tmp/floodbuild && cd /tmp/floodbuild && '
      + `printf 'FROM ${UPSTREAM_IMAGE_REF}\\nRUN i=0; while [ $i -lt 20000 ]; do echo line-$i; i=$((i+1)); done; echo FINAL_MARKER\\n' > Dockerfile && `
      + 'docker build --no-cache -t yaac-flood-probe /tmp/floodbuild 2>&1 | tail -c 4000',
    ], { timeout: 240_000 })
    expect(floodOut).toContain('FINAL_MARKER')
    expect(floodOut).not.toContain('broken pipe')

    // Blocked pull: example.com is not on the allowlist — the proxy
    // denies at the SNI judgment, fail-closed and fast (no hang).
    const started = Date.now()
    let blockedFailed = false
    try {
      await execInJob(name, [
        'sh', '-c', 'docker pull example.com/some/image:latest',
      ], { timeout: 90_000, maxAttempts: 1 })
    } catch {
      blockedFailed = true
    }
    expect(blockedFailed).toBe(true)
    expect(Date.now() - started).toBeLessThan(60_000)

    await runYaac(serverEnv, 'session', 'delete', session.sessionId)
  }, 900_000)

  it('trusts the MITM CA for own-bundle tools (curl) via the combined bundle', async () => {
    // The own-bundle tools (curl, requests, cargo, git-libcurl) ignore
    // SSL_CERT_FILE and REPLACE their trust set with a single *_CA_BUNDLE
    // file. Pointed at the lone proxy CA they reject the real cert of every
    // tunnelled host; pointed at the combined bundle {public roots} ∪ {proxy
    // CA} they trust both intercepted and tunnelled hosts. This proves the
    // combined bundle is (1) functionally trusted by curl on a MITM'd host,
    // (2) a real superset (public roots + the proxy CA), and (3) wired into
    // nested containers AND `docker build` RUN steps — the exact place a
    // nested Dockerfile's `RUN curl ...` needs it. See
    // docs/nested-ca-combined-bundle.md.
    const slug = 'nested-curl'
    await setupProject(slug)
    const session = await createSession(slug)
    const name = session.jobName

    // (1) Functional: the session's own curl (OpenSSL-linked, honors
    // CURL_CA_BUNDLE) reaches a MITM'd host. github.com is allowlisted and
    // redirected to the mock git server, so the proxy MITMs it — curl must
    // validate the proxy-signed leaf against the combined bundle. No `-f`:
    // any HTTP status proves the TLS handshake validated; a rejected cert
    // makes curl exit non-zero with http_code 000.
    let httpCode = ''
    for (let i = 0; i < 20; i++) {
      try {
        const { stdout } = await execInJob(name, [
          'sh', '-c',
          'curl -sS -o /dev/null -w "%{http_code}" --max-time 8 https://github.com/',
        ], { timeout: 15_000, maxAttempts: 1 })
        httpCode = stdout.trim()
        if (/^[1-9]\d{2}$/.test(httpCode)) break
      } catch { /* warmup: DNS stub / redirect not ready yet */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(httpCode).toMatch(/^[1-9]\d{2}$/)

    // (2) Superset: the bundle the vars point at contains the proxy CA AND
    // the full public root set (so tunnelled upstreams keep validating).
    const { stdout: subjects } = await execInJob(name, [
      'sh', '-c',
      'openssl crl2pkcs7 -nocrl -certfile /etc/yaac/certs/ca-bundle.pem '
      + '| openssl pkcs7 -print_certs -noout',
    ], { timeout: 30_000 })
    const certCount = (subjects.match(/^subject/gm) ?? []).length
    expect(certCount).toBeGreaterThan(100)        // public roots present
    expect(subjects).toContain('yaac Proxy CA')   // proxy MITM CA present

    // (3a) Nested container: containers.conf mounts the combined bundle and
    // points every own-bundle var at it. busybox has no curl, but the trust
    // wiring curl would read is provably present in the nested container.
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

    // (3b) `docker build` RUN step. buildah does NOT apply containers.conf
    // [containers] env to build RUN steps (verified — CURL_CA_BUNDLE is empty
    // there), but it DOES apply [containers] volumes. Build-time trust rides a
    // ca-certificates DROP-IN: the bare proxy CA is bind-mounted into
    // /usr/local/share/ca-certificates/, which `update-ca-certificates` folds
    // into the image's real roots. Two RUN steps assert the mechanism with no
    // network and no curl (busybox lacks both):
    //   (i)  the drop-in is present in the build and IS the proxy CA, AND
    //   (ii) the EBUSY regression is gone — replacing the managed bundle the
    //        exact way update-ca-certificates does (temp file + `mv`) must
    //        succeed. With a bind-mount over that file it failed
    //        "mv: ... Device or resource busy"; with the drop-in it does not.
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
    ], { timeout: 180_000, maxAttempts: 1 })

    await runYaac(serverEnv, 'session', 'delete', session.sessionId)
  }, 900_000)
})
