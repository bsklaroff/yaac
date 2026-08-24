import { describe, it, expect, afterEach, vi } from 'vitest'
import { env, testEnv } from '#env'

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

  describe('serverPort', () => {
    it('is undefined when YAAC_SERVER_PORT is unset or empty', () => {
      vi.stubEnv('YAAC_SERVER_PORT', undefined)
      expect(env.serverPort).toBeUndefined()
      vi.stubEnv('YAAC_SERVER_PORT', '')
      expect(env.serverPort).toBeUndefined()
    })

    it('parses a valid port', () => {
      vi.stubEnv('YAAC_SERVER_PORT', '9999')
      expect(env.serverPort).toBe(9999)
    })

    it('allows 0 (OS-assigned ephemeral)', () => {
      vi.stubEnv('YAAC_SERVER_PORT', '0')
      expect(env.serverPort).toBe(0)
    })

    it('throws on a non-numeric value', () => {
      vi.stubEnv('YAAC_SERVER_PORT', 'nope')
      expect(() => env.serverPort).toThrow(/YAAC_SERVER_PORT/)
    })

    it('throws on an out-of-range value', () => {
      vi.stubEnv('YAAC_SERVER_PORT', '70000')
      expect(() => env.serverPort).toThrow(/between 0 and 65535/)
    })
  })

  describe('kindCluster', () => {
    it('defaults to yaac when unset', () => {
      vi.stubEnv('YAAC_KIND_CLUSTER', undefined)
      expect(env.kindCluster).toBe('yaac')
    })

    it('returns the override when set', () => {
      vi.stubEnv('YAAC_KIND_CLUSTER', 'yaac-alt')
      expect(env.kindCluster).toBe('yaac-alt')
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

  describe('imagePrewarm', () => {
    it('defaults to on when unset', () => {
      vi.stubEnv('YAAC_IMAGE_PREWARM', undefined)
      expect(env.imagePrewarm).toBe(true)
    })

    it('treats empty, 0, and false (any case) as off', () => {
      for (const v of ['', '0', 'false', 'FALSE', ' 0 ']) {
        vi.stubEnv('YAAC_IMAGE_PREWARM', v)
        expect(env.imagePrewarm).toBe(false)
      }
    })

    it('treats other values as on', () => {
      for (const v of ['1', 'true', 'yes']) {
        vi.stubEnv('YAAC_IMAGE_PREWARM', v)
        expect(env.imagePrewarm).toBe(true)
      }
    })
  })

  describe('autoTitles', () => {
    it('defaults to on when unset', () => {
      vi.stubEnv('YAAC_AUTO_TITLES', undefined)
      expect(env.autoTitles).toBe(true)
    })

    it('treats empty, 0, and false (any case) as off', () => {
      for (const v of ['', '0', 'false', 'FALSE', ' 0 ']) {
        vi.stubEnv('YAAC_AUTO_TITLES', v)
        expect(env.autoTitles).toBe(false)
      }
    })

    it('treats other values as on', () => {
      for (const v of ['1', 'true', 'yes']) {
        vi.stubEnv('YAAC_AUTO_TITLES', v)
        expect(env.autoTitles).toBe(true)
      }
    })
  })

  describe('worktreeId', () => {
    it('answers the id a worktree stamps, and undefined outside one', () => {
      vi.stubEnv('YAAC_WORKTREE_ID', 'abcd1234')
      expect(env.worktreeId).toBe('abcd1234')
      vi.stubEnv('YAAC_WORKTREE_ID', undefined)
      expect(env.worktreeId).toBeUndefined()
      // Blank is unset, so an explicit `YAAC_WORKTREE_ID=` clears it rather
      // than reading as "some worktree" to the credential gate.
      vi.stubEnv('YAAC_WORKTREE_ID', '  ')
      expect(env.worktreeId).toBeUndefined()
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

  describe('desktopRendererUrl', () => {
    it('is undefined when YAAC_DESKTOP_RENDERER_URL is unset', () => {
      vi.stubEnv('YAAC_DESKTOP_RENDERER_URL', undefined)
      expect(env.desktopRendererUrl).toBeUndefined()
    })

    it('returns the override when set', () => {
      vi.stubEnv('YAAC_DESKTOP_RENDERER_URL', 'http://localhost:1420/')
      expect(env.desktopRendererUrl).toBe('http://localhost:1420/')
    })
  })

  describe('allowedHosts', () => {
    it('defaults to an empty list', () => {
      vi.stubEnv('YAAC_ALLOWED_HOSTS', undefined)
      expect(env.allowedHosts).toEqual([])
      vi.stubEnv('YAAC_ALLOWED_HOSTS', '')
      expect(env.allowedHosts).toEqual([])
    })

    it('splits, trims, lowercases, and drops empties', () => {
      vi.stubEnv('YAAC_ALLOWED_HOSTS', ' Srv.Tailnet.TS.NET , other.host ,, ')
      expect(env.allowedHosts).toEqual(['srv.tailnet.ts.net', 'other.host'])
    })
  })

  describe('trustProxy', () => {
    it('is true only when YAAC_TRUST_PROXY is exactly "1"', () => {
      vi.stubEnv('YAAC_TRUST_PROXY', '1')
      expect(env.trustProxy).toBe(true)
      vi.stubEnv('YAAC_TRUST_PROXY', 'true')
      expect(env.trustProxy).toBe(false)
      vi.stubEnv('YAAC_TRUST_PROXY', undefined)
      expect(env.trustProxy).toBe(false)
    })
  })

  describe('requireAuth', () => {
    it('is true only when YAAC_REQUIRE_AUTH is exactly "1"', () => {
      vi.stubEnv('YAAC_REQUIRE_AUTH', '1')
      expect(env.requireAuth).toBe(true)
      vi.stubEnv('YAAC_REQUIRE_AUTH', 'true')
      expect(env.requireAuth).toBe(false)
      vi.stubEnv('YAAC_REQUIRE_AUTH', undefined)
      expect(env.requireAuth).toBe(false)
    })
  })

  describe('forwardBind', () => {
    it('defaults to loopback', () => {
      vi.stubEnv('YAAC_FORWARD_BIND', undefined)
      expect(env.forwardBind).toBe('127.0.0.1')
      vi.stubEnv('YAAC_FORWARD_BIND', '  ')
      expect(env.forwardBind).toBe('127.0.0.1')
    })

    it('returns the trimmed configured address', () => {
      vi.stubEnv('YAAC_FORWARD_BIND', ' 100.64.0.7 ')
      expect(env.forwardBind).toBe('100.64.0.7')
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

  describe('serverUrlOverride / serverSecretOverride', () => {
    it('return undefined when unset and the value when set', () => {
      vi.stubEnv('YAAC_SERVER_URL', undefined)
      vi.stubEnv('YAAC_SERVER_SECRET', undefined)
      expect(testEnv.serverUrlOverride).toBeUndefined()
      expect(testEnv.serverSecretOverride).toBeUndefined()
      vi.stubEnv('YAAC_SERVER_URL', 'http://127.0.0.1:8787')
      vi.stubEnv('YAAC_SERVER_SECRET', 'secret')
      expect(testEnv.serverUrlOverride).toBe('http://127.0.0.1:8787')
      expect(testEnv.serverSecretOverride).toBe('secret')
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

  describe('netdImage', () => {
    it('defaults to "yaac-netd" when unset', () => {
      // e2e servers must set this: with requirePrebuiltImages on, falling
      // through to the production name demands a tag only a production
      // install would have pushed.
      vi.stubEnv('YAAC_NETD_IMAGE', undefined)
      expect(testEnv.netdImage).toBe('yaac-netd')
      vi.stubEnv('YAAC_NETD_IMAGE', 'yaac-test-netd')
      expect(testEnv.netdImage).toBe('yaac-test-netd')
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

  describe('noTokenRefresh', () => {
    it('is true only when its var is exactly "1"', () => {
      // The suite sets this globally, so an unset case has to be stubbed
      // rather than assumed — and the exact-"1" rule is what lets the
      // refresh-grant tests opt back in by stubbing it empty.
      vi.stubEnv('YAAC_E2E_NO_TOKEN_REFRESH', '1')
      expect(testEnv.noTokenRefresh).toBe(true)
      vi.stubEnv('YAAC_E2E_NO_TOKEN_REFRESH', '')
      expect(testEnv.noTokenRefresh).toBe(false)
      vi.stubEnv('YAAC_E2E_NO_TOKEN_REFRESH', undefined)
      expect(testEnv.noTokenRefresh).toBe(false)
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
  describe('toolLoginCliHook', () => {
    it('parses a JSON argv array and rejects malformed or non-argv values', () => {
      vi.stubEnv('YAAC_E2E_CLAUDE_LOGIN_CLI', undefined)
      expect(testEnv.toolLoginCliHook('claude')).toBeUndefined()
      vi.stubEnv('YAAC_E2E_CLAUDE_LOGIN_CLI', '["node","/stubs/claude.cjs"]')
      expect(testEnv.toolLoginCliHook('claude')).toEqual(['node', '/stubs/claude.cjs'])
      vi.stubEnv('YAAC_E2E_CLAUDE_LOGIN_CLI', '{not json')
      expect(testEnv.toolLoginCliHook('claude')).toBeUndefined()
      vi.stubEnv('YAAC_E2E_CLAUDE_LOGIN_CLI', '[]')
      expect(testEnv.toolLoginCliHook('claude')).toBeUndefined()
      vi.stubEnv('YAAC_E2E_CLAUDE_LOGIN_CLI', '[1,2]')
      expect(testEnv.toolLoginCliHook('claude')).toBeUndefined()
    })

    it('reads the per-tool variable and has no opencode hook', () => {
      vi.stubEnv('YAAC_E2E_CODEX_LOGIN_CLI', '["codex-stub"]')
      expect(testEnv.toolLoginCliHook('codex')).toEqual(['codex-stub'])
      expect(testEnv.toolLoginCliHook('opencode')).toBeUndefined()
    })
  })

  describe('toolInstallCliHook', () => {
    it('parses a JSON argv array and rejects malformed or non-argv values', () => {
      vi.stubEnv('YAAC_E2E_CLAUDE_INSTALL_CLI', undefined)
      expect(testEnv.toolInstallCliHook('claude')).toBeUndefined()
      vi.stubEnv('YAAC_E2E_CLAUDE_INSTALL_CLI', '["node","/stubs/install.cjs"]')
      expect(testEnv.toolInstallCliHook('claude')).toEqual(['node', '/stubs/install.cjs'])
      vi.stubEnv('YAAC_E2E_CLAUDE_INSTALL_CLI', '{not json')
      expect(testEnv.toolInstallCliHook('claude')).toBeUndefined()
      vi.stubEnv('YAAC_E2E_CLAUDE_INSTALL_CLI', '[]')
      expect(testEnv.toolInstallCliHook('claude')).toBeUndefined()
    })

    it('reads the per-tool variable and has no opencode hook', () => {
      vi.stubEnv('YAAC_E2E_CODEX_INSTALL_CLI', '["codex-install-stub"]')
      expect(testEnv.toolInstallCliHook('codex')).toEqual(['codex-install-stub'])
      expect(testEnv.toolInstallCliHook('opencode')).toBeUndefined()
    })
  })
})
