import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'

// kubectl is the one way this module reaches the cluster: every write is
// an apply or a delete, and the one read (a widening) is a get. The
// manifest builders in #drivers/k8s/cluster run for real.
const mockApply = vi.hoisted(() => vi.fn())
const mockGetJson = vi.hoisted(() => vi.fn())
const mockRetry = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  dataDirHash: () => 'ddh0123456789abc',
  k8sNamespace: () => 'test-ns',
  kubectlApply: mockApply,
  kubectlGetJson: mockGetJson,
  kubectlWithRetry: mockRetry,
}))
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  _resetRegistrationGcForTests,
  allowWorktreeHost,
  applyWorktreeRegistration,
  buildWorktreeRegistration,
  deregisterWorkspaceEgress,
  reconcileRegistrationGc,
  registerWorkspace,
  type WorktreeRegistration,
} from '#drivers/k8s/egress/proxy-registration'
import { DEFAULT_ALLOWED_HOSTS, NESTED_PULL_HOSTS } from '#lib/allowed-hosts'
import { setActiveClusterCache, type ClusterCache } from '#drivers/k8s/substrate'
import { _resetWorktreeListChangedForTests, onWorktreeListChanged } from '#notify'
import type { PassContext } from '#drivers/contract'

interface AppliedRegistration {
  kind: string
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  data: { 'registration.json': string }
}

const applied = (): AppliedRegistration[] =>
  mockApply.mock.calls.map(([m]) => m as AppliedRegistration)
const payloadOf = (m: AppliedRegistration): WorktreeRegistration =>
  JSON.parse(m.data['registration.json']) as WorktreeRegistration

/** A registration object as `kubectl get` returns it. */
function registrationObject(
  worktreeId: string,
  registration: WorktreeRegistration,
  creationTimestamp = '2026-09-01T00:00:00Z',
): AppliedRegistration & { metadata: { creationTimestamp: string } } {
  return {
    kind: 'ConfigMap',
    metadata: {
      name: `yaac-proxy-reg-${worktreeId}`,
      namespace: 'test-ns',
      labels: { 'app': 'yaac-proxy', 'yaac.proxy-input': 'registration', 'yaac.worktree-id': worktreeId, 'yaac.project': registration.projectSlug },
      creationTimestamp,
    },
    data: { 'registration.json': JSON.stringify(registration) },
  }
}

const REG: WorktreeRegistration = {
  rules: [], allowedHosts: ['api.example.com'], tool: 'claude', projectSlug: 'demo',
}

beforeEach(() => {
  mockApply.mockReset().mockResolvedValue(undefined)
  mockGetJson.mockReset().mockResolvedValue(null)
  mockRetry.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  _resetWorktreeListChangedForTests()
  _resetRegistrationGcForTests()
})

afterEach(() => {
  setActiveClusterCache(null)
  vi.clearAllMocks()
})

