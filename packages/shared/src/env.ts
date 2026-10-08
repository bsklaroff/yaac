import type { AccessMode, AgentTool, DriverKind } from '#types'

/**
 * The one place under `src/` that reads yaac's own environment variables
 * (the `no-process-env` lint rule enforces this). Each accessor owns its
 * variable's default and validation.
 *
 * Accessors read `process.env` on every access rather than caching, because
 * tests change these variables at runtime.
 *
 * `env` holds variables set by users, operators, the build, or the server.
 * `testEnv` holds ones only the test harness sets; production still reads
 * some of them, always at their defaults. The split is naming only.
 *
 * Code that forwards the whole environment to a subprocess
 * (`{ ...process.env }`) reads it at the call site with an inline disable.
 */

/** Set during real builds or runs (users, operators, the build, or the server). */
export const env = {
  /** `YAAC_DATA_DIR` override for the data dir (projects/sessions/lock). Unset → `~/.yaac`. */
  get dataDirOverride(): string | undefined {
    return process.env.YAAC_DATA_DIR
  },

  /**
   * `YAAC_GLOBAL_ROOT`, `YAAC_SERVER_LOCAL_ROOT`, `YAAC_NODE_LOCAL_ROOT` —
   * where the three storage tiers are mounted inside the server pod (see
   * paths.ts). Only the server Deployment sets them; on a host the tiers
   * are folders of the data dir.
   */
  get globalRootOverride(): string | undefined {
    return nonEmpty(process.env.YAAC_GLOBAL_ROOT)
  },
  get serverLocalRootOverride(): string | undefined {
    return nonEmpty(process.env.YAAC_SERVER_LOCAL_ROOT)
  },
  get nodeLocalRootOverride(): string | undefined {
    return nonEmpty(process.env.YAAC_NODE_LOCAL_ROOT)
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

  /**
   * `YAAC_BIND_ADDR` — interface the server's HTTP listener binds. Defaults
   * to loopback, which is what keeps a host install's API private.
   *
   * The in-cluster server sets `0.0.0.0` (a pod's loopback is unreachable)
   * and relies on its ingress NetworkPolicies to drop traffic from other
   * pods instead; `yaac cluster check` probes them
   * (docs/server-in-cluster.md).
   */
  get bindAddr(): string {
    const raw = process.env.YAAC_BIND_ADDR
    return raw === undefined || raw.trim() === '' ? '127.0.0.1' : raw.trim()
  },

  /**
   * `YAAC_IN_CLUSTER` — set to `1` only by the server Deployment manifest.
   * It selects the `k8s` driver (`#main/driver-choice`) and the registry's
   * in-cluster address. Declared explicitly
   * rather than inferred from `KUBERNETES_SERVICE_HOST`, which every
   * workspace pod also has.
   */
  get inCluster(): boolean {
    return process.env.YAAC_IN_CLUSTER === '1'
  },

  /** `YAAC_KIND_CLUSTER` — name of the kind cluster `yaac cluster install` manages. */
  get kindCluster(): string {
    return process.env.YAAC_KIND_CLUSTER ?? 'yaac'
  },

  /**
   * `YAAC_CNI_VETH_PREFIX` — name prefix the CNI gives each pod's host-side
   * veth. netd only redirects traffic from interfaces with this prefix, so
   * it never touches non-workload traffic.
   *
   * Unset → `cali` (Calico IPAM, as `yaac cluster install` sets up). Other
   * CNIs use other names, e.g. `eni` for the AWS VPC CNI.
   * `yaac cluster install --byo` refuses a prefix that matches no route on
   * the node.
   */
  get cniVethPrefix(): string | undefined {
    const raw = process.env.YAAC_CNI_VETH_PREFIX
    return raw && raw.trim() !== '' ? raw.trim() : undefined
  },

  /**
   * `YAAC_POD_CIDRS` — comma-separated pod CIDRs added to the ones netd
   * discovers and excludes from redirection. Needed when the CNI assigns pod
   * IPs outside any Calico IPPool or node `spec.podCIDR` (e.g. a VPC CNI);
   * otherwise pod-to-pod 443/80 traffic is sent through the proxy.
   *
   * Returned unvalidated so the consumer (`podCidrSources`) can report each
   * invalid entry by name instead of dropping it silently.
   */
  get podCidrs(): string[] {
    const raw = process.env.YAAC_POD_CIDRS
    if (!raw) return []
    return raw.split(',').map((c) => c.trim()).filter((c) => c.length > 0)
  },

  /**
   * `YAAC_KUBE_PROXY_EXTERNAL` — set to `1` when kube-proxy does not run as
   * a pod `--byo` can find, as on k3s (where it runs inside the kubelet).
   * Setting it wrongly only breaks egress: netd's Envoy cannot reach the
   * proxy's ClusterIP, and the NetworkPolicy still blocks direct egress.
   */
  get kubeProxyExternal(): boolean {
    return process.env.YAAC_KUBE_PROXY_EXTERNAL === '1'
  },

  /**
   * `YAAC_PREWARM_POOL_SIZE` — prewarmed workspaces per active project (`0`
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
   * workspaces. Unset → on; empty, "0", and "false" (case-insensitive) → off.
   */
  get autoTitles(): boolean {
    const raw = process.env.YAAC_AUTO_TITLES
    if (raw === undefined) return true
    const v = raw.trim().toLowerCase()
    if (v === '' || v === '0' || v === 'false') return false
    return true
  },

  /**
   * `YAAC_WORKSPACE_ID` — the workspace this process runs inside, set in
   * every workspace's environment by both drivers. Undefined outside a
   * workspace; empty counts as unset.
   *
   * `identify()` uses it: a server inside a workspace is reached only
   * through the outer install's port-forward, so an unproxied request is
   * local whatever Host it names (docs/remote-hosting.md).
   */
  get workspaceId(): string | undefined {
    const raw = (process.env.YAAC_WORKSPACE_ID ?? '').trim()
    return raw === '' ? undefined : raw
  },

  /**
   * `YAAC_DRIVER` — which substrate this install runs workspaces on. The
   * server does not use it to pick its driver; that follows from
   * {@link inCluster} (`#main/driver-choice`). The CLI reads it, before any
   * server exists, to decide whether to use the rootful podman engine.
   * Defaults to `k8s`; any other unknown value throws.
   */
  get driver(): DriverKind {
    const raw = (process.env.YAAC_DRIVER ?? '').trim()
    if (raw === '') return 'k8s'
    if (raw === 'k8s' || raw === 'containerless') return raw
    throw new Error(`YAAC_DRIVER must be "k8s" or "containerless" (got "${raw}")`)
  },

  /**
   * `YAAC_SECRETS` — the keys the server encrypts stored secrets with, as
   * `"<version>:<secret>,<version>:<secret>"`. New writes use the first
   * entry; the rest still decrypt older rows, so rotating a key needs only
   * a restart. Same format as better-auth's `BETTER_AUTH_SECRETS`.
   *
   * Usually unset: the server then generates its own key in the data dir
   * (`db/secret-key.ts`). A malformed entry throws, since a dropped key
   * would leave rows that can no longer be decrypted.
   */
  get secrets(): Array<{ version: number; value: string }> | null {
    const raw = process.env.YAAC_SECRETS
    if (raw === undefined || raw.trim() === '') return null
    const entries = raw.split(',').map((entry) => {
      const trimmed = entry.trim()
      const colon = trimmed.indexOf(':')
      if (colon === -1) {
        throw new Error(
          `YAAC_SECRETS entry "${trimmed}" must be "<version>:<secret>"`,
        )
      }
      const version = Number(trimmed.slice(0, colon))
      if (!Number.isInteger(version) || version < 0) {
        throw new Error(
          `YAAC_SECRETS version "${trimmed.slice(0, colon)}" must be a non-negative integer`,
        )
      }
      const value = trimmed.slice(colon + 1).trim()
      if (value === '') {
        throw new Error(`YAAC_SECRETS has an empty secret for version ${String(version)}`)
      }
      return { version, value }
    })
    const seen = new Set<number>()
    for (const { version } of entries) {
      if (seen.has(version)) {
        throw new Error(`YAAC_SECRETS repeats version ${String(version)}; each must be unique`)
      }
      seen.add(version)
    }
    return entries
  },

  /**
   * `YAAC_SECRET` — a single encryption key. When `YAAC_SECRETS` is also
   * set, it decrypts unversioned (bare-hex) payloads, like
   * `BETTER_AUTH_SECRET` beside `BETTER_AUTH_SECRETS`.
   */
  get secret(): string | undefined {
    const raw = process.env.YAAC_SECRET?.trim()
    return raw === undefined || raw === '' ? undefined : raw
  },

  /**
   * `YAAC_ACCESS_MODE` — the access mode the server is asked to run in
   * (`local` unless `tailnet`). Plumbing only: `yaac server start` sets it
   * from `--tailnet`, and `yaac cluster install` on the Deployment. The
   * server checks it against the mode its database records.
   */
  get accessMode(): AccessMode {
    return process.env.YAAC_ACCESS_MODE === 'tailnet' ? 'tailnet' : 'local'
  },

  /**
   * `YAAC_ACCESS_OWNER` — the tailnet login that claims a `local` install's
   * data when it is switched to `tailnet` (`--owner`). Plumbing like
   * `YAAC_ACCESS_MODE`.
   */
  get accessOwner(): string | undefined {
    const raw = process.env.YAAC_ACCESS_OWNER?.trim()
    return raw === undefined || raw === '' ? undefined : raw
  },

  /**
   * `YAAC_ALLOWED_HOSTS` — comma-separated extra hostnames the server's
   * Host-header check admits (e.g. the server's `srv.<tailnet>.ts.net`
   * MagicDNS name behind `tailscale serve`). Loopback is always allowed
   * regardless. Entries are trimmed and lowercased; empties dropped. Set by
   * `yaac server start --tailnet` and on the k8s Deployment; a user sets it
   * by hand only for a nested server reached through a forward.
   */
  get allowedHosts(): string[] {
    const raw = process.env.YAAC_ALLOWED_HOSTS
    if (!raw) return []
    return raw.split(',').map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0)
  },

  /**
   * `YAAC_FORWARD_BIND` — bind address for workspace port-forward listeners,
   * reported to clients as `forwardBindHost`. Defaults to loopback; a
   * remotely hosted server sets its tailnet IP so other tailnet devices can
   * reach forwarded ports.
   */
  get forwardBind(): string {
    const raw = process.env.YAAC_FORWARD_BIND
    return raw === undefined || raw.trim() === '' ? '127.0.0.1' : raw.trim()
  },

  /**
   * `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET` — the Tailscale OAuth
   * client `yaac cluster install --tailnet` gives the operator it installs
   * on a kind cluster. Undefined unless both are set.
   */
  get tailscaleOauthClient(): { id: string; secret: string } | undefined {
    const id = process.env.TS_OAUTH_CLIENT_ID?.trim()
    const secret = process.env.TS_OAUTH_CLIENT_SECRET?.trim()
    return id && secret ? { id, secret } : undefined
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

  /** `YAAC_SERVER_URL` — full server base URL, above `server.json`. */
  get serverUrlOverride(): string | undefined {
    return process.env.YAAC_SERVER_URL
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
   * `YAAC_STARTING_GRACE_MS` — how long a new workspace pod is protected
   * from the stale-workspace reaper. Creation starts tmux last, so without
   * this a reap pass could treat the pod as a zombie and clean it up
   * mid-create. Default 60_000 (also used for invalid values); tests shrink
   * it to trigger cleanup.
   */
  get startingGraceMs(): number {
    const raw = process.env.YAAC_STARTING_GRACE_MS
    if (raw === undefined || raw === '') return 60_000
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000
  },

  /**
   * `YAAC_TEST_SHARED_DB` — `1` makes `getDb()` share one in-memory PGlite
   * across data dirs, wiped when the data dir changes, instead of opening an
   * on-disk instance per dir. Set only by the unit projects' setup file:
   * booting PGlite and running migrations costs ~4s per fresh data dir.
   */
  get sharedTestDb(): boolean {
    return process.env.YAAC_TEST_SHARED_DB === '1'
  },

  /** `YAAC_E2E_NO_ATTACH` — `1` skips attaching to the terminal after create/restart. */
  get e2eNoAttach(): boolean {
    return process.env.YAAC_E2E_NO_ATTACH === '1'
  },

  /** `YAAC_E2E_SKIP_FETCH` — `1` skips the host-side git fetch during create. */
  get e2eSkipFetch(): boolean {
    return process.env.YAAC_E2E_SKIP_FETCH === '1'
  },

  /**
   * `YAAC_E2E_NO_TOKEN_REFRESH` — `1` makes every OAuth refresh grant a no-op.
   *
   * Set for the whole test suite. Inside a proxied yaac workspace, the
   * egress proxy replaces any `refresh_token` sent to a token endpoint with
   * the outer install's real token, so a test refresh would rotate that
   * token and sign out every workspace using it. Tests of refresh behavior
   * unset it per case and stub `fetch`.
   */
  get noTokenRefresh(): boolean {
    return process.env.YAAC_E2E_NO_TOKEN_REFRESH === '1'
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
   * auth daemon's install flow spawns (the vendors' `curl | bash`
   * installers) with a stub, so tests never install real software. Value is
   * a JSON argv array.
   */
  toolInstallCliHook(tool: AgentTool): string[] | undefined {
    const raw = tool === 'claude'
      ? process.env.YAAC_E2E_CLAUDE_INSTALL_CLI
      : tool === 'codex' ? process.env.YAAC_E2E_CODEX_INSTALL_CLI : undefined
    return parseArgvHook(raw)
  },
}

/** A set-but-empty variable reads as unset. */
function nonEmpty(raw: string | undefined): string | undefined {
  return raw === undefined || raw.trim() === '' ? undefined : raw
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
