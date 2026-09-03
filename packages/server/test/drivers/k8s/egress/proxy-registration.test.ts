import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorktreeRegistration, registerWorkspace } from '#drivers/k8s/egress/proxy-registration'
import { proxyClient } from '#drivers/k8s/egress/proxy-client'
import { DEFAULT_ALLOWED_HOSTS, NESTED_PULL_HOSTS } from '#lib/allowed-hosts'

describe('buildWorktreeRegistration', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('builds secret-free, project-scoped reference rules from the secrets', () => {
    const reg = buildWorktreeRegistration({
      config: {},
      remoteUrl: 'https://github.com/acme/repo',
      tool: 'claude',
      projectSlug: 'acme-repo',
      secretRules: {
        MY_KEY: { hosts: ['api.example.com'], header: 'x-api-key' },
      },
      env: {},
    })
    // The ref is scoped by project: one project's rule must not be able to
    // resolve another's secret out of the proxy's shared map.
    expect(reg.rules).toEqual([{
      hostPattern: 'api.example.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'x-api-key', secretRef: 'acme-repo/MY_KEY' }],
    }])
    // The registration is persisted by the proxy — it never sees a value,
    // which is now true by construction: only names reach this function.
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

describe('registerWorkspace', () => {
  const mockRegister = vi.fn<(id: string, state: unknown) => Promise<void>>()

  beforeEach(() => {
    mockRegister.mockReset().mockResolvedValue(undefined)
    vi.spyOn(proxyClient, 'registerWorktree').mockImplementation(mockRegister)
  })

  afterEach(() => { vi.restoreAllMocks() })

  // The caller supplies decisions — which config, tool and remote apply —
  // and this is where they become an allowlist and a rule set. That split is
  // the point of the verb, so it is what the test pins.
  it('assembles the registration from the caller’s decisions and PUTs it', async () => {
    await registerWorkspace({
      workspaceId: 'w1',
      projectSlug: 'demo',
      tool: 'codex',
      config: { addAllowedUrls: ['api.example.com'] },
      remoteUrl: 'https://github.com/example/repo.git',
      proxySecretRules: {},
    })

    expect(mockRegister).toHaveBeenCalledTimes(1)
    const [id, state] = mockRegister.mock.calls[0] as [string, {
      tool: string
      projectSlug: string
      repoUrl?: string
      allowedHosts: string[]
    }]
    expect(id).toBe('w1')
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
    mockRegister.mockRejectedValue(new Error('proxy down'))
    await expect(registerWorkspace({
      workspaceId: 'w1',
      projectSlug: 'demo',
      tool: 'claude',
      config: {},
      remoteUrl: '',
      proxySecretRules: {},
    })).rejects.toThrow('proxy down')
  })
})
