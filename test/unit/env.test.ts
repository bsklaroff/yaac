import { describe, it, expect, afterEach, vi } from 'vitest'
import { env, testEnv } from '@/shared/env'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('env (configuration)', () => {
  describe('dataDirOverride', () => {
    it('is undefined when YAAC_DATA_DIR is unset', () => {
      vi.stubEnv('YAAC_DATA_DIR', undefined)
      expect(env.dataDirOverride).toBeUndefined()
    })

    it('returns the override when set', () => {
      vi.stubEnv('YAAC_DATA_DIR', '/tmp/yaac-x')
      expect(env.dataDirOverride).toBe('/tmp/yaac-x')
    })
  })

  describe('useTor', () => {
    it('is false when YAAC_USE_TOR is unset', () => {
      vi.stubEnv('YAAC_USE_TOR', undefined)
      expect(env.useTor).toBe(false)
    })

    it.each(['', '0', 'false', 'FALSE', 'False', '  false  '])(
      'is false when YAAC_USE_TOR=%j',
      (value) => {
        vi.stubEnv('YAAC_USE_TOR', value)
        expect(env.useTor).toBe(false)
      },
    )

    it.each(['1', 'true', 'TRUE', 'yes', 'on', 'anything'])(
      'is true when YAAC_USE_TOR=%j',
      (value) => {
        vi.stubEnv('YAAC_USE_TOR', value)
        expect(env.useTor).toBe(true)
      },
    )
  })

  describe('torSocksUrl', () => {
    it('defaults to the local Tor SOCKS endpoint when unset', () => {
      vi.stubEnv('YAAC_HOST_TOR_SOCKS_URL', undefined)
      expect(env.torSocksUrl).toBe('socks5h://127.0.0.1:9050')
    })

    it('returns the override when set', () => {
      vi.stubEnv('YAAC_HOST_TOR_SOCKS_URL', 'socks5h://10.0.0.1:9150')
      expect(env.torSocksUrl).toBe('socks5h://10.0.0.1:9150')
    })
  })

  describe('daemonPort', () => {
    it('is undefined when YAAC_DAEMON_PORT is unset or empty', () => {
      vi.stubEnv('YAAC_DAEMON_PORT', undefined)
      expect(env.daemonPort).toBeUndefined()
      vi.stubEnv('YAAC_DAEMON_PORT', '')
      expect(env.daemonPort).toBeUndefined()
    })

    it('parses a valid port', () => {
      vi.stubEnv('YAAC_DAEMON_PORT', '9999')
      expect(env.daemonPort).toBe(9999)
    })

    it('allows 0 (OS-assigned ephemeral)', () => {
      vi.stubEnv('YAAC_DAEMON_PORT', '0')
      expect(env.daemonPort).toBe(0)
    })

    it('throws on a non-numeric value', () => {
      vi.stubEnv('YAAC_DAEMON_PORT', 'nope')
      expect(() => env.daemonPort).toThrow(/YAAC_DAEMON_PORT/)
    })

    it('throws on an out-of-range value', () => {
      vi.stubEnv('YAAC_DAEMON_PORT', '70000')
      expect(() => env.daemonPort).toThrow(/between 0 and 65535/)
    })
  })

  describe('k8sRegistry', () => {
    it('defaults to localhost:5001 when unset', () => {
      vi.stubEnv('YAAC_K8S_REGISTRY', undefined)
      expect(env.k8sRegistry).toBe('localhost:5001')
    })

    it('returns the override when set', () => {
      vi.stubEnv('YAAC_K8S_REGISTRY', 'registry.local:5000')
      expect(env.k8sRegistry).toBe('registry.local:5000')
    })
  })

  describe('prewarmPoolSize', () => {
    it('defaults to 1 when unset or blank', () => {
      vi.stubEnv('YAAC_PREWARM_POOL_SIZE', undefined)
      expect(env.prewarmPoolSize).toBe(1)
      vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '')
      expect(env.prewarmPoolSize).toBe(1)
    })

    it('parses non-negative integers (0 disables)', () => {
      vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '0')
      expect(env.prewarmPoolSize).toBe(0)
      vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '3')
      expect(env.prewarmPoolSize).toBe(3)
    })

    it('falls back to 1 for garbage / negative / non-integer values', () => {
      for (const v of ['abc', '-2', '2.5']) {
        vi.stubEnv('YAAC_PREWARM_POOL_SIZE', v)
        expect(env.prewarmPoolSize).toBe(1)
      }
    })
  })

  describe('nested', () => {
    it('is true only when YAAC_NESTED is exactly "1"', () => {
      vi.stubEnv('YAAC_NESTED', '1')
      expect(env.nested).toBe(true)
      vi.stubEnv('YAAC_NESTED', '0')
      expect(env.nested).toBe(false)
      vi.stubEnv('YAAC_NESTED', undefined)
      expect(env.nested).toBe(false)
    })
  })

  describe('bundled', () => {
    it('is false when YAAC_BUNDLED is unset', () => {
      vi.stubEnv('YAAC_BUNDLED', undefined)
      expect(env.bundled).toBe(false)
    })

    it('is true when YAAC_BUNDLED is set (tsup build define)', () => {
      vi.stubEnv('YAAC_BUNDLED', 'true')
      expect(env.bundled).toBe(true)
    })
  })
})

