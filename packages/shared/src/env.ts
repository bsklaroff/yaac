import type { AgentTool } from '#types'

/**
 * The single place that reads `process.env` for yaac's own variables. Every
 * other module under `src/` imports `env` / `testEnv` instead of touching
 * `process.env` directly (enforced by the `no-process-env` lint rule, which is
 * disabled only for this file). Each accessor owns the variable's default and
 * validation, so the contract for a knob lives in exactly one place.
 *
 * Accessors are getters (and one method) that read `process.env` on every
 * access — never cached. This is required: tests mutate these vars at runtime
 * (the `testEnv` injection hooks) and `paths.setDataDir()` overrides the data
 * dir, so an eager top-level read would freeze stale values.
 *
 * The two objects are split by *who sets the variable*:
 *   - `env`     — set during real builds or runs (users, operators, the build
 *                 toolchain, or the server itself).
 *   - `testEnv` — set only by the test harness. A few are read in production
 *                 too, but only ever via their built-in defaults; the override
 *                 is the test hook.
 * The split is a documentation/naming convention only — there is no rule
 * restricting who may import `testEnv`, since production reads several of its
 * defaults.
 *
 * Note: variables read for a different reason than yaac configuration — env
 * forwarded wholesale to a subprocess (`{ ...process.env }`), and the
 * user-driven `envPassthrough` / `$VAR` expansion that look up arbitrary names
 * — intentionally stay at their call sites with an inline `no-process-env`
 * disable. They are not yaac config and don't belong here.
 */

