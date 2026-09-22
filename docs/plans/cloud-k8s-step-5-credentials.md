# Cloud k8s, step 5: credentials off the shared tier

Step 5 of docs/plans/cloud-k8s.md. This document plans that step alone.

Goal: the egress proxy pod mounts nothing from the host and holds no state
of its own. Everything it needs arrives as Kubernetes objects it watches,
and everything it reports goes out as objects the server watches — the
credentials, the project secret values, the ssh keys, the per-worktree
registrations, the CA, the blocked-host and git-auth-failure records.
`.credentials/` then has one reader and one writer, the server, and demotes
to SERVER-LOCAL; `/data` is an emptyDir; nothing about the proxy is on a
reconcile tick.

Gate, from the plan: the egress e2e tier green, and
`grep hostPath packages/server/src/drivers/k8s/cluster/proxy-manifests.ts`
prints nothing. Restated as a procedure at the end.

## Why objects and informers, not a push channel

The proxy's state reaches it today over three channels, and each one is a
process the server has to keep in sync: `PUT /secrets` and `PUT /agent/keys`
land in memory and are lost with the pod, so `reconcileProxySecrets` PUTs
every tick and `reconcileSshKeys` probes for the loss signature on every
reconnect; `PUT /worktrees/:id` is write-through persisted to a hostPath so
a replaced pod can reload it; the credential files and the two record files
are a hostPath in each direction. Carrying the credentials over the same
HTTP push would add a third reconcile and a third heal.

The cluster already has a durable, watchable, namespace-scoped store with
sub-second change delivery, and both sides already run informers against it
(`pod-watch.ts` in the proxy; `ClusterCache` in the server). Writing the
proxy's inputs as Secrets and ConfigMaps and reading its outputs the same
way removes every reconcile step, every heal, every "memory-only, so re-push
after a replacement" comment, the `/data` claim this step would otherwise
need, and most of the control API. A replaced pod restores itself from the
informer's initial list. What is left on HTTP is the one thing that is
genuinely a request/response between a worktree and the server: the
`yaac-mama` queue.

## The objects

All in the install namespace, all labelled `app: yaac-proxy`. Who writes
each is fixed and single, which is the plan's one-writer invariant applied
to objects.

