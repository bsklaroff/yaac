import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'

// The cluster is the fake behind client-node. The manifest builders in
// #drivers/k8s/cluster run for real.

import {
  _resetRegistrationGcForTests,
  allowWorkspaceHost,
  applyProxyRegistration,
  buildProxyRegistration,
  deregisterWorkspaceEgress,
  reconcileRegistrationGc,
  registerWorkspaceEgress,
  type ProxyRegistration,
} from '#drivers/k8s/egress/proxy-registration'
import { DEFAULT_ALLOWED_HOSTS, NESTED_PULL_HOSTS } from '#lib/allowed-hosts'
import {
  LABEL_DATA_DIR_HASH,
  dataDirHash,
  k8sNamespace,
  setActiveClusterCache,
  type ClusterCache,
} from '#drivers/k8s/substrate'
import { _resetWorkspaceListChangedForTests, onWorkspaceListChanged } from '#notify'
import type { PassContext } from '#drivers/contract'

interface AppliedRegistration {
  kind: string
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  data: { 'registration.json': string }
}

const applied = (): AppliedRegistration[] =>
  fakeCluster.callsOf('apply', 'ConfigMap').map((c) => c.body as unknown as AppliedRegistration)
const deleted = (): Array<string | undefined> => fakeCluster.callsOf('delete').map((c) => c.name)
const payloadOf = (m: AppliedRegistration): ProxyRegistration =>
  JSON.parse(m.data['registration.json']) as ProxyRegistration

/** Put a registration object in the cluster. */
function seedRegistration(
  workspaceId: string,
  registration: ProxyRegistration,
  creationTimestamp = '2026-09-01T00:00:00Z',
): void {
  fakeCluster.seed({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: `yaac-proxy-reg-${workspaceId}`,
      namespace: k8sNamespace(),
      labels: { 'app': 'yaac-proxy', 'yaac.proxy-input': 'registration', 'yaac.workspace-id': workspaceId, 'yaac.project-id': registration.projectId },
      creationTimestamp,
    },
    data: { 'registration.json': JSON.stringify(registration) },
  })
}

const REG: ProxyRegistration = {
  rules: [], allowedHosts: ['api.example.com'], tool: 'claude', projectId: 'demo', owner: 'o',
}

beforeEach(() => {
  _resetWorkspaceListChangedForTests()
  _resetRegistrationGcForTests()
})

afterEach(() => {
  setActiveClusterCache(null)
  vi.clearAllMocks()
})