describe('testEnv (test-harness hooks)', () => {
  describe('buildIdOverride', () => {
    it('is undefined when unset, returns the value when set', () => {
      vi.stubEnv('YAAC_BUILD_ID', undefined)
      expect(testEnv.buildIdOverride).toBeUndefined()
      vi.stubEnv('YAAC_BUILD_ID', 'abc123')
      expect(testEnv.buildIdOverride).toBe('abc123')
    })
  })

  describe('daemonUrlOverride / daemonSecretOverride', () => {
    it('return undefined when unset and the value when set', () => {
      vi.stubEnv('YAAC_DAEMON_URL', undefined)
      vi.stubEnv('YAAC_DAEMON_SECRET', undefined)
      expect(testEnv.daemonUrlOverride).toBeUndefined()
      expect(testEnv.daemonSecretOverride).toBeUndefined()
      vi.stubEnv('YAAC_DAEMON_URL', 'http://127.0.0.1:8787')
      vi.stubEnv('YAAC_DAEMON_SECRET', 'secret')
      expect(testEnv.daemonUrlOverride).toBe('http://127.0.0.1:8787')
      expect(testEnv.daemonSecretOverride).toBe('secret')
    })
  })

  describe('daemonBuildIdOverride', () => {
    it('defaults to an empty string when unset', () => {
      vi.stubEnv('YAAC_DAEMON_BUILD_ID', undefined)
      expect(testEnv.daemonBuildIdOverride).toBe('')
      vi.stubEnv('YAAC_DAEMON_BUILD_ID', 'bid')
      expect(testEnv.daemonBuildIdOverride).toBe('bid')
    })
  })

  describe('k8sNamespace', () => {
    it('defaults to "yaac" when unset', () => {
      vi.stubEnv('YAAC_K8S_NAMESPACE', undefined)
      expect(testEnv.k8sNamespace).toBe('yaac')
    })

    it('returns the per-test namespace when set', () => {
      vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac-test-abc')
      expect(testEnv.k8sNamespace).toBe('yaac-test-abc')
    })
  })

  describe('imagePrefix', () => {
    it('is undefined when unset, returns the value when set', () => {
      vi.stubEnv('YAAC_IMAGE_PREFIX', undefined)
      expect(testEnv.imagePrefix).toBeUndefined()
      vi.stubEnv('YAAC_IMAGE_PREFIX', 'yaac-test')
      expect(testEnv.imagePrefix).toBe('yaac-test')
    })
  })

  describe('requirePrebuiltImages', () => {
    it('is true only when YAAC_REQUIRE_PREBUILT_IMAGES is exactly "1"', () => {
      vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', '1')
      expect(testEnv.requirePrebuiltImages).toBe(true)
      vi.stubEnv('YAAC_REQUIRE_PREBUILT_IMAGES', undefined)
      expect(testEnv.requirePrebuiltImages).toBe(false)
    })
  })

  describe('proxyImage', () => {
    it('defaults to "yaac-proxy" when unset', () => {
      vi.stubEnv('YAAC_PROXY_IMAGE', undefined)
      expect(testEnv.proxyImage).toBe('yaac-proxy')
      vi.stubEnv('YAAC_PROXY_IMAGE', 'yaac-test-proxy:hash')
      expect(testEnv.proxyImage).toBe('yaac-test-proxy:hash')
    })
  })

  describe('startingGraceMs', () => {
    it('defaults to 60000 when unset or blank', () => {
      vi.stubEnv('YAAC_STARTING_GRACE_MS', undefined)
      expect(testEnv.startingGraceMs).toBe(60_000)
      vi.stubEnv('YAAC_STARTING_GRACE_MS', '')
      expect(testEnv.startingGraceMs).toBe(60_000)
    })

    it('returns the parsed value when set (0 allowed)', () => {
      vi.stubEnv('YAAC_STARTING_GRACE_MS', '0')
      expect(testEnv.startingGraceMs).toBe(0)
      vi.stubEnv('YAAC_STARTING_GRACE_MS', '2500')
      expect(testEnv.startingGraceMs).toBe(2500)
    })

    it('falls back to the default for unparseable or negative values', () => {
      vi.stubEnv('YAAC_STARTING_GRACE_MS', 'not-a-number')
      expect(testEnv.startingGraceMs).toBe(60_000)
      vi.stubEnv('YAAC_STARTING_GRACE_MS', '-5')
      expect(testEnv.startingGraceMs).toBe(60_000)
    })
  })

  describe('e2eNoAttach / e2eSkipFetch', () => {
    it('are true only when their var is exactly "1"', () => {
      vi.stubEnv('YAAC_E2E_NO_ATTACH', '1')
      vi.stubEnv('YAAC_E2E_SKIP_FETCH', '1')
      expect(testEnv.e2eNoAttach).toBe(true)
      expect(testEnv.e2eSkipFetch).toBe(true)
      vi.stubEnv('YAAC_E2E_NO_ATTACH', undefined)
      vi.stubEnv('YAAC_E2E_SKIP_FETCH', '0')
      expect(testEnv.e2eNoAttach).toBe(false)
      expect(testEnv.e2eSkipFetch).toBe(false)
    })
  })

  describe('opencodeProviderHook', () => {
    it('is undefined when unset, returns the value when set', () => {
      vi.stubEnv('YAAC_E2E_OPENCODE_PROVIDER', undefined)
      expect(testEnv.opencodeProviderHook).toBeUndefined()
      vi.stubEnv('YAAC_E2E_OPENCODE_PROVIDER', 'neuralwatt')
      expect(testEnv.opencodeProviderHook).toBe('neuralwatt')
    })
  })

  describe('toolLoginHook', () => {
    it('reads the per-tool login env var', () => {
      vi.stubEnv('YAAC_E2E_CLAUDE_LOGIN', '{"accessToken":"c"}')
      vi.stubEnv('YAAC_E2E_CODEX_LOGIN', '{"accessToken":"x"}')
      vi.stubEnv('YAAC_E2E_OPENCODE_LOGIN', 'sk-or-key')
      expect(testEnv.toolLoginHook('claude')).toBe('{"accessToken":"c"}')
      expect(testEnv.toolLoginHook('codex')).toBe('{"accessToken":"x"}')
      expect(testEnv.toolLoginHook('opencode')).toBe('sk-or-key')
    })

    it('is undefined when the tool hook is unset', () => {
      vi.stubEnv('YAAC_E2E_CLAUDE_LOGIN', undefined)
      expect(testEnv.toolLoginHook('claude')).toBeUndefined()
    })
  })
})