| object | kind | writer | reader | content |
|---|---|---|---|---|
| `yaac-proxy-credentials` | Secret | server | proxy informer | `claude.json`, `codex.json`, `opencode.json`, `pi.json`, `github.json` (each file's JSON, verbatim); `ssh-keys.json` (`[{pattern, host, privateKey, knownHostsEntry}]`, the OpenSSH container `#lib/ssh-key` encodes from the sealed seed) |
| `yaac-proxy-secrets-<project>` | Secret, one per project | server | proxy informer (label `yaac.proxy-secrets`) | `values.json`: `{ "<slug>/<NAME>": value }` — the opened project secret values behind that project's `secretRef` rules |
| `yaac-proxy-reg-<worktreeId>` | ConfigMap, one per worktree | server | proxy informer (label `yaac.proxy-registration`) | `registration.json`: the `WorktreeRegistration` payload as `PUT /worktrees/:id` carries it today — rules with `secretRef`s (never values), allowed hosts, repo URL, tool, project, test redirects |
| `yaac-proxy-refreshed` | Secret | proxy | server informer | `claude.json`, `codex.json`: OAuth bundles the proxy captured from a worktree's refresh, in the credentials-file shape |
| `yaac-proxy-ca` | Secret | proxy | server (get) | `ca.key`, `ca.pem`, `ca-bundle.pem` |
| `yaac-proxy-state` | ConfigMap | proxy | server informer | `blocked-hosts.json`, `git-auth-failures.json`, the same maps the `/data` files hold |

Names: worktree ids are UUIDs, so `yaac-proxy-reg-<id>` fits the 253-char
object-name limit; project slugs are not DNS-safe, so the secrets name uses
the `safeSlug + hash8` shape `projectRegistryName` already uses, lifted into
a shared helper.

## Decisions

- **The proxy is stateless.** `/data` becomes an emptyDir; `state-files.ts`,
  the write-throughs, `loadWorktrees`, `loadBlockedHosts` and
  `loadGitAuthFailures` are deleted. Tor's state re-bootstraps per pod,
  which is what `USE_TOR` installs paid on every image upgrade anyway. The
  RWO claim, the seed pod, the install step and the check gate the previous
  version of this plan needed all vanish with it.
- **One writer per object, and the proxy's own writes are pre-created.**
  RBAC cannot scope `create` by `resourceNames`, so `ensureProxyResources`
  creates `yaac-proxy-refreshed`, `yaac-proxy-ca` and `yaac-proxy-state`
  empty, and the proxy's Role grants `get`, `update` and `patch` on exactly
  those three names. For its reads the proxy gets `get/list/watch` on
  secrets and configmaps in its namespace: `list` and `watch` cannot be
  name-scoped either, and the namespace holds nothing but yaac's own
  objects (the proxy already carries `yaac-proxy-auth` in its env). The
  informers still pass a `metadata.name` field selector where one object is
  meant, which client-node's `ListWatch` supports.
- **Credentials are wholesale; project secrets and registrations are per
  object.** The tool credential set is one install-wide thing, so it is one
  Secret replaced whole on every host-store write. Project secret values are
  edited per project and opened by decryption, so re-rendering every
  project's values to change one is the work the current code deliberately
  avoids; one Secret per project keeps that. Registrations are created and
  deleted with worktrees, so one object per worktree lets the existing
  per-worktree lifecycle own them and the proxy's index be a plain informer
  cache keyed by name.
- **No `ownerReferences` on registrations.** A registration is written in
  `prepareWorkspaceSubstrate`, before the Job exists, so it cannot be owned
  at creation. Teardown deletes it where it calls `removeWorktree` today, and
  the orphan reaper's label sweep covers a teardown that never ran.
- **Refreshed bundles are durable the moment they are captured.** The proxy
  writes `yaac-proxy-refreshed` synchronously in the token-response handler,
  exactly where it writes the file today, so a codex rotation (single-use
  refresh token) survives the pod dying a millisecond later. The server's
  informer delivers it; the domain adopts it with the newest-wins compare it
  already uses for every writer; the next credentials push carries it, and
  the proxy drops a captured slot when the pushed bundle carries the same
  access token. Until then the proxy serves the newer of the two.
- **The record maps are an informer cache, not a mirror.** `blockedHosts(id)`
  and `gitAuthFailures(slug)` read the `yaac-proxy-state` cache
  synchronously; the delta is what notifies the snapshot. The proxy debounces
  its writes (250ms) because a blocked-host burst is common.
- **Credentials become durable in etcd.** The values project secrets and
  ssh keys were deliberately kept out of any file the pod mounts now sit in
  namespace Secrets. On kind that is the host's own disk, where
  `.credentials/` already is; on a managed cluster it is the control plane's
  store, encrypted at rest by default on EKS, AKS and GKE, and where every
  Kubernetes workload keeps this. It is strictly better than the RWX export
  the plan refuses, and the sealing key in `secret.key` keeps protecting the
  copy in the database. Worktree pods and builder pods mount no
  service-account token, so no untrusted code can read a Secret. The one
  reader that widens is the proxy, which already holds all of it in memory.
- **`.credentials/` demotes to SERVER-LOCAL and moves nowhere.** Every tier
  root resolves to the data dir today, so the demotion is a declaration;
  step 1's rename of server-local writers picks it up (see risks).
  `proxyDataHostDir()` is deleted; the seed below is its last reader.
- **The old-proxy window closes on the first create.** After a server
  upgrade the proxy rolls on the next worktree launch, and
  `prepareWorkspaceSubstrate` calls `ensureRunning` BEFORE it registers, so
  a create never registers against a proxy that cannot see the object.
  Between the upgrade and that create the old proxy keeps reading the files
  (still there), keeps writing refreshed bundles into them (the server keeps
  reading those files), and ignores the objects; the server no longer calls
  its push routes. What that window costs is spelled out in the shim entry.

## Changes by module

### `k8s/proxy` (the sidecar)

- **New `objects.ts`**, pure and unit-testable like `tools-report.ts`:
  decoders from object `data` to the proxy's in-memory views —
  `decodeCredentials` (the five file shapes, validated exactly as the
  `read*Creds` functions validate them today, plus the ssh entries),
  `decodeProjectSecrets`, `decodeRegistration` — and encoders for what the
  proxy writes: `encodeRefreshed`, `encodeCa`, `encodeState`.
- **New `object-watch.ts`**: three informers on the proxy's own client
  (`pod-watch.ts` has the construction) — the credentials Secret by name,
  the per-project secrets by label, the registrations by label — each
  updating the maps `proxy.ts` already keys by worktree id and secret ref.
  The credentials handler also reconciles the agent: `ssh-add -D`, then
  `ssh-add -h <host> -` per entry, the routine `PUT /agent/keys` runs today.
  Fail-closed is preserved: until the initial list lands, no worktree is
  registered and nothing is injected.
- **`proxy.ts`**: delete `CREDENTIALS_DIR`, the five `*_CREDS_FILE`
  constants, the five readers, `readGitCredentials`, the two
  `write*OAuthBundle` functions and the `/data` file paths; the dynamic-rule
  and `/tools` code reads the maps. The two token-response handlers write
  `yaac-proxy-refreshed`. `persistBlockedHosts` / `persistGitAuthFailures`
  become one debounced write of `yaac-proxy-state`. `loadOrGenerateCA`
  reads `yaac-proxy-ca` and writes it when `ca.pem` is absent, adding
  `ca-bundle.pem` from the system roots either way. Routes deleted:
  `/ca.pem`, `/ca-bundle.pem`, `PUT|DELETE /worktrees/:id`, `/worktrees`,
  `/worktrees/:id/allow-host`, `/secrets`, `/secrets/names`,
  `DELETE /secrets/:ref`, `/agent/keys` (all three). Kept: `/healthz`,
  `/cmd/pending`, `/cmd/results`, `/events` (now `mama` and `ping` only),
  and the legacy `/spawn` pair with its own shim entry. `emitProxyEvent`
  loses the two state types.
- **`state-files.ts`** is deleted. `scopeLegacySecretRefs` moves server-side
  into the seed (below), because the only bare refs left are in an old
  `worktrees.json`.
- **`Dockerfile`**: `COPY objects.ts object-watch.ts`; the `/data` mkdir
  goes. `.containerignore` already excludes `test`.

### `packages/server/src/drivers/k8s/cluster`

- **`proxy-manifests.ts`**: the Deployment's volumes become the `home`
  emptyDir and a `proxy-data` emptyDir; both hostPath volumes, their mounts
  and the two `@yaac/shared/project-paths` imports go. `buildProxyRoleManifest`
  gains the rules in the RBAC decision. `proxyRunAsSecurityContext` keeps
  `fsGroup: runAsGroup` (both volumes are emptyDirs) and gets a comment that
  no longer cites hostPath dirs. New builders, all internal to the folder:
  `buildProxyCredentialsSecretManifest(bundle)`,
  `buildProjectSecretsManifest(slug, values)`,
  `buildRegistrationConfigMapManifest(worktreeId, registration)`, and the
  three empty proxy-written objects.
- **`proxy-apply.ts`**: `ensureProxyResources` drops both `fs.mkdir` calls,
  applies the three empty proxy-written objects before the Deployment, and
  runs the seed (below) before the first apply that rolls to the new image.
  `ensureCaConfigMap` reads `yaac-proxy-ca` with one `get` after the rollout
  instead of two HTTP fetches; the ConfigMap it writes for worktree pods is
  unchanged. `syncProxyCredentials(bundle)` and `syncProjectSecrets(slug,
  values)` / `removeProjectSecrets(slug)` apply their objects.
- **New `legacy-proxy-seed.ts`** (the shim): reads
  `<dataDir>/run/proxy-data` off the data dir the server pod mounts — no
  pod, no hostPath — and writes `yaac-proxy-ca` from `ca.key` + `ca.pem`,
  one registration ConfigMap per `worktrees.json` entry (bare `secretRef`s
  scoped to their project on the way, the rewrite `scopeLegacySecretRefs`
  did in the proxy), and `yaac-proxy-state` from the two record files. Runs
  once, only when `yaac-proxy-ca` is empty and the old dir has a `ca.pem`.
  Never deletes the directory.
- **`index.ts`** (barrel): exports the sync verbs; the manifest builders stay
  internal and are asserted through `ensureProxyResources` and the syncs.

### `packages/server/src/drivers/k8s/egress`

- **`proxy-client.ts`**: `ProxyClient` keeps `ensureRunning`,
  `attachIfRunning`, `isDeployedProxyCurrent`, `getCaTrustEnv`, `openEvents`,
  the two `/cmd` calls and the legacy spawn fallback, `stop`, `disconnect`.
  Everything else — `registerWorktree`, `removeWorktree`, `allowHost`,
  `listWorktrees`, `getCaCert`, `getCaBundle`, the secret trio, the ssh-key
  trio, `syncSshKeysFromCredentials`, `reconcileSshKeys`,
  `reconcileProxySecrets` — is deleted. `ensureRunningImpl` no longer
  detaches any sync: the objects are already there.
- **Deleted modules**: `credential-providers.ts`, `proxy-reconcile.ts`,
  `proxy-secrets.ts`, `blocked-hosts.ts`, `git-auth-failures.ts`,
  `secret-refs.ts` (`proxySecretRef` moves beside the rule builder;
  `sweepLegacyProxySecretsFile` moves into the seed module, retargeted per
  the shim entry).
- **`proxy-registration.ts`**: `registerWorkspace` applies the registration
  ConfigMap; `deregisterWorkspace` (from `worktrees/teardown.ts`) deletes it;
  `allowWorktreeHost` in `allow-host.ts` patches `allowedHosts` in it (and
  the fan-out patches each sibling's), which the proxy's informer applies —
  the proxy prunes its blocked record on that delta as it does on the POST
  today.
- **New `proxy-state.ts`**: `readBlockedHosts`, `readGitAuthFailures`,
  `readAllGitAuthFailures` answering from the `ClusterCache`'s state cache;
  `refreshedCredentials()` answering from its refreshed cache. Both
  synchronous reads of a watch-fed map.
- **`proxy-events.ts`**: `dispatch` keeps `mama` (and `spawn`); the two
  state cases go.
- **`steps.ts`**: the `proxy-ssh-keys` step is deleted. The k8s driver
  contributes no credential step at all.

### `packages/server/src/drivers/k8s/substrate` (`cluster-cache.ts`)

Two more caches beside pods and jobs, built by the same `buildCache`:
`proxy-state` (the one ConfigMap, by field selector) and `proxy-refreshed`
(the one Secret). Their deltas are new `DeltaSource`s; `lifecycle.ts` maps
the first to `notifyWorktreeListChanged()` and the second to a
`proxy-refreshed` reconcile trigger. The proxy's own pod cache and the
registration objects need no server-side cache: the server writes
registrations and never reads them back.

### `packages/server/src/drivers/contract.ts` and both assemblies

- `WorktreeDriver.syncSshIdentities` becomes `syncCredentials(bundle:
  ToolCredentialBundle)`: handed the whole bundle by the caller — the
  reader-dep discipline that `configureProxyCredentials` existed for is
  gone, because nothing re-reads on the driver's schedule any more.
  `syncProxySecrets(projectSlug)` becomes `syncProjectSecrets(projectSlug,
  values)` and `removeProjectSecrets(projectSlug)` (called from
  `destroyProjectSubstrate`). New `refreshedCredentials():
  RefreshedToolCredentials`. `DriverDeps` loses `sshIdentities`,
  `proxySecrets` and keeps `legacySecretImportPending` for the sweep.
  Containerless: `syncCredentials` and `syncProjectSecrets` stay resolved
  no-ops, `refreshedCredentials` answers `{}`.
- `k8s/lifecycle.ts` drops `configureProxyCredentials`; `attachNow` wires
  the two new delta sources.

### `packages/server/src/main`, `#domain/auth`, `#domain/projects`

- **`#domain/auth/runtime-push.ts`** (new): `pushCredentialsToRuntime()`
  loads the bundle (the four tool files via a new
  `loadToolCredentialBundle()` in `@yaac/shared/tool-auth`, `github.json`
  via `loadCredentials()`, the ssh entries via `listSshEntries()`) and calls
  `worktreeDriver().syncCredentials(bundle)`, swallowing failure the way
  `syncSshKeysQuietly` does. Every host-store writer calls it: `PUT
  /auth/:tool` after the fan-out, `POST /auth/clear`, `POST /auth/fake`,
  `POST /git/credentials` (which syncs nothing today because the proxy read
  the token off disk), `POST /git/ssh-keys` and `DELETE
  /git/credentials/:pattern` (which sync ssh today and pick the wider push
  up by the rename), and `plan-usage.ts` after either
  `refreshAndPersist*Bundle` saves. `adoptRefreshedToolCredentials(r)` is
  the compare-and-set `harvestClaude` / `harvestCodex` perform, followed by a
  push so the proxy sees its own capture echoed.
- **`domain/reconcile.ts`**: a `credential-adopt` step, `triggers:
  ['proxy-refreshed']`, reading `worktreeDriver().refreshedCredentials()`
  and adopting. Edge-driven; on the resync it reads a cache.
- **`domain/projects/env.ts`** (or wherever project env writes land): after
  a secret's value or rule changes, `syncProjectSecrets(slug, openedValues)`
  replaces the old `syncProjectProxySecrets`; `worktrees/create.ts` no
  longer pushes values before launch, since the object is already current.
- **`server-run.ts`**: the attach hook calls `pushCredentialsToRuntime()`
  and, per project, `syncProjectSecrets` once, so a server start converges
  the objects (cheap: a few applies). `convergence.ts` loses the two
  reader deps.

### `packages/shared/src`

- **`project-paths.ts`**: `credentialsDir()` → `serverLocalPath('.credentials')`
  with its comment rewritten; the five `*CredentialsPath` tags become
  SERVER-LOCAL; `proxyDataHostDir()` deleted; `secretKeyPath()`'s comment
  loses the "bind-mounted into the proxy pod" reason.
- **`types.ts`**: `ToolCredentialBundle` and `RefreshedToolCredentials`; the
  `GitCredentialsFile` comment stops saying the file is bind-mounted into
  the proxy pod (its ssh half stays). The same sentence goes from
  `loadCredentials` in `#domain/projects`' `credentials.ts` and from
  `gitSshKeys` in `db/schema.ts`.
- **`tool-auth.ts`**: `loadToolCredentialBundle()`.

### Documentation

- `docs/worktree-egress.md`: a section "What the proxy is told, and how"
  — the object table above, the one-writer rule, and that the control API
  carries only the `yaac-mama` queue.
- `docs/cluster-setup.md`: item 2 of "What it wires up" drops
  "credentials".
- `docs/server-in-cluster.md`: "Storage is still hostPath" notes that the
  proxy mounts nothing; "The credential sweep is inert in here" gains the
  sentence that `credential-adopt` is how a worktree-driven refresh reaches
  the host store under this driver.
- `docs/ssh-keys.md`: the "A k8s worktree" bullet changes one clause — the
  key reaches the proxy in `yaac-proxy-credentials` rather than over the
  control API, and a replaced pod reloads it from the object rather than
  being refilled by the driver.
- `docs/legacy-compat-shims.md`: the entries below, and the paragraph in
  the `importLegacyProjectConfig` entry about `scopeLegacySecretRefs` living
  in the proxy is rewritten to say the rewrite happens in the seed.
- `docs/plans/cloud-k8s.md`: the "Credentials leave the shared tier"
  decision and step 5 are deleted when this ships; the "Where things stand"
  bullet about the proxy's mounts goes with them; the "Images stop baking a
  uid" decision is rewritten to the present tense (issue #150 has landed,
  docs/arbitrary-uid-images.md).

## Manifests, environment and flags

- **Manifests**: the proxy Deployment's volumes (two emptyDirs, no
  hostPath); the proxy Role (secrets and configmaps read; three named
  objects writable); the six object kinds above. No PVC.