describe('buildProxyRegistration', () => {
  it('builds secret-free, project-scoped reference rules from the secrets', () => {
    const reg = buildProxyRegistration({
      config: {},
      remoteUrl: 'https://github.com/acme/repo',
      tool: 'claude',
      projectId: 'acme-repo',
      owner: 'o',
      secretRules: {
        MY_KEY: { hosts: ['api.example.com'], header: 'x-api-key' },
        BODY: { hosts: ['*.example.org'], bodyParam: 'api_key', path: '/v1/*' },
        BEARER: { hosts: ['h.example.com'] },
        // An explicit prefix on a custom header, an overridden Bearer
        // prefix, and one secret fanned out over several hosts.
        PREFIXED: { hosts: ['p.example.com'], header: 'x-token', prefix: 'Token ' },
        BASIC: { hosts: ['b1.example.com', 'b2.example.com'], prefix: 'Basic ' },
      },
      env: {},
    })
    // Refs are scoped by project so one project cannot resolve another's
    // secret from the proxy's shared map.
    expect(reg.rules).toEqual([
      {
        hostPattern: 'api.example.com',
        pathPattern: '/*',
        injections: [{ action: 'set_header', name: 'x-api-key', secretRef: 'acme-repo/MY_KEY' }],
      },
      {
        hostPattern: '*.example.org',
        pathPattern: '/v1/*',
        injections: [{ action: 'replace_body_param', name: 'api_key', secretRef: 'acme-repo/BODY' }],
      },
      {
        hostPattern: 'h.example.com',
        pathPattern: '/*',
        injections: [{ action: 'set_header', name: 'authorization', secretRef: 'acme-repo/BEARER', prefix: 'Bearer ' }],
      },
      {
        hostPattern: 'p.example.com',
        pathPattern: '/*',
        injections: [{ action: 'set_header', name: 'x-token', secretRef: 'acme-repo/PREFIXED', prefix: 'Token ' }],
      },
      {
        hostPattern: 'b1.example.com',
        pathPattern: '/*',
        injections: [{ action: 'set_header', name: 'authorization', secretRef: 'acme-repo/BASIC', prefix: 'Basic ' }],
      },
      {
        hostPattern: 'b2.example.com',
        pathPattern: '/*',
        injections: [{ action: 'set_header', name: 'authorization', secretRef: 'acme-repo/BASIC', prefix: 'Basic ' }],
      },
    ])
    // The registration is a plain ConfigMap and holds only secret names.
    expect(JSON.stringify(reg)).not.toContain('sekrit')
    expect(reg.repoUrl).toBe('https://github.com/acme/repo')
    expect(reg.tool).toBe('claude')
    expect(reg.projectId).toBe('acme-repo')
  })

  it('resolves the default allowlist when config has no overrides', () => {
    const reg = buildProxyRegistration({
      config: {},
      remoteUrl: 'https://github.com/acme/repo',
      tool: 'codex',
      projectId: 'acme-repo',
      owner: 'o',
      secretRules: {},
      env: {},
    })
    expect(reg.allowedHosts).toEqual([...DEFAULT_ALLOWED_HOSTS])
    expect(reg.rules).toEqual([])
  })

  it('honors setAllowedUrls and addAllowedUrls from config', () => {
    expect(buildProxyRegistration({
      config: { setAllowedUrls: ['only.example.com'] },
      remoteUrl: 'u', tool: 'claude', projectId: 'p', owner: 'o', secretRules: {}, env: {},
    }).allowedHosts).toEqual(['only.example.com'])
    expect(buildProxyRegistration({
      config: { addAllowedUrls: ['extra.example.com'] },
      remoteUrl: 'u', tool: 'claude', projectId: 'p', owner: 'o', secretRules: {}, env: {},
    }).allowedHosts).toContain('extra.example.com')
  })

  it('auto-appends the registry/CDN pull hosts for nestedContainers sessions', () => {
    const reg = buildProxyRegistration({
      config: { nestedContainers: true },
      remoteUrl: 'u', tool: 'claude', projectId: 'p', owner: 'o', secretRules: {}, env: {},
    })
    for (const host of NESTED_PULL_HOSTS) {
      expect(reg.allowedHosts).toContain(host)
    }
    // The pull hosts are not in the base list, so they appear exactly once.
    expect(
      reg.allowedHosts.filter((h) => h === 'registry-1.docker.io'),
    ).toHaveLength(1)
    // The shared default list is not mutated.
    expect(DEFAULT_ALLOWED_HOSTS).not.toContain('cdn01.quay.io')
  })

  it('still appends the pull hosts on top of addAllowedUrls', () => {
    const reg = buildProxyRegistration({
      config: { nestedContainers: true, addAllowedUrls: ['extra.example.com'] },
      remoteUrl: 'u', tool: 'claude', projectId: 'p', owner: 'o', secretRules: {}, env: {},
    })
    expect(reg.allowedHosts).toContain('extra.example.com')
    expect(reg.allowedHosts).toContain('registry-1.docker.io')
  })

  it('does NOT append the pull hosts under setAllowedUrls (full override)', () => {
    const reg = buildProxyRegistration({
      config: { nestedContainers: true, setAllowedUrls: ['only.example.com'] },
      remoteUrl: 'u', tool: 'claude', projectId: 'p', owner: 'o', secretRules: {}, env: {},
    })
    expect(reg.allowedHosts).toEqual(['only.example.com'])
  })

  it('leaves the allowlist untouched when nestedContainers is off', () => {
    const reg = buildProxyRegistration({
      config: {},
      remoteUrl: 'u', tool: 'claude', projectId: 'p', owner: 'o', secretRules: {}, env: {},
    })
    expect(reg.allowedHosts).toEqual([...DEFAULT_ALLOWED_HOSTS])
    expect(reg.allowedHosts).not.toContain('cdn01.quay.io')
    expect(reg.allowedHosts).not.toContain('registry-1.docker.io')
  })

  it('parses upstream redirects from the e2e env hook', () => {
    const reg = buildProxyRegistration({
      config: {},
      remoteUrl: 'u',
      tool: 'opencode',
      projectId: 'p',
      owner: 'o',
      secretRules: {},
      env: {
        YAAC_E2E_UPSTREAM_REDIRECTS:
          '{"api.anthropic.com":{"host":"mock.yaac-test.svc","port":8080}}',
      },
    })
    expect(reg.upstreamRedirects).toEqual({
      'api.anthropic.com': { host: 'mock.yaac-test.svc', port: 8080, tls: undefined },
    })
  })
})

