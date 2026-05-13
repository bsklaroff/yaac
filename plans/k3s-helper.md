# k3s host-cluster helper

Let yaac session containers talk to a k3s cluster running on the host
(Rancher Desktop's default). Single-purpose helper config; no generic
"host services" surface in this scope.

## Why not the proxy sidecar

The HTTP proxy MITMs TLS with its own CA. kubectl pins to the k3s CA
embedded in the kubeconfig — MITM would break it. Proxy-level upstream
redirects also only fire for hosts that match an allowlist pattern; we'd
have to invent a fake hostname *and* bypass MITM, which is the proxy's
job, not ours.

The right layer is a TCP relay sidecar — same pattern as
`src/lib/container/pg-relay.ts`. The relay forwards bytes from a
container-network hostname to `host.containers.internal:<k3s-port>`,
and kubectl talks end-to-end TLS through it.

## User-facing surface

One new field in `yaac-config.json`:

```jsonc
{
  "k3s": {
    "kubeconfigPath": "~/.kube/config",   // optional; defaults to ~/.kube/config
    "hostPort": 6443                      // optional; defaults to 6443
  }
}
```

Setting `k3s` to any object enables the helper. Omitting it (today's
behavior) does nothing. No CLI flags — config-file only, like `pgRelay`.

Validation rules (parsed in `src/lib/project/config.ts`):
- `k3s` must be an object (not array / null).
- `kubeconfigPath`, if present, must be a string. `~` and `$VAR` expand
  via `expandEnvVars` (reuse the existing helper used by `bindMounts`).
- After expansion, the path must be absolute.
- `hostPort`, if present, must be an integer in [1, 65535].

Add `k3s` to `KNOWN_KEYS` at `src/lib/project/config.ts:7`.

## Runtime pieces

### 1. K3s relay sidecar — `src/lib/container/k3s-relay.ts` (new)

Near-clone of `pg-relay.ts`. Differences:

- Container name: `yaac-k3s-relay`.
- Network alias: `k3s.yaac.internal` (attach via `NetworkingConfig.
  EndpointsConfig[network].Aliases = ['k3s.yaac.internal']`). The
  session container resolves this name via podman's embedded DNS.
- socat target: `TCP:host.containers.internal:${hostPort}`.
- socat listen port: fixed `6443` inside the relay container. We don't
  expose it to the host — sessions reach it through the internal
  network alias only.
- One sidecar per daemon (singleton), regardless of how many sessions
  use it. Reuse if already running and healthy; recreate on host-port
  change.

Exported (each needs a unit test per CLAUDE.md):
- `class K3sRelayClient` with `ensureRunning(config)`, `stop()`,
  `get ip()`, `get alias()` (returns `'k3s.yaac.internal'`),
  `get containerPort()` (returns `6443`).
- `const k3sRelay = new K3sRelayClient()` singleton, parallel to
  `pgRelay`.

### 2. Derived kubeconfig — `src/lib/container/k3s-kubeconfig.ts` (new)

The host's kubeconfig points at `https://127.0.0.1:6443`. We can't
remap loopback inside the container, so we generate a session-local
copy and rewrite the cluster's `server` URL.

```ts
export interface DeriveKubeconfigInput {
  hostKubeconfigPath: string  // absolute, post-expand
  outputPath: string          // absolute, where to write the derived file
}

export async function deriveSessionKubeconfig(
  input: DeriveKubeconfigInput
): Promise<void>
```

Behavior:
- Read the host kubeconfig with `fs/promises`.
- Parse as YAML — add `yaml` as an **exact-version** dep
  (`pnpm add -E yaml`); the repo doesn't currently have one.
- For every `clusters[].cluster.server` whose URL host is `127.0.0.1`,
  `localhost`, `::1`, or `0.0.0.0`: rewrite the host to
  `k3s.yaac.internal`, preserve scheme and path, drop the port if it
  matches the configured `hostPort` (the relay always listens on
  6443), otherwise keep it.
- Leave all other fields untouched (auth data, contexts, users, certs).
- Add `tls-server-name: 127.0.0.1` to each rewritten cluster entry so
  kubectl's SAN check passes against Rancher Desktop's cert (whose
  SANs cover `127.0.0.1` but not our alias).
- Write to `outputPath` atomically (write to `.tmp`, rename).

Unit tests cover: loopback-host rewrite, non-loopback left alone,
multiple clusters, port preserved when non-default, `tls-server-name`
added.

### 3. Wire into session-create — `src/daemon/session-create.ts`

After the `pgRelay` block (around line 644-653), add a `k3s` block:

```ts
const k3sConfig = config.k3s
if (k3sConfig) {
  emit('Starting k3s relay sidecar...', options)
  await k3sRelay.ensureRunning(k3sConfig)

  const hostKubeconfig = expandEnvVars(
    k3sConfig.kubeconfigPath ?? '~/.kube/config'
  ).replace(/^~/, process.env.HOME ?? '')
  const sessionKubeconfig = path.join(
    projectConfigDir(projectSlug), 'sessions', sessionId, 'kubeconfig'
  )
  await fs.mkdir(path.dirname(sessionKubeconfig), { recursive: true })
  await deriveSessionKubeconfig({
    hostKubeconfigPath: hostKubeconfig,
    outputPath: sessionKubeconfig,
  })
}
```

Then in the container-create call (where existing `bindMounts` are
spread at session-create.ts:274), append the kubeconfig bind-mount and
the `KUBECONFIG` env var when `k3sConfig` is set:

- Bind: `${sessionKubeconfig}:/home/yaac/.kube/config:ro` (host file,
  read-only — derived from user's file but never written back).
- Env: `KUBECONFIG=/home/yaac/.kube/config`.

The session container is already on `yaac-sessions` network (proxy
config), so it auto-resolves `k3s.yaac.internal` via podman DNS — no
extra config needed.

### 4. Lifecycle / cleanup

The relay sidecar follows pg-relay's "long-lived daemon singleton"
model: started lazily on first k3s-enabled session, never stopped
automatically. That keeps the scope tiny. If a future need arises
(e.g. host k3s port changed), users can `yaac proxy stop` or restart
the daemon.

Session teardown: derived kubeconfig files under
`projectConfigDir/sessions/<id>/` get cleaned up alongside other
per-session state in the existing session-delete path. Plumb removal
into `deleteSession` if a session-dir cleanup hook doesn't already
exist; otherwise no work needed.

## What's NOT in this plan

Each of these is a separate change with its own consumer:

- Generic `hostServices` config. Skipped — user picked the k3s helper.
  Revisit only if a second host-service use case (Redis, etc.) arrives.
- Auto-detecting whether the host actually runs k3s, validating the
  kubeconfig before container start, surfacing relay/k3s connection
  errors as preflight failures.
- Mounting kubelet client certs or service-account tokens. The
  kubeconfig carries its own auth (Rancher Desktop ships a
  client-cert-based admin user).
- Per-session network policy / scoping which API resources the
  container can hit. The relay forwards raw TCP; everything the host
  cluster grants the kubeconfig user is reachable.
- Running k0s *inside* the container. Different blast-radius
  conversation — see prior thread, requires expanding the nestable
  container's capability envelope (cgroups v2, NET_ADMIN, etc.).
- Multi-cluster kubeconfig support (current contexts only point at
  one cluster URL). Trivial to extend later when needed.

## Test surface (per CLAUDE.md)

### Unit tests (`test/unit/`)
- `k3s-relay.test.ts`: covers `ensureRunning` (start, reuse,
  port-change recreate), `stop`. Mocks podman like `pg-relay.test.ts`
  does today.
- `k3s-kubeconfig.test.ts`: covers `deriveSessionKubeconfig` cases
  enumerated above.
- `config.test.ts`: extend the existing parse-config tests with
  positive and negative cases for the `k3s` field — valid object,
  bad `hostPort`, bad `kubeconfigPath` type, non-absolute path after
  expansion.

### E2e tests (`test/e2e/`)
No new CLI args, so per CLAUDE.md no new e2e test is required. If a
behavior smoke test feels valuable, add one that:
- writes a fake `~/.kube/config` pointing at `127.0.0.1:6443`,
- starts a session with `k3s: {}` config,
- exec's into the container, reads `$KUBECONFIG`, parses the YAML,
- asserts `server: https://k3s.yaac.internal` and
  `tls-server-name: 127.0.0.1` are present.

The relay's actual TCP forwarding can't be tested without a host
k3s, so leave that to manual verification.

## Implementation order

1. Add `K3sConfig` type to `src/shared/types.ts:YaacConfig`.
2. Add parsing in `src/lib/project/config.ts` + unit tests.
3. Add `src/lib/container/k3s-kubeconfig.ts` + unit tests.
   (`pnpm add -E yaml` first.)
4. Add `src/lib/container/k3s-relay.ts` + unit tests.
5. Wire both into `src/daemon/session-create.ts`.
6. Manual test against local Rancher Desktop.
7. `pnpm lint`.

Each step is independently mergeable.
