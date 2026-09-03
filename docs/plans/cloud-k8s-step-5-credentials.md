# Cloud k8s, step 5: credentials off the shared tier

Step 5 of docs/plans/cloud-k8s.md. This document plans that step alone.

Goal: the egress proxy pod mounts nothing from the host. The tool credential
bundles (`claude.json`, `codex.json`, `opencode.json`, `pi.json`) and the
https git tokens (`github.json`) reach it the way a project's proxied secrets
already do — pushed over its control API by the server, held in memory,
re-pushed on every attach — and the proxy's `/data` (the MITM CA, its tor
state, the persisted registrations and the blocked-host and git-auth-failure
records) becomes a PersistentVolumeClaim of its own, provisioned by
`yaac cluster install` the way the registry's is. `.credentials/` then has
exactly one reader and one writer, the server, and demotes to SERVER-LOCAL.

Gate, from the plan: the egress e2e tier green, and
`grep hostPath packages/server/src/drivers/k8s/cluster/proxy-manifests.ts`
prints nothing. Restated as a procedure at the end.

## What the proxy reads and writes today, and who else touches it

The one-line description in the plan hides four data flows, and every one
of them has to move. Naming them is most of the design.

1. **Credential injection, proxy ← files.** `k8s/proxy/proxy.ts` reads the
   five files under `/yaac-credentials` on every MITM'd request
   (`readClaudeCreds`, `readCodexCreds`, `readOpencodeCreds`, `readPiCreds`,
   `readGitCredentials`), builds the dynamic injection rules from them, and
   answers the legacy in-worktree `GET yaac.internal/tools` report from the
   same reads. The server side of that directory is
   `@yaac/shared/tool-auth` (the four tool files) and
   `#domain/projects`' `credentials.ts` (`github.json`).
2. **OAuth capture, proxy → files.** When a worktree's claude or codex
   refreshes its token through the proxy, the proxy swaps the placeholder
   refresh token for the real one on the way out and writes the rotated
   bundle back into `claude.json` / `codex.json` on the way in
   (`writeClaudeOAuthBundle`, `writeCodexOAuthBundle`). The server then reads
   the file as the current credential — `plan-usage.ts` spends it, the
   credential sweep in `#domain/auth` treats "the proxy writes the host store
   itself" as the reason it is inert under k8s. Losing this flow signs the
   install out: a refresh token is single-use.
3. **Proxy state, server ← `/data` files.** `blocked-hosts.json` and
   `git-auth-failures.json` are written by the proxy and read by the server
   straight off the hostPath (`egress/blocked-hosts.ts`,
   `egress/git-auth-failures.ts`), on every snapshot rebuild (`observe.ts`
   reads `allGitAuthFailures()` once and `blockedHosts(id)` per running
   workspace). The proxy's `/events` stream carries no state; it says "look
   again" and the server re-reads the file.
4. **Proxy state, proxy ↔ `/data`.** The CA key and cert, `worktrees.json`
   (every registration, reloaded at boot so a replaced pod fails nothing
   closed), the two record files above, and tor's data dir. All of it is
   pod-private; only the two record files are read by anyone else.

Two things already travel the way everything is about to: project secret
values (`PUT /secrets`, restored by `reconcileProxySecrets` on every tick and
on the `proxy-reconnect` edge) and ssh private keys (`PUT /agent/keys`,
restored by `reconcileSshKeys` when the loss signature shows). The credential
reader for both is handed to the driver at composition time
(`DriverDeps.sshIdentities` / `proxySecrets` → `configureProxyCredentials`),
because the driver re-reads on its own schedule and must never import above
its contract. Step 5 adds two more readers of that shape and one writer.

## Decisions

- **One wholesale push, not per-tool merges.** The tool credentials are one
  install-wide set, unlike project secrets (one push per project, merged).
  `PUT /credentials` therefore REPLACES the proxy's whole set: the body
  carries every tool's current file content or `null`, and a tool missing
  from the body is a tool the server holds nothing for. That makes the
  reconcile a single idempotent PUT per tick with no names route, no
  per-tool DELETE and no loss signature to detect — the same cost profile as
  `reconcileProxySecrets`, which already PUTs every tick.
- **The proxy keeps capturing refreshed bundles, and the server collects
  them.** The proxy cannot dial the server (it is a pod; the server is
  behind an ingress wall that admits node addresses only), so the capture
  stays in the proxy's memory and the server pulls it: a `credentials` event
  on the existing `/events` stream, then `GET /credentials/refreshed`, then
  the newest-wins compare `#domain/auth` already uses for every other
  writer (`claudeBundleIsNewer` / `codexBundleIsNewer`) before
  `saveClaudeOAuthBundle` / `saveCodexOAuthBundle`. Idempotent by
  construction — the same access token never wins — so the pull needs no
  acknowledgement and is safe to repeat on every tick.