- **Environment**: none added. The proxy's `KUBERNETES_SERVICE_HOST` check
  already gates its in-cluster client; outside a cluster (the proxy's unit
  tests) the informers do not start and the maps stay empty.
- **CLI flags**: none. `yaac cluster install` and `yaac cluster check` are
  unchanged.

## Upgrade path and legacy-compat shims

On an existing kind install:

1. The server rolls (install or restart). It attaches, writes
   `yaac-proxy-credentials` and the per-project secrets, and starts its
   informers on two objects that do not exist yet (an absent object is an
   empty cache).
2. The old proxy keeps serving from its hostPath files. The server no
   longer calls `/secrets`, `/agent/keys`, `/worktrees` or `/allow-host`.
3. The next worktree create calls `ensureRunning`, which finds the
   Deployment stale, runs the seed (CA, registrations, records → objects),
   pre-creates the proxy-written objects, and applies the new Deployment.
   The new proxy boots with the old CA and every registration, and its
   informers deliver the credentials and secrets. Registration for the new
   worktree follows.

### `seedProxyObjects` (entry text)

**What it reads:** `<dataDir>/run/proxy-data` — `ca.key`, `ca.pem`,
`worktrees.json`, `blocked-hosts.json`, `git-auth-failures.json`, the files
the proxy's `/data` hostPath held — from the server pod's own mount of the
data dir, the first time `ensureProxyResources` finds `yaac-proxy-ca` empty
beside an old `ca.pem`. It writes the CA Secret, one registration ConfigMap
per entry (rewriting a bare `secretRef` to `<projectSlug>/NAME`, which
registrations written before refs were scoped still carry), and the state
ConfigMap. The directory is left in place.