describe('applyProxyRegistration', () => {
  it('writes the registration as a labelled ConfigMap the proxy indexes by workspace', async () => {
    await applyProxyRegistration('w1', { ...REG, upstreamRedirects: { 'h': { host: 'mock', port: 1 } } })
    const [cm] = applied()
    expect(cm.kind).toBe('ConfigMap')
    expect(cm.metadata).toEqual({
      name: 'yaac-proxy-reg-w1',
      namespace: k8sNamespace(),
      labels: { 'app': 'yaac-proxy', 'yaac.proxy-input': 'registration', 'yaac.workspace-id': 'w1', 'yaac.project-id': 'demo' },
    })
    expect(payloadOf(cm)).toEqual({ ...REG, upstreamRedirects: { 'h': { host: 'mock', port: 1 } } })
  })
})

describe('registerWorkspaceEgress', () => {
  // The caller decides which config, tool and remote apply; this turns
  // those decisions into an allowlist and rule set.
  it('assembles the registration from the caller’s decisions, applies it, and answers with it', async () => {
    const written = await registerWorkspaceEgress({
      workspaceId: 'w1',
      projectId: 'demo',
      owner: 'o',
      tool: 'codex',
      config: { addAllowedUrls: ['api.example.com'] },
      remoteUrl: 'https://github.com/example/repo.git',
      proxySecretRules: {},
    })

    expect(applied()).toHaveLength(1)
    const [cm] = applied()
    expect(cm.metadata.labels['yaac.workspace-id']).toBe('w1')
    const state = payloadOf(cm)
    expect(state.tool).toBe('codex')
    expect(state.projectId).toBe('demo')
    expect(state.owner).toBe('o')
    expect(state.repoUrl).toBe('https://github.com/example/repo.git')
    expect(state.allowedHosts).toContain('api.example.com')
    // A registration is the whole allowlist, not a patch, so it must
    // include the defaults.
    expect(state.allowedHosts).toEqual(expect.arrayContaining([...DEFAULT_ALLOWED_HOSTS]))
    expect(written).toEqual(state)
  })

  // A claimed spare re-registers, and a failed registration must fail the
  // claim.
  it('propagates a failed registration', async () => {
    fakeCluster.intercept(() => { throw apiError(503, 'apiserver down') })
    await expect(registerWorkspaceEgress({
      workspaceId: 'w1',
      projectId: 'demo',
      owner: 'o',
      tool: 'claude',
      config: {},
      remoteUrl: '',
      proxySecretRules: {},
    })).rejects.toThrow('apiserver down')
  })
})

describe('deregisterWorkspaceEgress', () => {
  it('deletes the workspace’s object, tolerating its absence', async () => {
    seedRegistration('w1', REG)
    await deregisterWorkspaceEgress('w1')
    await deregisterWorkspaceEgress('w1')
    expect(deleted()).toEqual(['yaac-proxy-reg-w1', 'yaac-proxy-reg-w1'])
    expect(fakeCluster.objects('ConfigMap')).toEqual([])
  })

  // Removing a workspace must not be blocked by the proxy.
  it('swallows a failed delete', async () => {
    fakeCluster.intercept(() => { throw apiError(503, 'apiserver down') })
    await expect(deregisterWorkspaceEgress('w1')).resolves.toBeUndefined()
  })
})