- **Proxy state moves to a server-side mirror fed by the control API.**
  `GET /state` returns both record maps at once; the server keeps an
  in-memory mirror that is refreshed on the `blocked-hosts` and
  `git-auth-failures` events and on every reattach, and `blockedHosts(id)` /
  `gitAuthFailures(slug)` answer from it synchronously. The events keep
  carrying no state (level-triggered, a reconnect re-reads everything), and
  a snapshot rebuild costs no proxy round trip at all — cheaper than today's
  N file reads.
- **The claim is dynamically provisioned, not a hostPath PV into the data
  dir.** The plan says "like the registry's": `yaac-proxy-data`, RWO, no
  `storageClassName`, bound through the cluster's default class, applied by
  `ensureProxyResources` before the Deployment and by install so it exists
  (and is seeded, below) before any server runs. On kind that means the CA
  lives on the node's local-path directory rather than under
  `<dataDir>/run/proxy-data`, and `yaac cluster delete` takes it with the
  cluster — which is fine, since a recreated cluster has no worktree pods
  holding the old CA. `Recreate` on the proxy Deployment is what makes RWO
  enough, exactly as for the registries.
- **An upgrade seeds the claim from the old directory, once.** A fresh empty
  claim on an existing install would regenerate the CA under every running
  worktree (their mounted ConfigMap updates, but processes that loaded the
  CA at start and nested containers' baked bundles do not) and, worse, come
  up with zero registrations, failing every running worktree closed with
  nothing that re-registers them. So the first ensure that creates the
  claim copies `<dataDir>/run/proxy-data` into it with a one-shot pod on the
  node-write-pod pattern. That pod mounts a hostPath — in a module that
  exists only for the upgrade, deleted with it, and not in
  `proxy-manifests.ts`, so the gate's grep stays honest about what it
  measures.
- **The old-proxy window is tolerated, not closed.** After a server upgrade
  the proxy Deployment still rolls only on the next worktree launch
  (`ensureRunning`'s staleness check), so a new server talks to an old proxy
  for a while. The old proxy still reads the files (they are still there —
  the tier demotion changes no path on kind), still writes refreshed bundles
  into them, and answers 404 to the three new routes. The server treats the
  404s as "not yet" (logged once, like `legacySpawnQueue`), and the only
  visible cost of the window is blocked-host badges and git-auth flags
  reading empty until the roll. Rolling the proxy at driver attach would
  close the window in seconds but costs every running worktree its egress
  on every `yaac server restart`; it is listed under open questions rather
  than taken here.
- **`.credentials/` demotes to SERVER-LOCAL and moves nowhere.** Every tier
  root resolves to the data dir today, so `serverLocalPath('.credentials')`
  is the same bytes at the same path; the demotion is a declaration, and
  step 1's rename of server-local writers under `<dataDir>/server` picks it
  up for free (or, if step 1 lands first, this step adds `.credentials/` to
  its rename set — see risks). `proxyDataHostDir()` is deleted outright:
  nothing off the pod reads the directory once the mirror exists.
- **The https git tokens stay a file.** The reason the schema gives for
  keeping them out of a sealed row ("the proxy pod reads that file off its
  mount and writes refreshed OAuth bundles back to it") stops being true
  here, and moving them into `git_ssh_keys`' sibling table becomes possible.
  It is not this step: the file is SERVER-LOCAL after this and travels to
  the proxy over the same push, so nothing is on the wire that was not
  already. Noted as a follow-on; the comments that cite the old reason are
  rewritten.
- **The proxy's uid does not change.** `hostUidSecurityContext` on the proxy
  pod was justified by the hostPath dirs it wrote as the server's identity.
  With no hostPath left, the `runAsUser` half is parity with the server pod
  and nothing more, and the `fsGroup` half stays load-bearing (the emptyDir
  HOME, and now the claim). Dropping the host uid belongs to issue #150,
  where every pod's uid is decided together.

## Changes by module

### `k8s/proxy` (the sidecar)

- **New `credential-store.ts`**, pure and unit-testable like `state-files.ts`:
  the in-memory set. `replace(payload)` validates each tool's entry with the
  exact shape rules the five `read*Creds` functions apply today (an
  opencode/pi entry whose provider is not in the generated host map is
  unusable; a codex OAuth bundle needs every field; an https token needs a
  host-prefixed pattern, complained about once per pattern as
  `complainAboutPattern` does) and stores the parsed views. Readers
  `claude()`, `codex()`, `opencode()`, `pi()`, `gitTokens()` return what the
  request path used to read from disk. `recordRefreshed('claude' | 'codex',
  bundle)` stores a proxy-captured rotation both as the live credential and
  in a `refreshed` slot; `refreshed()` returns the slots; a `replace` whose
  bundle carries the same access token as a slot clears that slot (the
  server has persisted it).
- **`proxy.ts`**: delete `CREDENTIALS_DIR` and the five `*_CREDS_FILE`
  constants, the five readers, `readClaudeOAuthBundle` /
  `readCodexOAuthBundle`, `writeClaudeOAuthBundle`, `writeCodexOAuthBundle`
  and `readGitCredentials`; every caller (`buildDynamicRules`,
  `hostNeedsDynamicMitm`, `resolveHttpsCredentialForRepo`,
  `resolveGithubApiTokenForWorktree`, the token-response handlers,
  `handleToolsRequest`) reads the store instead. The two capture handlers
  call `recordRefreshed` and then `emitProxyEvent('credentials')`. The
  module header loses its "host-mounted credentials" bullets.
- **Three routes in `handleApiRequest`**, all behind `checkAuth`:
  - `PUT /credentials` — body `{ claude, codex, opencode, pi, git }`, each
    the file's JSON or `null`; replaces the set; 400 on a body that is not
    an object. Values are never logged; the log line counts tools held.
  - `GET /credentials/refreshed` — `{ claude?: ClaudeOAuthBundle, codex?:
    CodexOAuthBundle }`, the captured rotations not yet echoed back by a
    push.
  - `GET /state` — `{ blockedHosts: Record<worktreeId, string[]>,
    gitAuthFailures: Record<projectSlug, GitAuthFailure[]> }`, rendered from
    the two in-memory maps (the same shapes the files hold).
- **`emitProxyEvent`** gains the `credentials` type. `/data` keeps every
  file it has; nothing about `state-files.ts`, `loadWorktrees` or the
  write-throughs changes — they just write to a claim now.
- **`Dockerfile`**: `COPY credential-store.ts`. The `mkdir -p /data && chown`
  line stays harmless (the mount replaces the directory) and can go.
  `.containerignore` already excludes `test`.
- **`tools-report.ts`** is unchanged; `handleToolsRequest` feeds it the
  store's views.

### `packages/server/src/drivers/k8s/egress`

- **`proxy-client.ts`** (`ProxyClient`): `putCredentials(bundle)`,
  `fetchRefreshedCredentials()`, `fetchProxyState()`. Each returns a typed
  "unsupported" result on a 404 rather than throwing — the old-proxy window
  above — and throws on any other non-OK status. `syncToolCredentials()`
  reads the composed source (`proxyToolCredentials()` below; `undefined`
  means unwired and changes nothing, exactly as `syncSshKeysFromCredentials`
  treats it) and PUTs. `adoptRefreshedCredentials()` GETs and hands the
  result to the composed writer. `ensureRunningImpl` detaches both beside
  the existing ssh and secret syncs.
- **`credential-providers.ts`**: `ProxyCredentialSources` gains
  `listToolCredentials: () => Promise<ToolCredentialBundle>` and
  `adoptRefreshedCredentials: (r: RefreshedToolCredentials) => Promise<void>`;
  accessors `proxyToolCredentials()` and `adoptRefreshed()` with the same
  unwired-returns-undefined discipline. The shared types live in
  `@yaac/shared/types` beside the file shapes they carry.
- **`proxy-state.ts`** replaces `blocked-hosts.ts` and
  `git-auth-failures.ts`: a module-level mirror `{ blockedHosts,
  gitAuthFailures }`, `refreshProxyState()` (attach-only; a 404 or an
  unreachable proxy leaves the mirror as it was, an empty answer clears it),
  `readBlockedHosts(id)`, `readGitAuthFailures(slug)`,
  `readAllGitAuthFailures()` answering from the mirror, and
  `resetProxyStateForTests()`. Barrel exports keep their names so
  `drivers/k8s/index.ts` and the contract do not change.
- **`proxy-events.ts`**: `blocked-hosts` and `git-auth-failures` events call
  `refreshProxyState()` then `notifyWorktreeListChanged()`; the reattach
  catch-up does the same before its notify. A `credentials` event raises a
  new `proxy-credentials` trigger through `onChange`. The header's "/data
  files remain the data plane" paragraph is rewritten: the proxy's memory is
  the data plane, `/state` is how it is read.
- **`proxy-reconcile.ts`**: `reconcileProxySshKeys` becomes
  `reconcileProxyCredentials`, healing four things in order — ssh keys,
  secret values, the tool credential set (unconditional PUT), and the
  refreshed-bundle adoption — each failure logged and the rest continuing.
- **`steps.ts`**: the `proxy-ssh-keys` step becomes `proxy-credentials`
  with triggers `['proxy-reconnect', 'proxy-credentials']`; every step also
  runs on the 60s resync, which is what makes the adoption pull safe to
  leave edge-driven.
- **`allow-host.ts`**: after a successful allow, `refreshProxyState()`
  before `notifyBlockedHostsChanged()`, so the badge clears on the click
  rather than on the event's round trip.
- **`secret-refs.ts`** is unchanged (it names a file under
  `credentialsDir()`, which is the same path).

### `packages/server/src/drivers/k8s/cluster`

- **`proxy-manifests.ts`**: `buildProxyDataPvcManifest()` — name
  `PROXY_DATA_PVC_NAME`, namespace `k8sNamespace()`, `app: yaac-proxy` label
  plus the data-dir-hash label, RWO, `PROXY_DATA_STORAGE_SIZE` (`1Gi`; the
  CA and a few JSON files), no `storageClassName`. The Deployment's volumes
  become `{ name: 'proxy-data', persistentVolumeClaim: { claimName } }` and
  the `home` emptyDir; the `credentials` volume and its mount are deleted.
  The two `@yaac/shared/project-paths` imports go with them. The
  `proxyRunAsSecurityContext` comment is rewritten per the uid decision.
- **`proxy-apply.ts`**: `ensureProxyDataClaim()` — `kubectlGetJson` the
  claim, apply the manifest, and when it did not exist before, run the seed
  (next bullet) before returning. `ensureProxyResources` calls it before the
  SA/RBAC/Deployment applies and drops both `fs.mkdir` calls. The rollout
  wait's error text names the PVC the way `ensureProjectRegistry`'s does
  (a Pending claim means no default StorageClass).
- **New `legacy-proxy-data-seed.ts`** (the shim):
  `legacyProxyDataHostDir()` (`sharedPath('run', 'proxy-data')`, the path
  `proxyDataHostDir()` returns today), `buildProxyDataSeedPodManifest(runId)`
  — one-shot pod, `restartPolicy: Never`, infra priority, the registry:2
  mirror image (already on every node; `sh` and `cp -a` are all it needs),
  hostPath `legacyProxyDataHostDir()` read-only at `/old` and the claim at
  `/new`, command `[ -d /old ] && cp -a /old/. /new/` — and
  `seedProxyDataClaim()`, which runs it to completion with
  `runPodToCompletion` only when `ca.pem` exists in the old directory as
  seen by the caller (the server pod mounts the data dir; the CLI is on the
  host) and logs what it copied. Never deletes the old directory (the bytes
  are on the user's disk; the entry below says when they can go).
- **`index.ts`** (barrel): export `ensureProxyDataClaim`; the seed stays
  internal, covered through it.

### `packages/server/src/drivers/k8s/substrate/proxy-constants.ts`

`PROXY_DATA_PVC_NAME = 'yaac-proxy-data'`, `PROXY_DATA_STORAGE_SIZE`.

### `packages/server/src/drivers/k8s/install`

- **`install.ts`**: a `installProxyClaim(deps)` step after `installRegistry`
  and before `deployServer`, calling `deps.ensureProxyClaim` (a new
  `ClusterInstallDeps` entry defaulting to `ensureProxyDataClaim`). It
  applies the namespace first (the same `ensureNamespace()` the server's
  ensure uses) so the claim has somewhere to live, and logs "seeded from
  `<dir>`" when the shim ran. Skipped under `--adopt-cni`? No — an adopted
  cluster needs the claim too, and it binds through its default class.
- **`check.ts`**: a `proxy-storage` gate — the claim exists and is `Bound`
  or `Pending` under `WaitForFirstConsumer` with no consumer yet; `Lost` or
  absent fails with the fix "run `yaac cluster install`; a claim that never
  binds means the cluster has no default StorageClass". `VOLUME_NODES_FIX`
  loses the word "credentials".
- **`delete.ts`** needs no change: the claim is inside the cluster and its
  confirmation text already says in-cluster state goes.

### `packages/shared/src`

- **`project-paths.ts`**: `credentialsDir()` → `serverLocalPath('.credentials')`
  with its comment rewritten ("SERVER-LOCAL: the server is the only reader
  and the only writer; the proxy is pushed what it needs"); the five
  `*CredentialsPath` tags become SERVER-LOCAL; `proxyDataHostDir()` deleted;
  `secretKeyPath()`'s comment loses its "that directory is bind-mounted into
  the proxy pod" reason (it stays where it is — a key beside its ciphertext
  is still the wrong place). `paths.ts`'s tier legend needs no change.
- **`types.ts`**: `ToolCredentialBundle` (`{ claude: ClaudeCredentialsFile |
  null; codex: CodexCredentialsFile | null; opencode: OpencodeCredentialsFile
  | null; pi: PiCredentialsFile | null; git: GitCredentialsFile }`) and
  `RefreshedToolCredentials` (`{ claude?: ClaudeOAuthBundle; codex?:
  CodexOAuthBundle }`). The `GitCredentialsFile` comment stops saying the
  file is bind-mounted.
- **`tool-auth.ts`**: `loadToolCredentialBundle()` composing the four
  loaders; the git half is composed in by the server (below), since
  `github.json` is read by `#domain/projects`.

### `packages/server/src/drivers/contract.ts`, `driver.ts`, both assemblies

- `DriverDeps` gains `toolCredentials?: () => Promise<ToolCredentialBundle>`
  and `adoptRefreshedCredentials?: (r: RefreshedToolCredentials) =>
  Promise<void>`, documented like `sshIdentities`.
- `WorktreeDriver.syncSshIdentities` is renamed `syncCredentials`: "bring
  the egress path's copy of every credential the server holds in line — a
  resolved no-op for a runtime that injects none". The k8s assembly runs
  `syncSshKeysFromCredentials` and `syncToolCredentials`; the containerless
  one stays `Promise.resolve()`.
- `k8s/lifecycle.ts` passes the two new deps into
  `configureProxyCredentials`; a caller that wires only the old three gets
  the old behaviour.

### `packages/server/src/main` and `#domain/auth`

- **`server-run.ts`** wires `toolCredentials` (the shared loader plus
  `loadCredentials()` for `github.json`) and `adoptRefreshedCredentials`
  (below) through `convergence.ts` beside `listProxySecrets`.
- **`#domain/auth`** gains two functions in a new `runtime-push.ts`:
  - `pushCredentialsToRuntime()` — `worktreeDriver().syncCredentials()`
    swallowing failure, the way `syncSshKeysQuietly` in the auth routes does
    today; that helper moves here and every host-store writer calls it:
    `PUT /auth/:tool` after the fan-out, `POST /auth/clear`, `POST /auth/fake`,
    the three git-credential routes, and `plan-usage.ts` after either
    `refreshAndPersist*Bundle` saves.
  - `adoptRefreshedToolCredentials(r)` — for each bundle present, the same
    compare-and-set `harvestClaude` / `harvestCodex` perform: load the
    stored file, refuse unless it is `kind: 'oauth'`, adopt only when
    `*BundleIsNewer(candidate, stored)`, log one line. Under a mediated
    runtime this is now the harvest, and `credential-sync.ts`'s header
    paragraph about the proxy "writing the host store itself" is rewritten
    to say the server adopts what the proxy captured.
- `docs/server-in-cluster.md` "The credential sweep is inert in here" stays
  true and gains one sentence: the adoption route is what carries a
  worktree-driven refresh into the host store under this driver.

### Documentation

- `docs/worktree-egress.md`: a short section "What the proxy is told, and
  by whom" — registrations and secrets (already there in spirit), the tool
  credential set and ssh keys pushed over the control API, refreshed bundles
  pulled back over it, the record maps read over it; nothing read from a
  mount.
- `docs/cluster-setup.md`: item 2 of "What it wires up" drops
  "credentials"; a new item names the proxy claim beside the registry's,
  with the same no-`storageClassName` note.
- `docs/server-in-cluster.md`: "Storage is still hostPath" gains the
  exception (the proxy's `/data` is a claim) and the sentence above.
- `docs/legacy-compat-shims.md`: the two entries under "Legacy-compat shims"
  below.
- `docs/plans/cloud-k8s.md`: the "Credentials leave the shared tier"
  decision and step 5 are deleted when this ships, per the docs convention;
  the "Where things stand" bullet about the proxy mounting `.credentials/`
  and `run/proxy-data` goes with them.

## Manifests, environment and flags

- **Manifests**: `PersistentVolumeClaim/yaac-proxy-data` (new); the proxy
  Deployment's volume set (`proxy-data` → PVC; `credentials` removed); the
  one-shot seed pod (shim only). Nothing else changes shape — the Service,
  RBAC, the ingress policies and the CA ConfigMap are as they are.
- **Environment**: none added. The proxy's control routes are the interface;
  no server env var, no proxy env var.
- **CLI flags**: none. `yaac cluster install` gains a step and `yaac cluster
  check` a gate; both are output, not input.

## Upgrade path and legacy-compat shims

Ordering an upgrade goes through, on an existing kind install:

1. `yaac cluster install` (new bundle) creates the claim and seeds it from
   `<dataDir>/run/proxy-data` while the old proxy still serves; then rolls
   the server. The old proxy keeps its hostPath mounts and keeps working.
2. The new server attaches, pushes credentials (404 → tolerated), reads
   `/state` (404 → mirror stays empty).
3. The next worktree launch finds the proxy stale, applies the new
   Deployment (claim already seeded), and the new proxy boots with the old
   CA, every registration and both record files. Its first reconcile tick
   PUTs credentials and refreshes the mirror.

An install that skips `yaac cluster install` and only restarts the server
takes the same path from step 2; the seed then runs from
`ensureProxyResources` at the launch in step 3, still before the new
Deployment is applied.

Both shims get an entry, written in the file's own form:

### `seedProxyDataClaim` (entry text)

**What it reads:** `<dataDir>/run/proxy-data` — the hostPath the proxy's
`/data` was, holding the MITM CA, `worktrees.json` and the two record files
— copied into the `yaac-proxy-data` claim by a one-shot pod the first time
the claim is created, and never again. The old directory is left in place.

**What breaks silently if it is deleted too early:** an install whose claim
is created empty gets a proxy with a fresh CA and no registrations. Every
running worktree fails closed until it is recreated — nothing re-registers
a live worktree — and every process holding the old CA (a running agent,
a nested container's baked bundle) gets TLS failures against every MITM'd
host until its pod restarts. No error names the cause.

**How to tell it is safe to remove:** every k8s install in use has a bound
`yaac-proxy-data` claim. Directly checkable: `kubectl -n yaac get pvc
yaac-proxy-data` answers on every cluster in use. When it does, the module
goes, and so may the old directory on each host.

### The pre-push proxy window (entry text)

**What it reads:** nothing on disk. `ProxyClient.putCredentials`,
`fetchRefreshedCredentials` and `fetchProxyState` each read a 404 from a
proxy predating the routes as "not yet" rather than as an error, and the
reconcile and mirror carry on. Ordinary, not exotic: the server upgrades
first, and the proxy rolls on the next worktree launch, so between the two
a new server is talking to an old proxy that still reads `.credentials/`
off its mount and writes refreshed bundles into it — both of which keep
working because the demotion moved no file.

**What breaks silently if it goes too early:** the reconcile step logs a
failure on every tick and the snapshot's blocked-host and git-auth data
read empty, until something creates a worktree. Injection itself is
unaffected either way.

**How to tell it is safe to remove:** no proxy pod predating the routes is
still running anywhere, which drains on its own at the first launch after
an upgrade. Remove together with the proxy-side `/spawn` path entry's
sibling, since it is the same window.

Two existing entries change wording, not substance: the
`importLegacyProjectConfig` entry describes `proxy-secrets.json` as sitting
"in the directory the proxy pod mounts", which stops being true once the
proxy rolls; its sweep condition is unchanged.

## Tests

### Unit (`unit:proxy`, `unit:server`, `unit:shared`)

- **`k8s/proxy/test/credential-store.test.ts`** (new; the module has a
  public surface, so one `describe` per function): `replace` accepts each
  tool's valid shapes and rejects the invalid ones the file readers reject
  today (missing codex fields, an unknown opencode provider, an empty api
  key, a bare git pattern — complained about once); `replace` with `null`
  clears a tool; a `replace` carrying a captured bundle's access token
  clears its refreshed slot; `recordRefreshed` makes the rotation the live
  credential and reports it from `refreshed()`. `proxy-codex-oauth.test.ts`
  loses its `readCodexCreds` / `writeCodexOAuthBundle` describes (the copies
  they mirror are gone); the decode/placeholder cases stay.
- **`k8s/proxy/test/proxy-event-stream.test.ts`**: the change-line case
  lists `credentials` among the types.
- **`packages/server/test/drivers/k8s/egress/proxy-client-credentials.test.ts`**
  (new, the `stubFetch` pattern of `proxy-client-allow-host.test.ts`):
  `putCredentials` PUTs the whole bundle with bearer auth and never logs a
  value; a 404 answers "unsupported" and a 500 throws; the two GETs likewise.
- **`proxy-reconcile.test.ts`**: `reconcileProxyCredentials` pushes the
  composed bundle wholesale, adopts what the proxy reports through the
  composed writer, changes nothing when unwired, and survives any one heal
  failing. `proxy-reconcile-sweep.test.ts` is renamed for the step.
- **`proxy-state.test.ts`** replaces `blocked-hosts.test.ts` and
  `git-auth-failures.test.ts`: the mirror is filled from `GET /state`, drops
  malformed entries as the file readers did, keeps its last answer on a 404
  or a dial failure, and answers per worktree / per project / all.
- **`proxy-events.test.ts`**: a state event refreshes the mirror before the
  snapshot push; a `credentials` event raises `proxy-credentials`; the
  reattach catch-up refreshes the mirror.
- **`cluster/proxy-apply.test.ts`** (`ensureProxyResources` drives the real
  manifests): the claim is applied before the Deployment; the Deployment's
  volumes are exactly the claim and the emptyDir, no hostPath, no
  `/yaac-credentials` mount; no host directory is created; the seed pod
  runs only when the claim was absent AND `ca.pem` exists under the old dir
  (the test creates it in its temp data dir), and mounts the old dir
  read-only. `proxy-manifests.test.ts` is unchanged (the builder-guard pair
  is the folder's only external manifest).
- **`install/install.test.ts`**: the claim step runs after the registry and
  before the server deploy, and is not skipped under `--adopt-cni`.
  **`install/check.test.ts`**: `proxy-storage` passes on Bound, passes on
  Pending-with-no-consumer, fails on absent and on Lost with the install
  pointer.
- **`domain/auth/runtime-push.test.ts`** (new): the push swallows a driver
  failure; adoption takes a newer bundle, refuses an older one, a sentinel,
  and an api-key or signed-out store — the same table
  `credential-sync.test.ts` uses for the harvest. `plan-usage.test.ts` gains
  the assertion that a persisted refresh pushes.
- **`test/api`** (`route-matrix.ts`): no new server routes, so no rows. The
  auth rows are unchanged in both columns; the k8s column's setup installs
  the real driver with no proxy, so `syncCredentials` is an
  `attachIfRunning` miss there.
- **`packages/shared/test/paths.test.ts`** / `tool-auth.test.ts`: the
  `credentialsDir()` path assertion is unchanged on kind; add the tier
  assertion that it hangs off `serverLocalRoot()`.

### e2e-containerless

No change. The containerless driver's `syncCredentials` is the same resolved
no-op `syncSshIdentities` was, and the auth cases in `worktree-suite` and
`remote-cli` exercise the writers unchanged. Stated here because a reader of
the route diff will look for it.

### k8s e2e (the egress tier)

The "egress e2e tier" for the gate is: `test/e2e/transparent-egress`,
`netd-datapath`, `proxy-ssh-agent`, `ssh-agent-forward` (the files that
drive `ProxyClient` from the host), plus `test/e2e-cli/worktree-create-suite`
and `nested-containers` (the files that assert the credential swap through a
real server), plus the `egress` gate of `yaac cluster check`.

- **`test/e2e/proxy-credentials-suite.test.ts`** — `proxy-ssh-agent.test.ts`
  renamed and grown, since it now carries the proxy's whole credential
  subsystem; one `ensureRunning`, one echo pod and one bare worktree pod
  (the `transparent-egress` helpers, lifted into `@yaac/test-utils`) shared
  by every case:
  - **push then inject**: `putCredentials` with a claude api-key and a
    github token, register the worktree with `api.anthropic.com` redirected
    to the echo, curl from the pod with the placeholder `x-api-key`, assert
    the echo saw the real key. The same request before any push is
    forwarded with the placeholder untouched (the proxy injects nothing it
    was not given).
  - **replace semantics**: a second `putCredentials` without `claude` makes
    the same curl carry the placeholder again.
  - **capture and collect**: the echo pod's script also answers
    `/v1/oauth/token` with a token response; push an OAuth claude bundle,
    redirect `platform.claude.com` to it, POST a refresh from the pod
    carrying the placeholder refresh token, assert the pod received
    placeholders back and `fetchRefreshedCredentials()` returns the rotated
    bundle; a push echoing that access token clears it.
  - **state over the API**: curl a host outside the allowlist, assert
    `fetchProxyState()` records it under the worktree; `allowHost` prunes it.
  - **the claim outlives the pod**: `kubectl delete pod -l app=yaac-proxy`,
    wait for `/healthz`, assert `/ca.pem` is byte-identical,
    `listWorktrees()` still names the registration, the blocked-host record
    survived, and the credential set is empty (memory-only) until the next
    push. This is the case that proves `/data` is on the claim.
  - the three existing ssh-agent cases, unchanged, run first.
- **`test/e2e-cli/worktree-create-suite.test.ts`**: the seeded credential
  files still land before the server spawns, and the server's first
  `ensureRunning` pushes them — so the existing "routes session HTTPS
  through proxy→redirect→mock with credential injection" case is the proof
  that the push replaces the mount. Add one case beside it: `PUT
  /auth/claude` with a new api key through the running server, re-curl from
  the same pod, and assert the mock saw the new key — no worktree restart,
  which is the "re-pushed on change" half of the step.
- **`test/e2e-cli/nested-containers.test.ts`**: no change; its seeding goes
  through the same startup push.
- **`test/e2e-cli/cluster-cli.test.ts`**: `yaac cluster check` output names
  the `proxy-storage` gate (the existing kubectl-missing and unreachable
  cases already assert on gate lists).
- **Multi-node**: the suite is also run on a `--nodes 3` kind cluster, per
  the plan's standing gate; the claim's node affinity under local-path is
  what the "outlives the pod" case exercises there.

## Gate, as a procedure

1. `pnpm lint`.
2. `pnpm vitest run --project unit:proxy --project unit:server --project
   unit:shared` green.
3. `grep -n hostPath packages/server/src/drivers/k8s/cluster/proxy-manifests.ts`
   prints nothing. (`legacy-proxy-data-seed.ts` is allowed to; the grep is
   deliberately narrow.)
4. On the test rig (`/home/ben/yaac-test`, `KUBECONFIG` exported), an
   existing install: `yaac cluster install`, then `yaac cluster check` shows
   `proxy-storage` passing and the install log's "seeded from" line; `kubectl
   -n yaac get pvc yaac-proxy-data` is Bound; `kubectl -n yaac get deploy
   yaac-proxy -o yaml` has no `hostPath`. Create a worktree, confirm the
   CA in `/etc/yaac/certs/proxy-ca.pem` inside it equals the pre-upgrade
   `<dataDir>/run/proxy-data/ca.pem`.
5. `pnpm vitest run --project e2e test/e2e/proxy-credentials-suite
   test/e2e/transparent-egress test/e2e/netd-datapath
   test/e2e/ssh-agent-forward test/e2e-cli/worktree-create-suite
   test/e2e-cli/nested-containers test/e2e-cli/cluster-cli` green, on one
   node and on `--nodes 3`, run in the background and read from the output
   file.
6. `yaac cluster delete && yaac cluster install` on the rig, then a worktree
   create: a fresh claim, a fresh CA, nothing seeded, everything works.

## Open questions and risks

- **Rolling the proxy at driver attach.** Closing the old-proxy window in
  seconds would let the 404 tolerance go and make an upgrade deterministic
  (after `yaac server restart`, the proxy is new). The cost is a Recreate
  rollout — every running worktree loses egress for a few seconds and the
  ssh-agent and secret heals run — on every server restart that follows an
  upgrade, at a moment the user did not choose. Today that cost lands on
  the first create instead. Recommendation: not in this step; revisit when
  the rollout can be made zero-downtime.
- **Seed-time race.** The seed copies `/data` while the old proxy still
  serves, so a blocked-host or registration write in the seconds between
  the copy and the roll is lost. A lost blocked-host record is a missing
  badge; a lost registration is a worktree failing closed. The window is
  the seed pod's runtime (under a second) plus the apply; acceptable, and
  it is the reason the seed runs immediately before the Deployment apply
  and not at install time alone.
- **`WaitForFirstConsumer` and the seed pod.** On kind's local-path class
  the seed pod is the claim's first consumer and binds it to its node; the
  proxy Deployment then follows the volume's affinity. Single-node this is
  invisible; on `--nodes 3` it pins the proxy to whichever node the seed
  landed on, which is no worse than where the Deployment would have bound
  it itself. On a byo cluster there is nothing to seed, so the question does
  not arise.
- **Ordering against step 1.** If step 1 (storage claims) lands first, its
  install-time rename of SERVER-LOCAL writers under `<dataDir>/server` must
  include `.credentials/`, and the server pod's `secretKeyPath()` and the
  credentials dir then share a claim, which is the intended end state. If
  this step lands first, nothing moves on disk and step 1 inherits the tier
  tag. Either order is green; the rename set is the one thing to check.
- **Secrets on the pod network.** The push carries every tool credential
  and git token over plain HTTP between the server pod and the proxy
  Service. That is the channel that already carries ssh private keys and
  project secret values, admitted by the proxy's ingress policy on the
  server's pod selector alone — so no new exposure class, but the step
  widens what that one policy protects, and the policy-manifests comment
  should say so.
- **The proxy's `/tools` report** now says "not configured" for a tool the
  server has not pushed yet, for the seconds between a proxy boot and the
  first reconcile tick. Cosmetic; the report is the legacy `yaac-spawn
  --models` surface.
- **`ensureProxyImage` is a lookup, not a build.** An install that upgrades
  its bundle without re-running `yaac cluster install` has no new proxy
  image in its registry; `ensureRunning` then throws at the next launch
  exactly as today. Unchanged by this step, but the old-proxy window is
  indefinite for such an install, so the 404 log line should name the
  command.

## Commit ordering

Each commit lints and passes the projects it touches; the e2e tier is run
on the second, fourth and fifth.

1. **Proxy: the credential store and the three routes, additive.** New
   `credential-store.ts` with tests; the routes, the `credentials` event and
   the `refreshed` capture wired in; the file readers still consulted when
   the store holds nothing for a tool (one commit's worth of dual-read, so
   the e2e tier stays green against a server that pushes nothing yet). Image
   hash changes; nothing on the server side changes.
2. **Server: push, adopt, mirror.** Contract deps and `syncCredentials`;
   `ProxyClient` methods; `proxy-state.ts` replacing the two file readers;
   the event and reconcile changes; `#domain/auth`'s push and adoption with
   every writer calling the push; `server-run.ts` wiring. Unit tests as
   listed; `proxy-credentials-suite` lands here with every case but "the
   claim outlives the pod". The e2e tier is green with the proxy still
   mounting the files, because the pushed set wins over them.
3. **Proxy: drop the file readers; `.credentials/` demotes.** The dual-read
   from commit 1 goes, `/yaac-credentials` and the `credentials` volume go
   from the manifest, `credentialsDir()` becomes SERVER-LOCAL,
   `ensureProxyResources` stops creating host dirs, comments and docs that
   cite the mount are rewritten. `hostPath` count in `proxy-manifests.ts`
   drops to one.
4. **The claim, the seed, install and check.** `buildProxyDataPvcManifest`,
   `ensureProxyDataClaim`, the seed shim with its docs entry, the install
   step, the `proxy-storage` gate, `proxyDataHostDir()` deleted, the
   "outlives the pod" e2e case. The grep gate passes here. Run on the rig
   against an existing install (procedure step 4) before merging.
5. **The old-proxy window entry and the plan doc.** The
   docs/legacy-compat-shims.md entry for the 404 tolerance, the
   docs/plans/cloud-k8s.md edits, and `docs/worktree-egress.md`'s new
   section — the prose that describes the finished shape, landed once it is
   true.