/** Set during real builds or runs (users, operators, the build, or the server). */
export const env = {
  /** `YAAC_DATA_DIR` override for the data dir (projects/sessions/lock). Unset → `~/.yaac`. */
  get dataDirOverride(): string | undefined {
    return process.env.YAAC_DATA_DIR
  },

  /**
   * `YAAC_USE_TOR` with permissive truthy semantics: unset, empty, "0", and
   * "false" (case-insensitive) are off; everything else is on.
   */
  get useTor(): boolean {
    const raw = process.env.YAAC_USE_TOR
    if (raw === undefined) return false
    const v = raw.trim().toLowerCase()
    if (v === '' || v === '0' || v === 'false') return false
    return true
  },

  /** `YAAC_HOST_TOR_SOCKS_URL` — host-side Tor SOCKS endpoint. */
  get torSocksUrl(): string {
    return process.env.YAAC_HOST_TOR_SOCKS_URL ?? 'socks5h://127.0.0.1:9050'
  },

  /**
   * `YAAC_SERVER_PORT` override for the server's listen port. Unset/empty →
   * `undefined` (caller falls back to `DEFAULT_SERVER_PORT`). `0` asks the OS
   * for an ephemeral port. A non-integer or out-of-range value throws so a
   * typo fails loudly instead of silently using the default.
   */
  get serverPort(): number | undefined {
    const raw = process.env.YAAC_SERVER_PORT
    if (raw === undefined || raw === '') return undefined
    const port = Number(raw)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(
        `YAAC_SERVER_PORT must be an integer between 0 and 65535, got ${raw}`,
      )
    }
    return port
  },

  /** `YAAC_K8S_REGISTRY` — host:port of the local OCI registry. */
  get k8sRegistry(): string {
    return process.env.YAAC_K8S_REGISTRY ?? 'localhost:5001'
  },

  /** `YAAC_KIND_CLUSTER` — name of the kind cluster `yaac cluster setup` manages. */
  get kindCluster(): string {
    return process.env.YAAC_KIND_CLUSTER ?? 'yaac'
  },

  /**
   * `YAAC_PREWARM_POOL_SIZE` — prewarmed sessions per active project (`0`
   * disables). Default 1; a non-integer or negative value falls back to 1.
   */
  get prewarmPoolSize(): number {
    const raw = process.env.YAAC_PREWARM_POOL_SIZE
    if (raw === undefined || raw === '') return 1
    const parsed = Number(raw)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1
  },

  /**
   * `YAAC_IMAGE_PREWARM` — background per-project image prewarm builds.
   * Unset → on; empty, "0", and "false" (case-insensitive) → off.
   */
  get imagePrewarm(): boolean {
    const raw = process.env.YAAC_IMAGE_PREWARM
    if (raw === undefined) return true
    const v = raw.trim().toLowerCase()
    if (v === '' || v === '0' || v === 'false') return false
    return true
  },

  /**
   * `YAAC_AUTO_TITLES` — background model-generated titles for untitled
   * sessions. Unset → on; empty, "0", and "false" (case-insensitive) → off.
   */
  get autoTitles(): boolean {
    const raw = process.env.YAAC_AUTO_TITLES
    if (raw === undefined) return true
    const v = raw.trim().toLowerCase()
    if (v === '' || v === '0' || v === 'false') return false
    return true
  },

  /** `YAAC_NESTED` — set to `1` by the server inside a nested (vcluster) session. */
  get nested(): boolean {
    return process.env.YAAC_NESTED === '1'
  },

  /**
   * `YAAC_RELAY_ADDR` — explicit `host:port` override for the proxy relay
   * (stream-relay.ts skips its address resolution entirely). Deployment
   * escape hatch for hosts with a direct TCP route to the proxy pod
   * (e.g. a server running on the cluster node itself), which skips the
   * default kubectl port-forward hop. Unset → resolved automatically
   * (a port-forward to the proxy Deployment, or the inner proxy's pod
   * IP when nested).
   */
  get relayAddr(): { host: string; port: number } | undefined {
    const raw = process.env.YAAC_RELAY_ADDR
    if (!raw || raw.trim() === '') return undefined
    const idx = raw.lastIndexOf(':')
    const host = idx > 0 ? raw.slice(0, idx) : ''
    const port = Number(raw.slice(idx + 1))
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`YAAC_RELAY_ADDR must be host:port, got ${raw}`)
    }
    return { host, port }
  },

  /**
   * `YAAC_ALLOWED_HOSTS` — comma-separated extra hostnames the server's
   * Host-header check admits (e.g. the server's `srv.<tailnet>.ts.net`
   * MagicDNS name behind `tailscale serve`). Loopback is always allowed
   * regardless. Entries are trimmed and lowercased; empties dropped.
   */
  get allowedHosts(): string[] {
    const raw = process.env.YAAC_ALLOWED_HOSTS
    if (!raw) return []
    return raw.split(',').map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0)
  },

  /**
   * `YAAC_TRUST_PROXY` — set to `1` only when the server runs behind a
   * trusted TLS-terminating proxy (tailscale serve). Gates trusting
   * `X-Forwarded-Proto` for the Secure cookie flag; without it a direct
   * loopback request could spoof the header into a posture change.
   */
  get trustProxy(): boolean {
    return process.env.YAAC_TRUST_PROXY === '1'
  },

  /**
   * `YAAC_REQUIRE_AUTH` — set to `1` to force the credential gate on even for
   * a purely-local (loopback-only) server. A loopback-only deployment skips
   * the bearer/cookie requirement by default (a browser or CLI on the same
   * machine needs no token); the Host + Origin guards still defend it against
   * a malicious website. Set this to opt back into a credential — for a
   * shared machine, or so the auth-path tests exercise the 401 gate.
   */
  get requireAuth(): boolean {
    return process.env.YAAC_REQUIRE_AUTH === '1'
  },

  /**
   * `YAAC_FORWARD_BIND` — bind address for session port-forward listeners.
   * Default loopback (today's behavior); a remote-hosting server sets its
   * tailnet IP so forwarded dev servers are reachable from other tailnet
   * devices. Deployment topology, not project config.
   */
  get forwardBind(): string {
    const raw = process.env.YAAC_FORWARD_BIND
    return raw === undefined || raw.trim() === '' ? '127.0.0.1' : raw.trim()
  },

  /**
   * `YAAC_BUNDLED` — set to `'true'` by tsup in the shipped bundle (a build
   * define, not a runtime var). In the bundle static assets live in `dist/`;
   * in dev/test it is unset.
   */
  get bundled(): boolean {
    return Boolean(process.env.YAAC_BUNDLED)
  },

  /**
   * `YAAC_DESKTOP_RENDERER_URL` — override for the URL the desktop shell's
   * window loads (the `desktop:hot` dev flow points it at Vite, which proxies
   * the API back to the server for frontend hot-reload). Unset → the resolved
   * server origin.
   */
  get desktopRendererUrl(): string | undefined {
    return process.env.YAAC_DESKTOP_RENDERER_URL
  },
}

