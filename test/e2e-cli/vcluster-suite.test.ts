import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@yaac/server/platform/git'
import {
  LABEL_VCLUSTER_MANAGED_BY,
  VCLUSTER_API_PORT,
  listWorktreePods,
  type PodInfo,
} from '@yaac/server/platform/k8s/pods'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@yaac/server/platform/k8s/kubectl'
import {
  removeWorktreeVcluster,
  vclusterName,
  vclusterNamespace,
} from '@yaac/server/runtime/k8s/cluster/vcluster'
import {
  ensureProjectRegistry,
  gcOrphanProjectRegistries,
  projectRegistryHost,
  projectRegistryHostname,
  projectRegistryName,
  removeProjectRegistry,
} from '@yaac/server/runtime/k8s/cluster/project-registry'
import { registryRef } from '@yaac/server/platform/container/registry'
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
  cleanupWorktreeJobs,
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

/** Mirrored by the global setup (k8s/vcluster/images.json) — runnable.
 *  Qualified through registryRef so it names the registry's live cluster
 *  host: nothing maps `localhost:5001` on the node any more. */
const INNER_IMAGE = registryRef('library/alpine:3.20')

/**
 * Everything a virtualCluster session is: the vcluster comes up, its
 * synced pods inherit a fail-closed policy floor no tenant object can
 * widen, the VAP guards hostPath and the gVisor tier, the project's
 * registry serves the session, and session stop sweeps the vcluster
 * while the (per-project, not per-session) registry survives to be GC'd
 * separately.
 *
 * Two sessions, created ONCE in parallel, carry all of it. `PRIMARY` is
 * the subject of every per-session assertion; `SIBLING` exists so the
 * one-vcluster-per-namespace regression and the cross-session isolation
 * gate have a second, genuinely concurrent vcluster to prove against.
 * Provisioning a vcluster is the most expensive fixture in the suite, so
 * the tests below share these two rather than creating their own — a
 * test that needs a session torn down runs last.
 *
 * createWorktree refuses virtualCluster inside a nested yaac (no
 * vcluster-in-vcluster), so none of this can run from within a session.
 */
