import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildSessionRegistration,
  syncProxySecrets,
} from '@/lib/session/proxy-registration'
import { DEFAULT_ALLOWED_HOSTS } from '@/lib/container/default-allowed-hosts'
import { proxySecretsCredentialsPath, setDataDir } from '@/lib/project/paths'

describe('buildSessionRegistration', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('builds secret-free reference rules from envSecretProxy', () => {
    const reg = buildSessionRegistration({
      config: {
        envSecretProxy: {
          MY_KEY: { hosts: ['api.example.com'], header: 'x-api-key' },
        },
      },
      remoteUrl: 'https://github.com/acme/repo',
      tool: 'claude',
      env: { MY_KEY: 'sekrit' },
    })
    expect(reg.rules).toEqual([{
      hostPattern: 'api.example.com',
      pathPattern: '/*',
      injections: [{ action: 'set_header', name: 'x-api-key', secretRef: 'MY_KEY' }],
    }])
    // The registration is persisted by the proxy — it must never carry
    // the secret value itself.
    expect(JSON.stringify(reg)).not.toContain('sekrit')
    expect(reg.repoUrl).toBe('https://github.com/acme/repo')
    expect(reg.tool).toBe('claude')
  })

  it('resolves the default allowlist when config has no overrides', () => {
    const reg = buildSessionRegistration({
      config: {},
      remoteUrl: 'https://github.com/acme/repo',
      tool: 'codex',
      env: {},
    })
    expect(reg.allowedHosts).toEqual([...DEFAULT_ALLOWED_HOSTS])
    expect(reg.rules).toEqual([])
  })

  it('honors setAllowedUrls and addAllowedUrls from config', () => {
    expect(buildSessionRegistration({
      config: { setAllowedUrls: ['only.example.com'] },
      remoteUrl: 'u', tool: 'claude', env: {},
    }).allowedHosts).toEqual(['only.example.com'])
    expect(buildSessionRegistration({
      config: { addAllowedUrls: ['extra.example.com'] },
      remoteUrl: 'u', tool: 'claude', env: {},
    }).allowedHosts).toContain('extra.example.com')
  })

  it('parses upstream redirects from the e2e env hook', () => {
    const reg = buildSessionRegistration({
      config: {},
      remoteUrl: 'u',
      tool: 'opencode',
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

describe('syncProxySecrets', () => {
  let tmpDir: string | null = null

  afterEach(async () => {
    vi.clearAllMocks()
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
  })

  it('writes set envSecretProxy values to the proxy-secrets credentials file', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-proxy-secrets-'))
    setDataDir(tmpDir)
    await syncProxySecrets(
      {
        envSecretProxy: {
          MY_KEY: { hosts: ['api.example.com'], header: 'x-api-key' },
          MISSING: { hosts: ['api.example.com'] },
        },
      },
      { MY_KEY: 'sekrit' },
    )
    const raw = JSON.parse(await fs.readFile(proxySecretsCredentialsPath(), 'utf8')) as {
      secrets: Record<string, string>
    }
    expect(raw.secrets).toEqual({ MY_KEY: 'sekrit' })
  })

  it('no-ops when the config has no envSecretProxy', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-proxy-secrets-'))
    setDataDir(tmpDir)
    await syncProxySecrets({}, {})
    await expect(fs.access(proxySecretsCredentialsPath())).rejects.toThrow()
  })
})
