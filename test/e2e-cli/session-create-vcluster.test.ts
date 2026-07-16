import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@yaac/server/lib/git'
import {
  LABEL_VCLUSTER_MANAGED_BY,
  VCLUSTER_API_PORT,
  listSessionPods,
  type SessionPod,
} from '@yaac/server/lib/k8s/pods'
import { k8sNamespace, kubectlApply, kubectlGetJson, kubectlWithRetry } from '@yaac/server/lib/k8s/kubectl'
import {
  removeSessionVcluster,
  vclusterName,
  vclusterNamespace,
} from '@yaac/server/lib/k8s/vcluster'
import { removeProjectRegistry } from '@yaac/server/lib/k8s/project-registry'
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

/** Mirrored by the global setup (k8s/vcluster/images.json) — runnable. */
const INNER_IMAGE = 'localhost:5001/library/alpine:3.20'

// createSession refuses virtualCluster inside a nested yaac (no
// vcluster-in-vcluster), so these can't run from within a session.
describe.skipIf(IS_NESTED_YAAC)('yaac vcluster sessions (real CLI + real server + real cluster)', () => {
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

  async function setupProject(slug: string, config: object): Promise<void> {
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
      JSON.stringify(config, null, 2) + '\n',
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
    createdVclusters.push(vclusterName(pods[0].sessionId))
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
      await removeSessionVcluster(name).catch(() => { /* already gone */ })
    }
    for (const slug of createdSlugs.splice(0)) {
      await removeProjectRegistry(slug).catch(() => { /* already gone */ })
    }
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  it('runs a vcluster: inner nodes/pods, policy inheritance, VAP guard, full teardown', async () => {
    const slug = 'vc-session'
    await setupProject(slug, { virtualCluster: true })
    const session = await createSession(slug)
    const name = session.jobName
    const vcName = vclusterName(session.sessionId)
    // Synced pods + the vcluster control plane live in the vcluster's own
    // host namespace (one vcluster per namespace); the session pod stays
    // in the install namespace.
    const vcNs = vclusterNamespace(vcName)

    // The kubeconfig mount + KUBECONFIG env point at the API's service-DNS
    // FQDN on 8443 (resolved via the proxy's split-horizon DNS) —
    // `kubectl get nodes` from inside the session shows the synced host node.
    const nodesOut = await untilOutput(
      name, ['kubectl', 'get', 'nodes', '--no-headers'],
      (out) => out.includes('Ready'), 120_000,
    )
    expect(nodesOut).toContain('Ready')

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
    const { stdout: external } = await kubectlWithRetry([
      'exec', '-n', vcNs, syncedPod, '--',
      'sh', '-c', 'nc -w 4 -z 1.1.1.1 443 && echo REACHED || echo BLOCKED',
    ], { timeout: 30_000 })
    expect(external).toContain('BLOCKED')

    // Egress-escape attack: a tenant inside the vcluster creates an
    // allow-all egress NetworkPolicy targeting its own pod. This must NOT
    // grant the synced pod egress — two independent guards hold:
    //   (a) sync.toHost.networkPolicies is disabled, so the tenant NP
    //       never materializes on the host, and
    //   (b) the vcluster namespace's blanket world-deny CiliumNetworkPolicy
    //       denies world for every pod there regardless (deny beats allow).
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
      'sh', '-c', 'nc -w 4 -z 1.1.1.1 443 && echo REACHED || echo BLOCKED',
    ], { timeout: 30_000 })
    expect(stillExternal, 'allow-all tenant NP must not grant internet egress').toContain('BLOCKED')
    const { stdout: stillApiserver } = await kubectlWithRetry([
      'exec', '-n', vcNs, syncedPod, '--',
      'sh', '-c', 'nc -w 4 -z 10.96.0.1 443 && echo REACHED || echo BLOCKED',
    ], { timeout: 30_000 })
    expect(stillApiserver, 'allow-all tenant NP must not grant in-cluster lateral egress').toContain('BLOCKED')

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

    // Full teardown: session delete deletes the vcluster's whole
    // namespace (sweeping the control plane, synced pods, policies, and
    // kubeconfig secret) plus the cluster-scoped objects and the session
    // NetworkPolicy. The namespace disappearing is the definitive signal.
    const { exitCode: delExit } = await runYaac(serverEnv, 'session', 'delete', session.sessionId)
    expect(delExit).toBe(0)
    const deadline = Date.now() + 300_000
    for (;;) {
      const vcNamespace = await kubectlGetJson<{ metadata?: object }>(['get', 'namespace', vcNs])
      const { stdout: sessionNp } = await kubectlWithRetry([
        'get', 'networkpolicy', '-l', `yaac.vcluster=${vcName}`,
        '-n', k8sNamespace(), '-o', 'name',
      ])
      if (!vcNamespace && sessionNp.trim() === '') break
      if (Date.now() > deadline) {
        throw new Error('vcluster namespace or session policy still present after delete')
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
  }, 900_000)

  it('runs two virtualCluster sessions in parallel — both vclusters come up', async () => {
    // Regression for the one-vcluster-per-namespace constraint: each
    // session's vcluster gets its own host namespace, so two can coexist.
    const slugs = ['vc-par-a', 'vc-par-b']
    for (const slug of slugs) await setupProject(slug, { virtualCluster: true })
    const [a, b] = await Promise.all(slugs.map((s) => createSession(s)))
    expect(a.sessionId).not.toBe(b.sessionId)

    // Both control planes must reach Ready (a crash on the second is the
    // failure mode this fixes). `kubectl get nodes` from each session only
    // works once its own vcluster API serves.
    for (const s of [a, b]) {
      const out = await untilOutput(
        s.jobName, ['kubectl', 'get', 'nodes', '--no-headers'],
        (o) => o.includes('Ready'), 180_000,
      )
      expect(out, `vcluster for ${s.jobName} should serve`).toContain('Ready')
    }

    // The two vclusters live in distinct host namespaces, each Ready.
    expect(vclusterNamespace(vclusterName(a.sessionId)))
      .not.toBe(vclusterNamespace(vclusterName(b.sessionId)))
    for (const s of [a, b]) {
      const vcNs = vclusterNamespace(vclusterName(s.sessionId))
      const dep = await kubectlGetJson<{ status?: { readyReplicas?: number } }>([
        'get', 'deployment', vclusterName(s.sessionId), '-n', vcNs,
      ])
      expect(dep?.status?.readyReplicas ?? 0).toBeGreaterThanOrEqual(1)
    }

    // --- Cross-session isolation (issue #17) ---
    // With the blanket in-cluster 8443 allowance gone from the session-egress
    // CNP, a session's only hole to a vcluster API is its own per-session
    // NetworkPolicy — session A dialing session B's API must be dropped
    // (curl times out), even though B's API demonstrably serves (above).
    const bName = vclusterName(b.sessionId)
    const bApiHost = `${bName}.${vclusterNamespace(bName)}.svc.cluster.local`
    const { stdout: cross } = await execInJob(a.jobName, [
      'sh', '-c',
      `curl -ksS --max-time 5 https://${bApiHost}:${VCLUSTER_API_PORT}/ >/dev/null 2>&1`
      + ' && echo CROSS_REACHED || echo CROSS_BLOCKED',
    ], { timeout: 30_000 })
    expect(cross).toContain('CROSS_BLOCKED')
  }, 900_000)
})