describe('buildWorktreeRegistration', () => {
  it('builds secret-free, project-scoped reference rules from the secrets', () => {
    const reg = buildWorktreeRegistration({
      config: {},
      remoteUrl: 'https://github.com/acme/repo',
      tool: 'claude',
      projectSlug: 'acme-repo',
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
    // The ref is scoped by project: one project's rule must not be able to
    // resolve another's secret out of the proxy's shared map.
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
    // The registration lives in a plain ConfigMap — it never sees a value,
    // which is true by construction: only names reach this function.
    expect(JSON.stringify(reg)).not.toContain('sekrit')
    expect(reg.repoUrl).toBe('https://github.com/acme/repo')
    expect(reg.tool).toBe('claude')
    expect(reg.projectSlug).toBe('acme-repo')
  })

  it('resolves the default allowlist when config has no overrides', () => {
    const reg = buildWorktreeRegistration({
      config: {},
      remoteUrl: 'https://github.com/acme/repo',
      tool: 'codex',
      projectSlug: 'acme-repo',
      secretRules: {},
      env: {},
    })
    expect(reg.allowedHosts).toEqual([...DEFAULT_ALLOWED_HOSTS])
    expect(reg.rules).toEqual([])
  })

  it('honors setAllowedUrls and addAllowedUrls from config', () => {
    expect(buildWorktreeRegistration({
      config: { setAllowedUrls: ['only.example.com'] },
      remoteUrl: 'u', tool: 'claude', projectSlug: 'p', secretRules: {}, env: {},
    }).allowedHosts).toEqual(['only.example.com'])
    expect(buildWorktreeRegistration({
      config: { addAllowedUrls: ['extra.example.com'] },
      remoteUrl: 'u', tool: 'claude', projectSlug: 'p', secretRules: {}, env: {},
    }).allowedHosts).toContain('extra.example.com')
  })

  it('auto-appends the registry/CDN pull hosts for nestedContainers sessions', () => {
    const reg = buildWorktreeRegistration({
      config: { nestedContainers: true },
      remoteUrl: 'u', tool: 'claude', projectSlug: 'p', secretRules: {}, env: {},
    })
    for (const host of NESTED_PULL_HOSTS) {
      expect(reg.allowedHosts).toContain(host)
    }
    // The docker.io pull hosts were moved out of the base list, so they
    // appear exactly once (appended), never duplicated.
    expect(
      reg.allowedHosts.filter((h) => h === 'registry-1.docker.io'),
    ).toHaveLength(1)
    // The shared default list itself must never be mutated.
    expect(DEFAULT_ALLOWED_HOSTS).not.toContain('cdn01.quay.io')
  })

  it('still appends the pull hosts on top of addAllowedUrls', () => {
    const reg = buildWorktreeRegistration({
      config: { nestedContainers: true, addAllowedUrls: ['extra.example.com'] },
      remoteUrl: 'u', tool: 'claude', projectSlug: 'p', secretRules: {}, env: {},
    })
    expect(reg.allowedHosts).toContain('extra.example.com')
    expect(reg.allowedHosts).toContain('registry-1.docker.io')
  })

  it('does NOT append the pull hosts under setAllowedUrls (full override)', () => {
    const reg = buildWorktreeRegistration({
      config: { nestedContainers: true, setAllowedUrls: ['only.example.com'] },
      remoteUrl: 'u', tool: 'claude', projectSlug: 'p', secretRules: {}, env: {},
    })
    expect(reg.allowedHosts).toEqual(['only.example.com'])
  })

  it('leaves the allowlist untouched when nestedContainers is off', () => {
    const reg = buildWorktreeRegistration({
      config: {},
      remoteUrl: 'u', tool: 'claude', projectSlug: 'p', secretRules: {}, env: {},
    })
    expect(reg.allowedHosts).toEqual([...DEFAULT_ALLOWED_HOSTS])
    expect(reg.allowedHosts).not.toContain('cdn01.quay.io')
    expect(reg.allowedHosts).not.toContain('registry-1.docker.io')
  })

  it('parses upstream redirects from the e2e env hook', () => {
    const reg = buildWorktreeRegistration({
      config: {},
      remoteUrl: 'u',
      tool: 'opencode',
      projectSlug: 'p',
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

describe('applyWorktreeRegistration', () => {
  it('writes the registration as a labelled ConfigMap the proxy indexes by worktree', async () => {
    await applyWorktreeRegistration('w1', { ...REG, upstreamRedirects: { 'h': { host: 'mock', port: 1 } } })
    const [cm] = applied()
    expect(cm.kind).toBe('ConfigMap')
    expect(cm.metadata).toEqual({
      name: 'yaac-proxy-reg-w1',
      namespace: 'test-ns',
      labels: { 'app': 'yaac-proxy', 'yaac.proxy-input': 'registration', 'yaac.worktree-id': 'w1', 'yaac.project': 'demo' },
    })
    expect(payloadOf(cm)).toEqual({ ...REG, upstreamRedirects: { 'h': { host: 'mock', port: 1 } } })
  })
})

describe('registerWorkspace', () => {
  // The caller supplies decisions — which config, tool and remote apply —
  // and this is where they become an allowlist and a rule set. That split is
  // the point of the verb, so it is what the test pins.
  it('assembles the registration from the caller’s decisions and applies it', async () => {
    await registerWorkspace({
      workspaceId: 'w1',
      projectSlug: 'demo',
      tool: 'codex',
      config: { addAllowedUrls: ['api.example.com'] },
      remoteUrl: 'https://github.com/example/repo.git',
      proxySecretRules: {},
    })

    expect(mockApply).toHaveBeenCalledTimes(1)
    const [cm] = applied()
    expect(cm.metadata.labels['yaac.worktree-id']).toBe('w1')
    const state = payloadOf(cm)
    expect(state.tool).toBe('codex')
    expect(state.projectSlug).toBe('demo')
    expect(state.repoUrl).toBe('https://github.com/example/repo.git')
    expect(state.allowedHosts).toContain('api.example.com')
    // The defaults ride along: a registration is the WHOLE allowlist, never
    // a patch, so an incomplete one would leave the workspace reaching less
    // than it should (fail-closed, but wrongly).
    expect(state.allowedHosts).toEqual(expect.arrayContaining([...DEFAULT_ALLOWED_HOSTS]))
  })

  // A retooled spare re-registers rather than being patched, so the caller
  // has to hear a failed registration — it is what taints the spare.
  it('propagates a failed registration', async () => {
    mockApply.mockRejectedValue(new Error('apiserver down'))
    await expect(registerWorkspace({
      workspaceId: 'w1',
      projectSlug: 'demo',
      tool: 'claude',
      config: {},
      remoteUrl: '',
      proxySecretRules: {},
    })).rejects.toThrow('apiserver down')
  })
})

describe('deregisterWorkspaceEgress', () => {
  it('deletes the worktree’s object, tolerating its absence', async () => {
    await deregisterWorkspaceEgress('w1')
    expect(mockRetry).toHaveBeenCalledWith(
      ['delete', 'configmap', 'yaac-proxy-reg-w1', '-n', 'test-ns', '--ignore-not-found'],
    )
  })

  // A workspace that is going away must never be held up by the datapath.
  it('swallows a failed delete', async () => {
    mockRetry.mockRejectedValue(new Error('apiserver down'))
    await expect(deregisterWorkspaceEgress('w1')).resolves.toBeUndefined()
  })
})

describe('allowWorktreeHost', () => {
  let notified: number
  beforeEach(() => {
    notified = 0
    onWorktreeListChanged(() => { notified += 1 })
  })

  it('appends the host to the named workspace’s registration and pushes a snapshot', async () => {
    mockGetJson.mockResolvedValue(registrationObject('w1', REG))
    await allowWorktreeHost({ workspaceId: 'w1', projectSlug: 'demo' }, 'new.example.com', { fanOutToProject: false })

    expect(mockGetJson).toHaveBeenCalledWith(['get', 'configmap', 'yaac-proxy-reg-w1', '-n', 'test-ns'])
    const [cm] = applied()
    expect(cm.metadata.name).toBe('yaac-proxy-reg-w1')
    expect(payloadOf(cm).allowedHosts).toEqual(['api.example.com', 'new.example.com'])
    // Everything else the registration said survives the rewrite.
    expect(payloadOf(cm)).toMatchObject({ tool: 'claude', projectSlug: 'demo' })
    expect(notified).toBe(1)
  })

  it('rewrites nothing for a host already allowed', async () => {
    mockGetJson.mockResolvedValue(registrationObject('w1', REG))
    await allowWorktreeHost({ workspaceId: 'w1', projectSlug: 'demo' }, 'api.example.com', { fanOutToProject: false })
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('surfaces a missing registration on the named target as an error', async () => {
    // The user clicked on that badge, so a miss is theirs to see.
    mockGetJson.mockResolvedValue(null)
    await expect(allowWorktreeHost({ workspaceId: 'w1', projectSlug: 'demo' }, 'h.com', { fanOutToProject: false }))
      .rejects.toThrow('not registered with the egress proxy')
  })

  it('fans out over every registration of the project, by label', async () => {
    mockGetJson.mockResolvedValue({ items: [
      registrationObject('w1', REG),
      registrationObject('w2', { ...REG, allowedHosts: ['h.com'] }),
    ] })
    await allowWorktreeHost({ workspaceId: 'w1', projectSlug: 'demo' }, 'h.com', { fanOutToProject: true })

    // Listed by the project label rather than through the pod list: a
    // registration IS a registered workspace, and the proxy prunes each
    // one's blocked record as the widened object lands.
    expect(mockGetJson).toHaveBeenCalledWith([
      'get', 'configmap', '-n', 'test-ns',
      '-l', 'app=yaac-proxy,yaac.proxy-input=registration,yaac.project=demo',
    ])
    // w2 already allowed it: only w1 is rewritten.
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
      projectSlugs: () => Promise.resolve([]),
      projectConfig: () => Promise.resolve(undefined),
      terminating: (id) => terminating.includes(id),
    }
  }

  function cacheOf(opts: { healthy: boolean; jobs?: string[] }): ClusterCache {
    return {
      healthy: () => opts.healthy,
      worktreeJobs: () => (opts.jobs ?? []).map((worktreeId) => ({ worktreeId })),
    } as unknown as ClusterCache
  }

  const OLD = '2026-01-01T00:00:00Z'

  it('collects registrations whose workspace is gone, past a grace period', async () => {
    setActiveClusterCache(cacheOf({ healthy: true, jobs: ['job-only'] }))
    mockGetJson.mockResolvedValue({ items: [
      registrationObject('live', REG, OLD),
      registrationObject('job-only', REG, OLD),
      registrationObject('terminating', REG, OLD),
      registrationObject('fresh-orphan', REG, new Date().toISOString()),
      registrationObject('orphan', REG, OLD),
    ] })
    await reconcileRegistrationGc(ctxOf(['live'], ['terminating']))

    // Named by a handle, by a Job, mid-teardown, or too young to judge: kept.
    expect(mockRetry.mock.calls.map(([args]) => (args as string[])[2]))
      .toEqual(['yaac-proxy-reg-orphan'])
  })

  it('does nothing against an untrusted cache, and throttles itself', async () => {
    setActiveClusterCache(cacheOf({ healthy: false }))
    mockGetJson.mockResolvedValue({ items: [registrationObject('orphan', REG, OLD)] })
    await reconcileRegistrationGc(ctxOf([]))
    // An unseeded cache reads as "every worktree is gone" — never act on it.
    expect(mockGetJson).not.toHaveBeenCalled()

    setActiveClusterCache(cacheOf({ healthy: true }))
    await reconcileRegistrationGc(ctxOf([]))
    expect(mockRetry).toHaveBeenCalledTimes(1)
    await reconcileRegistrationGc(ctxOf([]))
    expect(mockRetry).toHaveBeenCalledTimes(1)
  })
})