**What breaks silently if it is deleted too early:** a proxy that rolls
onto an empty CA Secret mints a new CA, and every process that loaded the
old one at start (running agents, nested containers' baked bundles) fails
TLS against every MITM'd host until its pod restarts; and it comes up with
no registrations, failing every running worktree closed — nothing
re-registers a live worktree. No error names either cause.

**How to tell it is safe to remove:** every k8s install in use has rolled
its proxy once on a build carrying the objects. Directly checkable:
`kubectl -n yaac get secret yaac-proxy-ca -o jsonpath='{.data.ca\.pem}'` is
non-empty on every cluster in use. Then the module goes, and with it
`proxyDataHostDir()`'s last reader, and the old directory may be deleted on
each host.

### The pre-object proxy window (entry text)

**What it reads:** nothing. It is the absence of four calls: between a
server upgrade and the next worktree create, the running proxy is one that
reads credentials off its mount and takes registrations, secret values and
ssh keys over HTTP, and the new server makes none of those calls. Ordinary,
not exotic — the proxy rolls on the next launch, and the launch registers
only after the roll.

**What breaks silently if it goes too early:** nothing goes; this entry
records the window's cost so it is chosen knowingly. During it, an
`allow-host` click and a blocked-host record do not reach the server (the
badge stays until the roll); a `yaac auth update` reaches the old proxy
only through the files it still reads, which works; and if the old pod is
REPLACED inside the window (a crash, an eviction), its secret values and
ssh keys are gone with it and nothing re-pushes them, so those injections
stop until the first create rolls it. A worktree create is what closes the
window, so an install that creates nothing after upgrading stays in it.

**How to tell it is safe to remove:** it is prose, not code; it is removed
by deleting this entry once no install can still be running a pre-object
proxy, which drains at the first create after upgrade.

### `sweepLegacyProxySecretsFile`, retargeted

The sweep keeps its condition (no overlay still carries `envSecretProxy`)
and moves its proof: it runs at the end of `ensureProxyResources`, after the
new Deployment's rollout has completed — the old proxy, the last reader of
the file, is gone by then — rather than after a `/secrets/names` answer.
Its entry in the `importLegacyProjectConfig` section is updated to say so.

## Tests

### Unit (`unit:proxy`, `unit:server`, `unit:shared`)

- **`k8s/proxy/test/objects.test.ts`** (new; one `describe` per exported
  function): each decoder accepts the valid shapes and rejects what the file
  readers reject today (a codex bundle missing a field, an unknown
  opencode/pi provider, an empty api key, a bare git pattern complained
  about once, a registration without `tool` or `projectSlug`); each encoder
  round-trips through its decoder. `proxy-codex-oauth.test.ts` loses its
  `readCodexCreds` and `writeCodexOAuthBundle` describes;
  `proxy-state-files.test.ts` is deleted (`scopeLegacySecretRefs`'s cases
  move to the seed's test); `proxy-event-stream.test.ts`'s type list
  shrinks to `mama` and `ping`.
- **`k8s/proxy/test/object-watch.test.ts`** (new): with a fake informer, a
  credentials update replaces the maps and runs the agent reconcile
  (`ssh-add` spawned with `-D` then per key); a registration delete removes
  exactly that worktree; a per-project secrets delete forgets that project's
  refs; before the initial list nothing is registered.
- **`cluster/proxy-apply.test.ts`** (`ensureProxyResources` drives the real
  manifests): the Deployment's volumes are two emptyDirs and no hostPath; no
  host directory is created; the Role carries the read rules and exactly the
  three named write targets; the three empty objects are applied before the
  Deployment; the seed runs only when `yaac-proxy-ca` is empty AND
  `run/proxy-data/ca.pem` exists in the temp data dir, and scopes a bare ref
  in a seeded registration. `syncProxyCredentials` renders every key and
  never logs a value; `syncProjectSecrets` names the project safely and
  `removeProjectSecrets` deletes by name.
- **`egress/proxy-registration.test.ts`**: `registerWorkspace` applies a
  ConfigMap whose payload equals today's PUT body; `allowWorktreeHost`
  patches `allowedHosts` and fans out per sibling pod;
  `deregisterWorkspace` deletes. `proxy-client-secrets.test.ts`,
  `proxy-reconcile.test.ts`, `proxy-reconcile-sweep.test.ts`,
  `blocked-hosts.test.ts`, `git-auth-failures.test.ts`,
  `proxy-client-allow-host.test.ts` are deleted; `proxy-secrets.test.ts`
  keeps only `buildRulesFromSecrets` (moved with `proxySecretRef`).
  `proxy-events.test.ts` loses the state-event case.
- **`egress/proxy-state.test.ts`** (new): reads answer from a fake cache;
  malformed entries are dropped as the file readers dropped them.
- **`substrate/cluster-cache.test.ts`**: the two new caches map their
  objects and emit their delta sources.
- **`domain/auth/runtime-push.test.ts`** (new): the push composes the
  bundle from all three stores and swallows a driver failure; adoption takes
  a newer bundle, refuses an older one, a sentinel, and an api-key or
  signed-out store, and pushes after adopting. `plan-usage.test.ts` gains
  the assertion that a persisted refresh pushes. `domain/reconcile`'s step
  table test names `credential-adopt` with its trigger.
- **`test/api`** (`route-matrix.ts`): no new routes, no rows changed.
  `write-routes.test.ts` gains the assertion that `POST /auth/git/credentials`
  and `POST /auth/git/ssh-keys` call the driver's `syncCredentials` (today
  those describes assert only on rows and files).
- **`packages/shared/test/paths.test.ts`**: `credentialsDir()` hangs off
  `serverLocalRoot()`.

### e2e-containerless

No change. `syncCredentials`, `syncProjectSecrets` and
`refreshedCredentials` are the resolved no-ops `syncSshIdentities` was, and
the auth cases in `worktree-suite` and `remote-cli` exercise the writers
unchanged.

### k8s e2e (the egress tier)

The "egress e2e tier" for the gate is `test/e2e/transparent-egress`,
`netd-datapath`, `proxy-ssh-agent`, `ssh-agent-forward` (the files that
drive the proxy from the host), `test/e2e-cli/worktree-create-suite` and
`nested-containers` (the files that assert the credential swap through a
real server), and the `egress` gate of `yaac cluster check`.

- **The harness**: the four host-driven files register worktrees and push
  keys through `ProxyClient` today. They call the driver's own
  `registerWorkspace`, `syncProxyCredentials` and `syncProjectSecrets`
  instead (the modules are importable from tests, as `proxy-apply` already
  is), and `TEST_PROXY_CONFIG`'s forwarded origin serves only `/healthz` and
  the mama queue.
- **`test/e2e/proxy-credentials-suite.test.ts`** — `proxy-ssh-agent.test.ts`
  renamed and grown; one `ensureRunning`, one echo pod (its script also
  answers `/v1/oauth/token`) and one bare worktree pod shared by every case:
  - **objects then inject**: write the credentials Secret with a claude
    api-key and a github token, a registration redirecting
    `api.anthropic.com` to the echo; curl from the pod with the placeholder
    `x-api-key`; the echo saw the real key. Before the Secret carries
    `claude.json`, the placeholder is forwarded untouched.
  - **replace semantics**: rewriting the Secret without `claude.json` puts
    the placeholder back on the next curl.
  - **ssh keys from the object**: the three existing agent cases, driven by
    the Secret's `ssh-keys.json` and asserted with `ssh-add -l` in the pod
    (the `/agent/keys` list is gone).
  - **capture**: with an OAuth bundle in the Secret and `platform.claude.com`
    redirected to the echo, a refresh POST from the pod carrying the
    placeholder refresh token gets placeholders back, and
    `yaac-proxy-refreshed` holds the rotated bundle.
  - **state**: a curl to a host outside the allowlist lands in
    `yaac-proxy-state`; patching `allowedHosts` in the registration lets the
    next curl through and prunes the record.
  - **the pod is replaceable**: `kubectl delete pod -l app=yaac-proxy`, wait
    for `/healthz`; `yaac-proxy-ca` is unchanged and the pod serves the same
    CA, the registration still works, the credentials inject again with no
    server action — the case that proves the proxy is stateless.
- **`test/e2e-cli/worktree-create-suite.test.ts`**: the seeded credential
  files still land before the server spawns, and the attach push carries
  them, so the existing "routes session HTTPS through proxy→redirect→mock
  with credential injection" case proves the object replaces the mount. Add
  one case: `PUT /auth/claude` with a new api key through the running server,
  re-curl from the same pod, and the mock saw the new key with no restart —
  and the time between the two is what shows the informer beats the old
  per-request file read for freshness.
- **`test/e2e-cli/nested-containers.test.ts`**: no change.
- **Multi-node**: the suite also runs on a `--nodes 3` kind cluster per the
  plan's standing gate; with no volume behind the proxy there is nothing
  node-affine left to exercise, which is the point.

## Gate, as a procedure

1. `pnpm lint`.
2. `pnpm vitest run --project unit:proxy --project unit:server --project
   unit:shared` green.
3. `grep -n "hostPath\|persistentVolumeClaim"
   packages/server/src/drivers/k8s/cluster/proxy-manifests.ts` prints
   nothing.
4. On the test rig (`/home/ben/yaac-test`, `KUBECONFIG` exported), an
   existing install: `yaac server restart`, then a worktree create; the
   server log shows the seed line; `kubectl -n yaac get secret yaac-proxy-ca
   -o jsonpath='{.data.ca\.pem}' | base64 -d` equals the pre-upgrade
   `<dataDir>/run/proxy-data/ca.pem`; `kubectl -n yaac get deploy yaac-proxy
   -o yaml` shows two emptyDirs and no hostPath; `kubectl -n yaac get
   configmap -l yaac.proxy-registration` lists every running worktree.
5. `pnpm vitest run --project e2e test/e2e/proxy-credentials-suite
   test/e2e/transparent-egress test/e2e/netd-datapath
   test/e2e/ssh-agent-forward test/e2e-cli/worktree-create-suite
   test/e2e-cli/nested-containers` green, on one node and on `--nodes 3`,
   run in the background and read from the output file.
6. `yaac cluster delete && yaac cluster install` on the rig, then a worktree
   create: a fresh CA, nothing seeded, everything works.

## Open questions and risks

- **A projected Secret mount instead of an informer** would leave the
  proxy's file readers byte-for-byte intact — the kubelet would put the
  same five files at `/yaac-credentials`. Rejected: the kubelet refreshes a
  mounted Secret on its sync period (a minute, sometimes two), where today a
  `yaac auth update` is live on the next request; and the ssh keys still
  need an `ssh-add` on change, which means watching the mount. The informer
  is one mechanism, sub-second, for every object.
- **The mama queue stays on HTTP.** It could take the same route (one
  ConfigMap per request, the proxy answering the held-open worktree
  response from its informer), which would retire `/events` and `/cmd/*`
  and make the control API `/healthz` alone. Not this step; noted as the
  last piece of polling-shaped code around the proxy.
- **Secret list/watch is namespace-wide** for the proxy, because RBAC cannot
  name-scope those verbs. The install namespace holds only yaac's objects,
  and the proxy already holds every value in memory, but a future Secret
  placed in that namespace by anything else would be readable by the proxy.
  Worth a one-line note in `policy-manifests.ts`'s threat-model comment.
- **Ordering against step 1.** If step 1 lands first, its install-time
  rename of SERVER-LOCAL writers under `<dataDir>/server` must include
  `.credentials/`; if this step lands first, step 1 inherits the tier tag.
  Either order is green; the rename set is the one thing to check.
- **The pod-watch fallback.** `resolveWorktree` falls back to a live API
  read when a new pod's first packet beats its watch event. Registrations
  have the same race in the other direction — a Job created microseconds
  after its ConfigMap — and the same cure: `decodeRegistration` on a cache
  miss does one `get` by name before failing closed.
- **Blocked-host write bursts** are debounced in the proxy; a crash inside
  the 250ms loses the last record, which is a badge, not a credential.
- **Tor bootstrap per pod** for `USE_TOR` installs: a fresh circuit on every
  proxy replacement, a minute at worst, and the readiness probe already
  gates on `tor-ready`.

## Commit ordering

Each commit lints and passes the projects it touches; the e2e tier is run on
the second and third.

1. **Proxy: object decoders and informers, additive.** `objects.ts`,
   `object-watch.ts`, the three informers, the three object writes, with
   tests. The file readers and HTTP routes stay, and a map filled by an
   object wins over a file; the image hash changes, nothing server-side
   does, and the e2e tier is green against a server that writes no objects.
2. **Server: write and watch objects; stop calling the old routes.** The
   manifest builders and syncs in `cluster`, the two caches, the contract
   rename, `runtime-push.ts`, the `credential-adopt` step, the registration
   ConfigMap path, the attach-time push, the deleted egress modules and
   their tests, the new unit tests, `proxy-credentials-suite` with every
   case but "the pod is replaceable". The Deployment still mounts the
   hostPaths, so the old readers keep the tier green while both paths exist.
3. **Proxy stateless; `.credentials/` demotes.** The file readers, the
   `/data` files, `state-files.ts` and the HTTP routes go; both hostPath
   volumes go and `/data` becomes an emptyDir; the seed shim with its docs
   entry; `credentialsDir()` becomes SERVER-LOCAL and `proxyDataHostDir()`
   goes; the last e2e case; the comments that cite the mount. The grep gate
   passes here. Run procedure step 4 on the rig before merging.
4. **The window entry and the plan doc.** The docs/legacy-compat-shims.md
   entries for the window and the retargeted sweep, the
   docs/plans/cloud-k8s.md edits, the `docs/worktree-egress.md` section and
   the `docs/ssh-keys.md` clause.