/** Set only by the test harness (a few are read in prod via their defaults). */
export const testEnv = {
  /** `YAAC_BUILD_ID` — pre-computed build id for tests running from source. */
  get buildIdOverride(): string | undefined {
    return process.env.YAAC_BUILD_ID
  },

  /** `YAAC_SERVER_URL` — full server base URL; paired with the secret below. */
  get serverUrlOverride(): string | undefined {
    return process.env.YAAC_SERVER_URL
  },

  /** `YAAC_SERVER_SECRET` — bearer token for the injected server URL. */
  get serverSecretOverride(): string | undefined {
    return process.env.YAAC_SERVER_SECRET
  },

  /**
   * `YAAC_K8S_NAMESPACE` — namespace holding every yaac k8s object. Tests
   * isolate per-file namespaces here; production uses the default `yaac`.
   */
  get k8sNamespace(): string {
    return process.env.YAAC_K8S_NAMESPACE ?? 'yaac'
  },

  /** `YAAC_IMAGE_PREFIX` — prefix for built/pushed image names (test isolation). */
  get imagePrefix(): string | undefined {
    return process.env.YAAC_IMAGE_PREFIX
  },

  /** `YAAC_REQUIRE_PREBUILT_IMAGES` — `1` fails fast if an image isn't prebuilt. */
  get requirePrebuiltImages(): boolean {
    return process.env.YAAC_REQUIRE_PREBUILT_IMAGES === '1'
  },

  /** `YAAC_PROXY_IMAGE` — proxy image tag override. Production uses `yaac-proxy`. */
  get proxyImage(): string {
    return process.env.YAAC_PROXY_IMAGE ?? 'yaac-proxy'
  },

  /** `YAAC_NETD_IMAGE` — netd image tag override. Production uses `yaac-netd`. */
  get netdImage(): string {
    return process.env.YAAC_NETD_IMAGE ?? 'yaac-netd'
  },


  /**
   * `YAAC_STARTING_GRACE_MS` — grace window protecting freshly-created session
   * pods from the stale-session reaper. session-create's retry loop recreates
   * the Job between attempts and does not start tmux until the last step, so
   * without a grace period a concurrent reap pass (`reconcileStaleSessions`)
   * can classify the pod as a zombie — firing
   * cleanupSessionDetached, which removes the session's allowedHosts from the
   * proxy mid-creation. Default 60_000; a non-finite or negative value falls
   * back to the default. Tests shrink it to provoke cleanup on sessions they
   * just created.
   */
  get startingGraceMs(): number {
    const raw = process.env.YAAC_STARTING_GRACE_MS
    if (raw === undefined || raw === '') return 60_000
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000
  },

  /** `YAAC_E2E_NO_ATTACH` — `1` skips the post-provision `kubectl exec -it` attach. */
  get e2eNoAttach(): boolean {
    return process.env.YAAC_E2E_NO_ATTACH === '1'
  },

  /** `YAAC_E2E_SKIP_FETCH` — `1` skips the host-side git fetch during create. */
  get e2eSkipFetch(): boolean {
    return process.env.YAAC_E2E_SKIP_FETCH === '1'
  },

  /** `YAAC_E2E_OPENCODE_PROVIDER` — picks the opencode provider for e2e (defaults to openrouter). */
  get opencodeProviderHook(): string | undefined {
    return process.env.YAAC_E2E_OPENCODE_PROVIDER
  },

  /** `YAAC_E2E_PI_PROVIDER` — picks the pi provider for e2e (defaults to openrouter). */
  get piProviderHook(): string | undefined {
    return process.env.YAAC_E2E_PI_PROVIDER
  },

  /**
   * `YAAC_E2E_{CLAUDE,CODEX,OPENCODE,PI}_LOGIN` — short-circuits the native
   * tool login flow with a serialized OAuth bundle (claude/codex) or a raw api
   * key (opencode/pi). Returns the raw payload for the given tool, or
   * `undefined`.
   */
  toolLoginHook(tool: AgentTool): string | undefined {
    if (tool === 'claude') return process.env.YAAC_E2E_CLAUDE_LOGIN
    if (tool === 'codex') return process.env.YAAC_E2E_CODEX_LOGIN
    if (tool === 'pi') return process.env.YAAC_E2E_PI_LOGIN
    return process.env.YAAC_E2E_OPENCODE_LOGIN
  },

  /**
   * `YAAC_E2E_{CLAUDE,CODEX}_LOGIN_CLI` — replaces the vendor CLI argv the
   * server's web sign-in flow spawns (`claude setup-token` / `codex login
   * --device-auth`) with a stub, so tests can script the whole interaction
   * without a real OAuth round trip. Value is a JSON argv array.
   */
  toolLoginCliHook(tool: AgentTool): string[] | undefined {
    const raw = tool === 'claude'
      ? process.env.YAAC_E2E_CLAUDE_LOGIN_CLI
      : tool === 'codex' ? process.env.YAAC_E2E_CODEX_LOGIN_CLI : undefined
    return parseArgvHook(raw)
  },

  /**
   * `YAAC_E2E_{CLAUDE,CODEX}_INSTALL_CLI` — replaces the installer argv the
   * server's web install flow spawns (claude's `curl | bash` installer /
   * `npm install -g @openai/codex`) with a stub, so tests never install
   * real software. Value is a JSON argv array.
   */
  toolInstallCliHook(tool: AgentTool): string[] | undefined {
    const raw = tool === 'claude'
      ? process.env.YAAC_E2E_CLAUDE_INSTALL_CLI
      : tool === 'codex' ? process.env.YAAC_E2E_CODEX_INSTALL_CLI : undefined
    return parseArgvHook(raw)
  },
}

/** Parse a JSON argv-array hook value; malformed → undefined (real CLI used). */
function parseArgvHook(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((p) => typeof p === 'string')) {
      return parsed
    }
  } catch {
    // malformed hook → ignored, real CLI is used
  }
  return undefined
}