describe.skipIf(IS_NESTED_YAAC)('yaac vcluster sessions (real CLI + real server + real cluster)', () => {
  const PRIMARY = 'vc-primary'
  const SIBLING = 'vc-sibling'

  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let serverEnv: NodeJS.ProcessEnv
  const createdSlugs: string[] = []
  const createdVclusters: string[] = []

  let primary: PodInfo
  let sibling: PodInfo

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

  async function createWorktree(slug: string): Promise<PodInfo> {
    const { stdout, stderr, exitCode } = await runYaac(
      serverEnv, 'worktree', 'create', slug, '--tool', 'claude',
    )
    if (exitCode !== 0) {
      throw new Error(`session create failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    const pods = (await listWorktreePods(slug)).sort((a, b) => a.createdAtMs - b.createdAtMs)
    if (!pods[0]) throw new Error(`no session pod found for project ${slug}`)
    createdVclusters.push(vclusterName(pods[0].worktreeId))
    return pods[0]
  }

  /** Poll an in-session command until its output matches. */
  async function untilOutput(
    jobName: string,
    cmd: string[],
    match: (out: string) => boolean,
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      try {
        const { stdout } = await execInJob(jobName, cmd, { timeout: 30_000, maxAttempts: 1 })
        last = stdout
        if (match(stdout)) return stdout
      } catch { /* command not ready yet */ }
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error(`in-session ${cmd.join(' ')} never matched; last output:\n${last}`)
  }

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()

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

    for (const slug of [PRIMARY, SIBLING]) await setupProject(slug)
    // Sequential, NOT Promise.all. The one-vcluster-per-namespace
    // regression needs the second stack to provision against a live first
    // one, which this gives; creating both at once additionally races them
    // on the install-wide objects a first vcluster session brings up
    // (`ensureActivator` kubectl-applies the yaac-vc-activator
    // ServiceAccount), and in a cold namespace both creators decide to
    // create it — the loser's `worktree create` exits 1 with
    // AlreadyExists. A throwing beforeAll surfaces as "file failed, every
    // test skipped" with no per-test error, which is near-undebuggable
    // from a CI log.
    primary = await createWorktree(PRIMARY)
    sibling = await createWorktree(SIBLING)
  }, 900_000)

  afterAll(async () => {
    if (server) await server.stop()
    server = null
    await cleanupWorktreeJobs()
    for (const name of createdVclusters.splice(0)) {
      await removeWorktreeVcluster(name).catch(() => { /* already gone */ })
    }
    for (const slug of createdSlugs.splice(0)) {
      await removeProjectRegistry(slug).catch(() => { /* already gone */ })
    }
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  }, 300_000)

  it('brings two concurrent vclusters up, each in its own host namespace', async () => {
    // Regression for the one-vcluster-per-namespace constraint: each
    // session's vcluster gets its own host namespace, so two can coexist.
    expect(primary.worktreeId).not.toBe(sibling.worktreeId)

    // Both control planes must reach Ready (a crash on the second is the
    // failure mode this fixes). `kubectl get nodes` from each session only
    // works once its own vcluster API serves — and the kubeconfig mount +
    // KUBECONFIG env point at the API's service-DNS FQDN on 8443, resolved
    // via the proxy's split-horizon DNS, so a Ready node also proves that
    // whole path.
    for (const s of [primary, sibling]) {
      const out = await untilOutput(
        s.jobName, ['kubectl', 'get', 'nodes', '--no-headers'],
        (o) => o.includes('Ready'), 180_000,
      )
      expect(out, `vcluster for ${s.jobName} should serve`).toContain('Ready')
    }

    // The two vclusters live in distinct host namespaces, each Ready.
    expect(vclusterNamespace(vclusterName(primary.worktreeId)))
      .not.toBe(vclusterNamespace(vclusterName(sibling.worktreeId)))
    for (const s of [primary, sibling]) {
      const vcNs = vclusterNamespace(vclusterName(s.worktreeId))
      const dep = await kubectlGetJson<{ status?: { readyReplicas?: number } }>([
        'get', 'deployment', vclusterName(s.worktreeId), '-n', vcNs,
      ])
      expect(dep?.status?.readyReplicas ?? 0).toBeGreaterThanOrEqual(1)
    }
  }, 900_000)

  it('denies a session dialing another session\'s vcluster API', async () => {
    // Cross-session isolation (issue #17). With the blanket in-cluster 8443
    // allowance gone from the session-egress policy, a session's only hole
    // to a vcluster API is its own per-session NetworkPolicy — the primary
    // dialing the sibling's API must be dropped (curl times out), even
    // though the sibling's API demonstrably serves (above).
    const bName = vclusterName(sibling.worktreeId)
    const bApiHost = `${bName}.${vclusterNamespace(bName)}.svc.cluster.local`
    // Polled, not sampled once. NetworkPolicy programming is eventually
    // consistent, so a dial issued before the sibling's policy lands on
    // the node reaches the API and reports CROSS_REACHED — a false
    // failure this assertion hit intermittently when it depended on
    // whatever incidental delay preceded it. Waiting for the deny to
    // appear is the real claim ("nothing admits this flow"); it either
    // converges closed or the test fails on the deadline.
    const cross = await untilOutput(
      primary.jobName,
      [
        'sh', '-c',
        `curl -ksS --max-time 5 https://${bApiHost}:${VCLUSTER_API_PORT}/ >/dev/null 2>&1`
        + ' && echo CROSS_REACHED || echo CROSS_BLOCKED',
      ],
      (out) => out.includes('CROSS_BLOCKED'),
      120_000,
    )
    expect(cross).toContain('CROSS_BLOCKED')
  }, 300_000)

  it('syncs an inner pod under a policy floor no tenant NetworkPolicy widens', async () => {
    const name = primary.jobName
    const vcName = vclusterName(primary.worktreeId)
    // Synced pods + the vcluster control plane live in the vcluster's own
    // host namespace (one vcluster per namespace); the session pod stays
    // in the install namespace.
    const vcNs = vclusterNamespace(vcName)

    // Run an inner pod from the mirrored image; the syncer lands it in
    // the host namespace under the VAP guard and the synced-pods policy.
    await execInJob(name, [
      'kubectl', 'run', 'inner-probe', `--image=${INNER_IMAGE}`, '--restart=Never',
      '--', 'sh', '-c', 'echo INNER_OK && sleep 600',
    ], { timeout: 30_000 })

    interface RawPods {
      items: Array<{ metadata: { name: string }; status?: { phase?: string } }>
    }
    let syncedPod = ''
    {
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline && !syncedPod) {
        const list = await kubectlGetJson<RawPods>([
          'get', 'pods', '-n', vcNs, '-l', `${LABEL_VCLUSTER_MANAGED_BY}=${vcName}`,
        ])
        const pod = list?.items.find(
          (p) => p.metadata.name.startsWith('inner-probe') && p.status?.phase === 'Running',
        )
        if (pod) syncedPod = pod.metadata.name
        else await new Promise((r) => setTimeout(r, 2000))
      }
    }
    expect(syncedPod, 'inner pod synced to host and Running').toBeTruthy()

    // Policy inheritance, fail-closed both ways: the synced pod reaches
    // its vcluster API (post-DNAT 8443) but neither the host apiserver
    // nor the internet — synced pods carry no session-id label, so the
    // per-vcluster synced-pods policy is their only (and default-deny)
    // egress surface.
    const vcSvc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
      'get', 'service', vcName, '-n', vcNs,
    ])
    const vcVip = vcSvc?.spec?.clusterIP
    expect(vcVip, 'vcluster API Service has a (live) ClusterIP').toBeTruthy()
    const { stdout: allowed } = await kubectlWithRetry([
      'exec', '-n', vcNs, syncedPod, '--',
      'sh', '-c', `nc -w 4 -z ${vcVip} 8443 && echo VC_API_OK || echo VC_API_BLOCKED`,
    ], { timeout: 30_000 })
    expect(allowed).toContain('VC_API_OK')
    const { stdout: apiserver } = await kubectlWithRetry([
      'exec', '-n', vcNs, syncedPod, '--',
      'sh', '-c', 'nc -w 4 -z 10.96.0.1 443 && echo REACHED || echo BLOCKED',
    ], { timeout: 30_000 })
    expect(apiserver).toContain('BLOCKED')
    // World egress, probed as DATA rather than as a TCP handshake. netd
    // redirects 443, so a bare connect to any address on that port
    // completes against the node's Envoy by design — it proves nothing
    // about reachability. What must fail is the session itself: the
    // outer proxy refuses a host no allowlist admits. A non-redirected
    // port is the complementary check, and there the NetworkPolicy
    // default-deny is what answers.
    const { stdout: external } = await kubectlWithRetry([
      'exec', '-n', vcNs, syncedPod, '--',
      'sh', '-c', 'curl -sS --max-time 10 -o /dev/null https://1.1.1.1/ '
        + '&& echo REACHED || echo BLOCKED',
    ], { timeout: 30_000 })
    expect(external, 'a synced pod must not reach a non-allowlisted host').toContain('BLOCKED')
    const { stdout: externalRaw } = await kubectlWithRetry([
      'exec', '-n', vcNs, syncedPod, '--',
      'sh', '-c', 'nc -w 4 -z 1.1.1.1 9999 && echo REACHED || echo BLOCKED',
    ], { timeout: 30_000 })
    expect(externalRaw, 'a synced pod must not reach an un-redirected port').toContain('BLOCKED')

    // Egress-escape attack: a tenant inside the vcluster creates an
    // allow-all egress NetworkPolicy targeting its own pod. This must NOT
    // grant the synced pod egress — two independent guards hold:
    //   (a) sync.toHost.networkPolicies is disabled, so the tenant NP
    //       never materializes on the host, and
    //   (b) the vcluster namespace's synced-pod egress floor admits only
    //       the node's netd listener range, the vcluster API, siblings and
    //       the DNS stub — so even a unioned allow-all cannot widen it.
    await execInJob(name, ['sh', '-c',
      'printf \'apiVersion: networking.k8s.io/v1\\nkind: NetworkPolicy\\n'
      + 'metadata: {name: let-me-out}\\nspec:\\n  podSelector: {matchLabels: {run: inner-probe}}\\n'
      + '  policyTypes: [Egress]\\n  egress:\\n  - to: [{ipBlock: {cidr: 0.0.0.0/0}}]\\n\' '
      + '| kubectl apply -f -',
    ], { timeout: 30_000 })
    // Give the syncer a beat in case it would (wrongly) sync the NP.
    await new Promise((r) => setTimeout(r, 8000))
    // (a) the tenant NP did not sync to a host NetworkPolicy (in the
    // vcluster namespace, where the syncer would have placed it).
    const { stdout: hostNps } = await kubectlWithRetry(['get', 'networkpolicy', '-n', vcNs, '-o', 'name'])
    expect(hostNps).not.toContain('let-me-out')
    // (b) internet still blocked, and an in-cluster non-sibling target
    // (the host apiserver — stands in for cross-project registries and
    // other namespace pods) still blocked.
    const { stdout: stillExternal } = await kubectlWithRetry([
      'exec', '-n', vcNs, syncedPod, '--',
      'sh', '-c', 'curl -sS --max-time 10 -o /dev/null https://1.1.1.1/ '
        + '&& echo REACHED || echo BLOCKED',
    ], { timeout: 30_000 })
    expect(stillExternal, 'allow-all tenant NP must not grant internet egress').toContain('BLOCKED')
    const { stdout: stillRaw } = await kubectlWithRetry([
      'exec', '-n', vcNs, syncedPod, '--',
      'sh', '-c', 'nc -w 4 -z 1.1.1.1 9999 && echo REACHED || echo BLOCKED',
    ], { timeout: 30_000 })
    expect(stillRaw, 'allow-all tenant NP must not open un-redirected ports').toContain('BLOCKED')
    const { stdout: stillApiserver } = await kubectlWithRetry([
      'exec', '-n', vcNs, syncedPod, '--',
      'sh', '-c', 'nc -w 4 -z 10.96.0.1 443 && echo REACHED || echo BLOCKED',
    ], { timeout: 30_000 })
    expect(stillApiserver, 'allow-all tenant NP must not grant in-cluster lateral egress').toContain('BLOCKED')
  }, 900_000)

  it('denies a hostPath escape and admits cap grants only behind the gvisor tier', async () => {
    const name = primary.jobName
    const vcName = vclusterName(primary.worktreeId)
    const vcNs = vclusterNamespace(vcName)

    // VAP hostPath rejection: an inner pod mounting outside the session
    // nested data dir never reaches the host — the syncer surfaces the
    // admission denial as a SyncError event on the inner pod.
    await execInJob(name, ['sh', '-c',
      `printf 'apiVersion: v1\\nkind: Pod\\nmetadata:\\n  name: bad-hostpath\\nspec:\\n  restartPolicy: Never\\n  containers:\\n  - name: c\\n    image: ${INNER_IMAGE}\\n    command: ["sleep", "60"]\\n    volumeMounts: [{name: x, mountPath: /host-etc}]\\n  volumes: [{name: x, hostPath: {path: /etc}}]\\n' | kubectl apply -f -`,
    ], { timeout: 30_000 })
    const hostPathEvents = await untilOutput(
      name,
      ['sh', '-c', 'kubectl get events --field-selector involvedObject.name=bad-hostpath 2>/dev/null | cat'],
      (out) => out.includes('denied'), 90_000,
    )
    expect(hostPathEvents).toContain('hostPath volumes must stay under the session nested data dir')

    // Caps posture under gVisor: a tenant pod adding capabilities is
    // ADMITTED — the syncer stamps runtimeClassName: gvisor on every
    // synced pod (values.yaml), and the VAP admits cap grants only behind
    // that sentry tier. Assert the containment is actually present on the
    // synced pod (pre-gVisor, this same pod was denied outright).
    await execInJob(name, ['sh', '-c',
      `printf 'apiVersion: v1\\nkind: Pod\\nmetadata:\\n  name: caps-ok\\nspec:\\n  restartPolicy: Never\\n  containers:\\n  - name: c\\n    image: ${INNER_IMAGE}\\n    command: ["sleep", "60"]\\n    securityContext:\\n      capabilities:\\n        add: ["NET_ADMIN"]\\n' | kubectl apply -f -`,
    ], { timeout: 30_000 })
    interface RawPodSpecs {
      items: Array<{ metadata: { name: string }; spec?: { runtimeClassName?: string } }>
    }
    let capsSynced: RawPodSpecs['items'][number] | undefined
    {
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline && !capsSynced) {
        const list = await kubectlGetJson<RawPodSpecs>([
          'get', 'pods', '-n', vcNs, '-l', `${LABEL_VCLUSTER_MANAGED_BY}=${vcName}`,
        ])
        capsSynced = list?.items.find((p) => p.metadata.name.startsWith('caps-ok'))
        if (!capsSynced) await new Promise((r) => setTimeout(r, 2000))
      }
    }
    expect(capsSynced, 'cap-adding tenant pod synced to host (admitted behind the sentry)').toBeTruthy()
    expect(capsSynced?.spec?.runtimeClassName, 'syncer stamped the gvisor tier').toBe('gvisor')

    // The VAP backstop that stamp rides on: a managed-by-labeled pod
    // reaching the host apiserver WITHOUT the gvisor tier (a regressed or
    // compromised syncer stand-in, applied host-side) is denied at
    // admission — this is what keeps cap grants gated if the values.yaml
    // stamp ever stops applying.
    await expect(kubectlApply({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'vap-backstop-caps',
        namespace: vcNs,
        labels: { [LABEL_VCLUSTER_MANAGED_BY]: vcName },
      },
      spec: {
        restartPolicy: 'Never',
        containers: [{
          name: 'c',
          image: INNER_IMAGE,
          command: ['sleep', '60'],
          securityContext: { capabilities: { add: ['NET_ADMIN'] } },
        }],
      },
    })).rejects.toThrow(/require the gvisor runtime tier/)
  }, 900_000)

  it('serves the project registry by svc name, isolated per project and pullable by the node', async () => {
    const name = primary.jobName
    const regName = projectRegistryName(PRIMARY)
    const regHost = projectRegistryHost(PRIMARY)

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
      'getent', 'hosts', projectRegistryHostname(PRIMARY),
    ])
    expect(hostsOut).toContain(regVip)

    // The per-project sessions NetworkPolicy is the SOLE hole through the
    // session-egress policy's default-deny (no blanket in-cluster allowance
    // anymore): plain-HTTP :5000 answers from inside the session.
    const { stdout: ping } = await execInJob(name, [
      'sh', '-c', `curl -fsS --max-time 5 http://${regHost}/v2/ >/dev/null && echo REG_OK`,
    ], { timeout: 30_000 })
    expect(ping).toContain('REG_OK')

    // --- Cross-project isolation (issue #17) ---
    // Stand up a SECOND project's registry (no session needed) and assert
    // this project's session cannot reach it: nothing admits the flow —
    // the session-egress policy has no in-cluster allowance, the other
    // project's sessions NetworkPolicy does not select this pod, and the
    // other registry's ingress policy does not admit it. curl must time out
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
    // Written to /etc/containers (the ROOTFUL engine's config dir) by
    // session-create via sudo — the per-user path is dead since the
    // rootless engine was dropped.
    const { stdout: conf } = await execInJob(name, [
      'cat', '/etc/containers/registries.conf.d/yaac-project-registry.conf',
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
  }, 900_000)

  // Runs last on purpose: it stops PRIMARY, which every test above needs
  // alive.
  it('sweeps the vcluster on session stop, while the project registry persists and GCs separately', async () => {
    const vcName = vclusterName(primary.worktreeId)
    const vcNs = vclusterNamespace(vcName)
    const regName = projectRegistryName(PRIMARY)

    // Full teardown: session delete deletes the vcluster's whole
    // namespace (sweeping the control plane, synced pods, policies, and
    // kubeconfig secret) plus the cluster-scoped objects and the session
    // NetworkPolicy. The namespace disappearing is the definitive signal.
    const { exitCode: delExit } = await runYaac(serverEnv, 'worktree', 'stop', primary.worktreeId)
    expect(delExit).toBe(0)
    const deadline = Date.now() + 300_000
    for (;;) {
      const vcNamespace = await kubectlGetJson<{ metadata?: object }>(['get', 'namespace', vcNs])
      const { stdout: worktreeNp } = await kubectlWithRetry([
        'get', 'networkpolicy', '-l', `yaac.vcluster=${vcName}`,
        '-n', k8sNamespace(), '-o', 'name',
      ])
      if (!vcNamespace && worktreeNp.trim() === '') break
      if (Date.now() > deadline) {
        throw new Error('vcluster namespace or session policy still present after delete')
      }
      await new Promise((r) => setTimeout(r, 3000))
    }

    // --- The registry is per-PROJECT, so it outlives the session ---
    const depAfterDelete = await kubectlGetJson<{ metadata?: { name?: string } }>([
      'get', 'deployment', regName, '-n', k8sNamespace(),
    ])
    expect(depAfterDelete?.metadata?.name).toBe(regName)

    // --- GCs once the project dir is gone (server-start sweep) ---
    await fs.rm(path.join(testEnv.dataDir, 'projects', PRIMARY), { recursive: true, force: true })
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