describe('allowWorkspaceHost', () => {
  let notified: number
  beforeEach(() => {
    notified = 0
    onWorkspaceListChanged(() => { notified += 1 })
  })

  it('appends the host to the named workspace’s registration and pushes a snapshot', async () => {
    seedRegistration('w1', REG)
    await allowWorkspaceHost({ workspaceId: 'w1', projectId: 'demo' }, 'new.example.com', { fanOutToProject: false })

    const [cm] = applied()
    expect(cm.metadata.name).toBe('yaac-proxy-reg-w1')
    expect(payloadOf(cm).allowedHosts).toEqual(['api.example.com', 'new.example.com'])
    // The rest of the registration is kept.
    expect(payloadOf(cm)).toMatchObject({ tool: 'claude', projectId: 'demo' })
    expect(notified).toBe(1)
  })

  it('rewrites nothing for a host already allowed', async () => {
    seedRegistration('w1', REG)
    await allowWorkspaceHost({ workspaceId: 'w1', projectId: 'demo' }, 'api.example.com', { fanOutToProject: false })
    expect(applied()).toEqual([])
  })

  it('surfaces a missing registration on the named target as an error', async () => {
    // The user asked for this, so a miss is reported to them.
    await expect(allowWorkspaceHost({ workspaceId: 'w1', projectId: 'demo' }, 'h.com', { fanOutToProject: false }))
      .rejects.toThrow('not registered with the egress proxy')
  })

  it('fans out over every registration of the project, by label', async () => {
    seedRegistration('w1', REG)
    seedRegistration('w2', { ...REG, allowedHosts: ['h.com'] })
    seedRegistration('w3', { ...REG, projectId: 'other' })
    await allowWorkspaceHost({ workspaceId: 'w1', projectId: 'demo' }, 'h.com', { fanOutToProject: true })

    // Listed by project label, not via pods: each registration is a
    // workspace, and the proxy prunes its blocked record once widened.
    // w2 already allowed it and w3 is another project: only w1 is rewritten.
    expect(applied().map((m) => m.metadata.name)).toEqual(['yaac-proxy-reg-w1'])
    expect(notified).toBe(1)
  })
})

describe('reconcileRegistrationGc', () => {
  function ctxOf(live: string[], terminating: string[] = []): PassContext {
    return {
      triggers: new Set(),
      resync: true,
      signal: new AbortController().signal,
      snapshot: () => ({
        workspaces: () => Promise.resolve(live.map((workspaceId) => ({ workspaceId }))),
      }) as unknown as ReturnType<PassContext['snapshot']>,
      projectIds: () => Promise.resolve([]),
      projectConfig: () => Promise.resolve(undefined),
      terminating: (id) => terminating.includes(id),
    }
  }

  function cacheOf(opts: { healthy: boolean; jobs?: string[] }): ClusterCache {
    return {
      healthy: () => opts.healthy,
      workspaceJobs: () => (opts.jobs ?? []).map((workspaceId) => ({ workspaceId })),
    } as unknown as ClusterCache
  }

  const OLD = '2026-01-01T00:00:00Z'

  it('collects registrations whose workspace is gone, past a grace period', async () => {
    setActiveClusterCache(cacheOf({ healthy: true, jobs: ['job-only'] }))
    seedRegistration('live', REG, OLD)
    seedRegistration('job-only', REG, OLD)
    seedRegistration('terminating', REG, OLD)
    seedRegistration('fresh-orphan', REG, new Date().toISOString())
    seedRegistration('orphan', REG, OLD)
    await reconcileRegistrationGc(ctxOf(['live'], ['terminating']))

    // Kept: named by a handle or a Job, mid-teardown, or too young to judge.
    expect(deleted()).toEqual(['yaac-proxy-reg-orphan'])
  })

  it('lists Jobs live past an untrusted cache, and throttles itself', async () => {
    // An unseeded cache would look like every workspace is gone.
    setActiveClusterCache(cacheOf({ healthy: false }))
    fakeCluster.seed({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: 'yaac-job-only',
        namespace: k8sNamespace(),
        labels: { [LABEL_DATA_DIR_HASH]: dataDirHash(), 'yaac.workspace-id': 'job-only', 'yaac.project-id': 'demo' },
        creationTimestamp: OLD,
      },
    })
    seedRegistration('job-only', REG, OLD)
    seedRegistration('orphan', REG, OLD)
    await reconcileRegistrationGc(ctxOf([]))
    expect(deleted()).toEqual(['yaac-proxy-reg-orphan'])

    await reconcileRegistrationGc(ctxOf([]))
    expect(deleted()).toHaveLength(1)
  })
})
