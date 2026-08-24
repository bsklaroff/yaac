- Always install dependencies with exact versions: `pnpm add -E <package>` (or `pnpm add -DE <package>` for dev deps). Add package-scoped deps in that package's directory (`pnpm --filter @yaac/<pkg> add -E …`). Deps shared by several manifests are pinned once in the `catalog:` section of pnpm-workspace.yaml and referenced as `"<pkg>": "catalog:"` — except in k8s/proxy, whose manifest is npm-installed inside the image build (npm can't resolve `catalog:`).
- Unit tests live in the owning package's `test/` dir (e.g. `packages/server/test/`, `packages/cli/test/`). In `packages/server`, `test/` mirrors the `src/` layout (`test/domain/<name>/`, `test/db/`, `test/runtime/…`, `test/drivers/k8s/…`, `test/lib/`, `test/api/`, `test/main/`) — place a new test under the subfolder matching the module it covers; the vitest include glob recurses so no config change is needed.
- What *must* be tested is a folder's **public interface**, not every export. A sealed folder has an `index.ts` barrel listing the names used outside it, mapped to a layer specifier (`#domain/<name>`, `#runtime/…`, `#drivers/k8s/…`, `#db`) in the package's `imports`; the `SEALED_FOLDERS` eslint rule then stops `src` from importing past the barrel. Seal a folder by adding its `index.ts`, a map entry, and its name to the `SEALED_FOLDERS` alternation; inside a sealed folder, modules import each other by relative path (extensionless — `./image-builder`, no `.js`), which is why the rule never fires on them. `packages/server/src/drivers/k8s/images` is the worked example.
- In a sealed folder, **`test/<module>.test.ts` contains one `describe` per barrel function defined in `<module>.ts`, and nothing else.** No `describe` for an internal helper, and none for a barrel function that lives in a sibling module — `ensureImage` is tested only in `build-coordinator.test.ts`, because that is where it is defined. A module whose every export is internal gets no test file at all (build-engine has none; its routing is covered through `ensureImage`).
- Internals are covered *incidentally*, by choosing argument sets for the high-level tests that drive them — a chain containing an untrusted layer exercises the whole builder-pod path. Mock at the process boundary (kubectl, spawn, podman, the registry), never at a sibling module inside the folder, so the feature runs for real and assertions land on what it hands the outside world. Prefer a few rich tests over many narrow ones. Tests may import internals for setup values (bounds, policy constants) and state-reset hooks; that is not the same as testing them.
- Coverage is measured but not gated (`pnpm vitest run --coverage`, v8, no thresholds). Use it to answer "is this internal still exercised?" before deleting a test — a sealed folder's internals are meant to stay covered, whether directly or transitively. Do not delete an internal's tests on the theory that the barrel covers them; measure first.
- Every CLI command argument and option must have an e2e test in `test/e2e-cli/` (or `test/e2e/`) at the repo root.
- **Every API route has a row in `test/api/route-matrix.ts` stating what it answers under BOTH drivers.** One table, two columns (`k8s`, `containerless`), driven by `routes-k8s.test.ts` and `routes-containerless.test.ts` — one project each (`test:api-k8s`, `test:api-containerless`), so the containerless column runs where there is no cluster; `assertMatrixCoversEveryRoute` reads the routes Hono actually registered and fails on any the table does not name, so a new route cannot land without stating both answers. Where the two differ, the row says `why`. A route for a feature a substrate lacks refuses with `NOT_SUPPORTED` (501) rather than returning empty — the DRIVER verb still degrades (the snapshot composes every feed unconditionally and must keep rendering), but a client asking the route directly is asking for something this install does not have. The matrix checks status classes against an empty server; behavior lives in `write-routes.test.ts` and the e2e tiers.
- E2e fixtures are shared per FILE, not per test: one `beforeAll` server + mock set, and expensive subjects (worktrees, proxies, registries) created once and reused by every case that only reads them. A `beforeEach` that spawns a server or creates a worktree is the costliest mistake in this suite — e2e files are serialized, so each one is pure wall-clock. Tests that must destroy their subject (worktree stop, teardown assertions) run LAST in the file; state-sensitive cases reset explicitly rather than taking a fresh fixture (`resetCreds` in `auth-cli`, `resetRemote` in `remote-cli`). Prefer a few rich files over many narrow ones, and name a file `*-suite` once it carries a whole subsystem (`worktree-create-suite`, `worktree-suite`).
- **NEVER take credit for authoring code** — do not add "Co-Authored-By" lines, or any other AI attribution to commit messages, PR descriptions, or code comments
- Always use `pnpm lint` for linting (runs `tsc --noEmit`, the frontend `tsc`, and `eslint`).
- Running tests: pick the narrowest project (`pnpm vitest run --project unit:server [file]`, `--project api-containerless`, `--project e2e`), and never pipe a run through `tail`/`head` — the failure details print *before* the summary, so truncating leaves you knowing only that something failed. A full run takes minutes, so run it in the background and read its output file rather than blocking. Every run also writes `.vitest-last-run.json`; `pnpm test:failures` prints the failing test names, files, and assertions from it, so a lost or truncated console never costs a re-run.
- Don't let monitoring shells stack up. A backgrounded command already notifies you when it exits, so wait for that notification instead of spawning `sleep N; tail …` checks against its log. If you must poll, keep at most ONE `until <done>; do sleep …; done` waiter armed at a time and let it report. Repeated pollers pile up as live shells and end up competing for CPU with the job they are watching — which is exactly how a long build or lint run gets starved.
- A dev worktree's init commands build and start the server once (`pnpm build`, `yaac server start`); they do **not** run `pnpm watch`. The running server therefore keeps serving whatever `dist/` held when the worktree started. To test a source change by hand against the live server/cluster, first make `dist/` current — a one-shot `pnpm build`, or start the `pnpm watch` loop yourself (build + serve + rebuild-on-change) and leave it running for the worktree.
- A DB schema change (`packages/server/src/db/schema.ts`) needs a Drizzle migration: generate it with a descriptive name via `pnpm --filter @yaac/server exec drizzle-kit generate --name <change>` (e.g. `add_deleted_sessions`), and commit the emitted `packages/server/drizzle/<timestamp>_<name>/` dir. Never keep drizzle's auto-generated random suffix (`<timestamp>_<adjective_noun>`, e.g. `melodic_polaris`) — if you already generated one, delete that dir and re-run with `--name`. Migrations apply automatically on server start (`getDb()` runs `migrate()`).
- **Legacy-compat code you add gets an entry in `docs/legacy-compat-shims.md`, in the same change.** That means anything whose only reason to exist is that an older install can still be out there: a one-shot importer or backfill, a read-time normalizer, a dual-read window, a delete-only sweep for a retired object, or a tripwire warning about state nothing reads any more. Give it its own section, and say three things — what it reads, what breaks *silently* if it is deleted too early, and how to tell it is finally safe to remove. If it has to be removed in a particular order relative to something else, that ordering is the point of the entry. No test can catch one of these going stale: the suite always starts from freshly created state, where every one is already a no-op, so the list is the only record there is.
- Limit all git commit message lines to 80 characters maximum.

## Repository Layout

The code is a pnpm workspace. Cross-package imports use the package name
(`@yaac/shared/types`); a package's own modules use Node subpath imports
(`#drivers/k8s/substrate`, `#components/Foo`) via each package.json's `imports` map —
there are no `#*` tsconfig `paths` entries and no resolver plugins.
All `imports`/`exports` map targets are output-form `./src/*.js` (the
standard shape for TS packages) even though no `.js` files exist: every
resolver in the toolchain substitutes the `.ts`/`.tsx` source — tsc/eslint
(documented extension substitution), Vite, esbuild/tsup, and tsx. Two
constraints follow. Package source must never run under raw `node` (which
does not substitute) — all source execution goes through tsx, including
the proxy container. And plain-Node-semantics resolvers can't read the
maps: vitest `setupFiles` entries are explicit file paths for this reason.
Don't "fix" a target to `./src/*` (tsc can't probe extensionless targets)
or the frontend's to `./src/*.ts` (Vite reads only the first entry of an
array target, so `.tsx` would break).

| Package | Role | May import |
|---|---|---|
| `packages/cli` (`@yaac/cli`) | the published `yaac` bin: entry + commands | server, auth-daemon, shared |
| `packages/desktop` (`@yaac/desktop`) | Electron shell: main-process launcher | shared only |
| `packages/frontend` (`@yaac/frontend`) | React SPA | shared only |
| `packages/server` (`@yaac/server`) | HTTP/WS daemon + all backend logic | shared only |
| `packages/auth-daemon` (`@yaac/auth-daemon`) | auth helper daemon | shared only |
| `packages/shared` (`@yaac/shared`) | wire types + cross-cutting utils | nothing (type-only from others OK) |
| `packages/test-utils` (`@yaac/test-utils`) | shared test helpers + fixtures | server, shared |
| `k8s/proxy` (`yaac-proxy-sidecar`) | egress proxy sidecar | self only |

Boundaries are enforced by pnpm strict `node_modules` (an undeclared package
won't resolve) plus eslint import-restriction zones scoped to `src/**`
(so tests are unrestricted bar the no-parent-import rule). The app packages
(cli, desktop, frontend) never import each other; the library packages never
import an app package; server and auth-daemon never import each
other — anything they share lives in `@yaac/shared`. Under `src/`,
`process.env` may only be read in `packages/shared/src/env.ts` (enforced by
`no-process-env` on `src/**`); the rare sanctioned reads elsewhere carry an
inline disable with a justification, and `packages/test-utils` (test
infrastructure) is exempt.

The root `package.json` is the publishable `@bsklaroff/yaac`; `pnpm build`
bundles `packages/cli` (tsup) to `dist/cli.js` and copies the SPA (built by
vite to `packages/frontend/dist`) into `dist/frontend`. tsup leaves npm deps external,
so the published CLI resolves them from the root manifest — the build fails
if `dist/cli.js` imports one missing there (`scripts/check-cli-externals.ts`).
Publish with `pnpm publish` (it rewrites `catalog:` pins; npm would not).

All vitest projects — the co-located `unit:<pkg>` suites plus the root
`test/api`, `test/e2e`, and `test/e2e-cli` trees — are defined inline in the
root vitest.config.ts, so one file owns the timeouts and isolation setupFiles
for every project; per-package vitest.config.ts files would not inherit them.
`pnpm lint` is the single typecheck entry point (root tsconfig + the frontend
tsconfig); packages deliberately have no typecheck scripts.

The desktop app (`pnpm desktop:dev` / `desktop:build`) is not part of `pnpm
build` — the npm artifact never includes it. It is an Electron shell whose
main process loads the server origin into the window, so the SPA it displays
is whatever the target server serves (see packages/desktop/README.md). It lives
in the tray (close hides; Quit never stops the server) and surfaces waiting
worktrees via `/events`. `pnpm desktop:package` / `desktop:install` build the
unsigned macOS .app — the bundled server is staged from the root publish
artifact (`pnpm pack`, no hand-kept dependency list) plus a standalone Node.

## Runtime Architecture

- Which substrate a server runs is its PLACEMENT, resolved once by the composition root (`#main/driver-choice`): under `k8s` the server is a pod of the cluster it manages, under `containerless` a process on your machine — so there is no per-start choice and no `--driver` flag. The answer is recorded beside the lock as which KIND of install a data dir is, and the two never meet on one: a host `yaac server start` against a `k8s` data dir is refused, and `yaac cluster install` refuses a containerless one. Above the seam a caller may branch on `worktreeDriver().kind` only to decide WHETHER a feature applies; what a runtime lacking one answers is specified per verb on the contract (empty, `null`, a resolved no-op), so most callers need no branch. Command text is written against `WorkspacePaths` — the driver's answer for where a workspace's things are — never against a hard-coded container path.
- Under `containerless` (docs/containerless-driver.md) a worktree is a tmux server on the host in its own checkout: no image, no proxy, no sandbox. Credentials are therefore REAL in the workspace rather than proxy-swapped sentinels, and the permission mode defaults to `accept-edits` rather than `bypass` (`worktrees.permissionMode`, the popover's dropdown and `--permission-mode`) — for chat worktrees as much as terminal ones.
- Under `k8s`, worktrees run as Kubernetes Jobs (one single-pod Job per worktree) on a local single-node cluster; podman is only the image build engine (`podman build`/`podman push` to the local registry on `localhost:5000`). **The server itself is a pod there too** (docs/server-in-cluster.md): `yaac cluster install` builds its image from the bundle, applies the Deployment/Service/RBAC/ingress-policy set, publishes it at a fixed host loopback origin through a NodePort + kind `extraPortMapping`, and writes the `remote.json` every client resolves through. `yaac server start|stop|restart` scale and roll that Deployment instead of spawning a host process. There is no host-process k8s server: the shims that made one possible (the stream-relay and registry port-forwards, the proxy's exec tunnel) are deleted, and every in-cluster dial the server makes is a Service dial. The k8s e2e tiers deploy that same Deployment per test file (see that doc's "The e2e tiers run against this"). One consequence reaches every substrate: the server binds NO host port for a worktree's forwards — it declares which host port each is offered at, and a client holds the listener (`yaac forward`, or the desktop app resident in its tray) over an authenticated WS tunnel (docs/port-forward-tunnel.md).
- A worktree's agents run in one of two **modes** (`docs/agent-modes.md`): `tui` (the tool's terminal UI, observed through tmux control mode, rendered by xterm.js) or `acp` (the tool's Agent Client Protocol adapter, driven over JSON-RPC, rendered as a chat pane). Both launch into a tmux window — tmux is the process supervisor that outlives the viewer either way; only the presentation transport differs. `agentDriver(mode)` in `#runtime/agents` is the seam, and `WorktreeStatusWatcher` owns the retry policy for both. An ACP agent is supervised in-pod by `acpd` (`dockerfiles/acpd/`, baked into the base image) so a dropped connection never kills a running turn. Both modes honor every permission posture their tool supports: a `tui` agent gets one as a launch flag, while an `acp` conversation is told over `session/set_mode` and forwards the asks it still makes to the chat pane, holding the JSON-RPC request open until the user answers (`docs/permission-modes.md`).
- Cluster access uses the `@kubernetes/client-node` library wherever a library call applies (reads, informers/watches); `kubectl exec` is used only where a library call doesn't make sense — streaming into session pods (PTYs, port-forward relays, tmux control-mode status). Primitive helpers live in `packages/server/src/drivers/k8s/substrate/` (sealed behind `#drivers/k8s/substrate`, the k8s driver's own bottom); cluster lifecycle (install/check/delete) lives behind the `#drivers/k8s/cluster` barrel. The local OCI registry is a host podman container with no Kubernetes object in it, so it sits in `packages/server/src/drivers/k8s/container/registry.ts` beside the container runtime, and the datapath's names and ports are a zero-import vocabulary in `packages/server/src/drivers/k8s/substrate/proxy-constants.ts`.
- Image handling is split across the cluster boundary. `#drivers/k8s/image-engine` is the host half — `podman build`, the content-hash tags that decide whether a build is needed, the in-memory build-row registry the webapp shows, and the host image GC — and needs no cluster, so `#drivers/k8s/cluster` can build netd's image during install. `#drivers/k8s/images` is the half that needs one: sandboxed builder pods, the in-cluster registry promoter, the prewarm sweep, the build-cache GC. Keep that direction — a `#drivers/k8s/cluster` import inside image-engine puts the two features back in a cycle. `pnpm modularity` (docs/modularity-metrics.md) is what checks it.
- The server package is layered (`docs/layered-server.md`): `src/api` (routes, HTTP, the snapshot hub) and `src/main` (composition root, the reconcile loop) sit over `src/domain` (the mediators — worktree/project lifecycle, discovery sweeps, the stale reaper, spawn policy, the reconcile step list), which sits over two sibling layers: `src/db` (rows; it owns the database — the PGlite handle and the drizzle schema are internal modules of it, off its barrel) and `src/runtime` (the driver-neutral machinery: agent conduction, status observation and report assembly, terminals, the forwarder restore), over `src/drivers` (`contract.ts` + `driver.ts`, the seam that imports nothing but shared types, and one sealed folder per substrate — `src/drivers/k8s/*`, whose barrel is its assembly and whose ten folders are internal — one of them, `k8s/install`, is the substrate administration only the CLI runs and no `src/` module may import, and `src/drivers/containerless/*`, one flat sealed folder behind the same kind of assembly (docs/containerless-driver.md); plus `src/drivers/shared`, the sealed floor BOTH drivers may import and which may import neither — for what only substrates share, since a driver cannot see its siblings), all over the dependency-free `src/lib`. A driver imports the contract, `#lib` and `@yaac/shared` and nothing else — never `#runtime/*`: state a driver step needs from the machinery is handed down through `PassContext`. Domain owns disk as well as rows: what a project keeps there is `#domain/projects`, what a worktree keeps there is `#domain/worktrees`, and `#domain/git` is the one process boundary onto git. A driver never looks a config or credential up — it is handed one (a launch intent, a `PassContext` accessor, or a reader composed in at startup). `src/api` reaches the runtime on the same terms as domain and the machinery — `#drivers/driver` and `#drivers/contract`, never a concrete driver. What separates the layers is composition, not permission: anything that resolves, decides and then acts belongs in `#domain`, while a display value the runtime already holds is asked for directly, because a wrapper whose body is `return worktreeDriver().x(...)` hides the seam instead of mediating it. Import arrows only point down, enforced by per-layer eslint zones; `#notify` and `#log` are the two arrow-exempt outbound channels. Observed facts become rows through exactly one door — code that watches the substrate or reads a worktree's disk emits a `WorktreeEvent` and `applyWorktreeEvent` in `#db` alone decides which rows that lands in; the per-event mutators are off the db barrel.
- **A yaac dev worktree runs its inner server on the `containerless` driver** (`yaac server start` in this repo's `yaac-config.json` init commands — a host server is that driver) and has no cluster of its own. Runnable in-worktree: the `unit:*` projects, `test/e2e-containerless`, and the containerless half of `test/api`. The k8s tiers — `test/api`'s k8s column, `test/e2e`, `test/e2e-cli` — need a wired-up cluster (`yaac cluster install`, verified by `yaac cluster check`) and are **host-only**: run them on a host directly, or from a worktree of an OUTER yaac running containerless, which gives the worktree that host's podman, kind and cluster. Export an absolute `KUBECONFIG` before starting that outer server — a containerless worktree gets a private `$HOME`, so `~/.kube/config` does not resolve, though every non-`YAAC_*` env var it inherits does. An e2e-affecting change should be run rather than left unverified; say so plainly when a change could only be checked by unit tests.

## Playwright Test Scripts

- Temporary Playwright scripts written to verify browser behavior by hand (e.g. driving xterm.js with real mouse/keyboard events) go in `test-playwright-scripts/`, committed for future reference — not in scratch/tmp dirs where they are lost.
- They are standalone `node <script>.js` programs, not part of `pnpm test` or vitest; there is no cleanup expectation, but each script's header comment must say what it verifies and how to run it.
- Playwright is installed globally (resolve it from `npm root -g` with a `require('playwright')` fallback, as the existing scripts do); Chromium binaries live under `/opt/playwright-browsers`.

## Test Image Management

All container images used by e2e tests are pre-built in `test/global-setup.ts` before any test worker starts, then pushed to the local registry so the cluster can pull them. Image tags include a content hash of their source files (e.g., `yaac-test-base:<hash>`), so they are automatically rebuilt when source files change and stale images can never be used.

**Pre-built images:**
| Image | Source |
|-------|--------|
| `yaac-test-base:<hash>` | `dockerfiles/Dockerfile.default` |
| `yaac-test-tools:<hash>` | `dockerfiles/Dockerfile.tools` + `dockerfiles/opencode-models.json` (layered on base; hash via `toolsContentHash()`) |
| `yaac-test-nestable:<hash>` | `dockerfiles/Dockerfile.nestable` (layered on tools) |
| `yaac-test-proxy:<hash>` | `k8s/proxy/` (files not listed in its `.containerignore`) |
| `yaac-test-netd:<hash>` | `k8s/netd/` (files not listed in its `.containerignore`) |

The global setup also mirrors digest-pinned upstream images into the local
registry (no content hash — the digest IS the pin): `registry:2` for
per-project registries (`packages/server/src/drivers/k8s/cluster/project-registry.ts`),
`quay.io/podman/stable` for the
sandboxed builder pods (`packages/server/src/drivers/k8s/cluster/builder-image.ts`),
and `envoyproxy/envoy` for netd's redirect sidecar
(`packages/server/src/drivers/k8s/cluster/netd.ts`).

**Rules:**
- Never build images inside individual test workers — all builds belong in `test/global-setup.ts`.
- E2e tests must pass `requirePrebuilt: true` so they fail fast if an image is missing or stale rather than racing to build.
- When adding a new sidecar or container image, add it to the global setup with a content-hash tag and use `requirePrebuilt` in tests.
- For single-file images (Dockerfiles), use `fileHash()`. For multi-file build contexts, use `contextHash()` — both from `packages/server/src/drivers/k8s/image-engine/image-builder.ts`. `contextHash()` honors the context's `.containerignore` (literal paths only — it must match podman's exclusions exactly), so keep dev-only files like co-located tests listed there or they churn the image tag.
- E2e workers isolate cluster objects in per-run namespaces (`YAAC_K8S_NAMESPACE=yaac-test-<run-id>`).
- Test scratch (data dirs, mock-remote repo stores, CLI scratch) comes from `testTmpBase()` (`packages/test-utils/src/tmp.ts`), which answers to the audience rather than the platform. A hermetic `unit:*` run — declared by unit-setup calling `setHermeticScratch(true)` — creates no pod, so it gets `os.tmpdir()`: local, fast, OS-reaped, and off the timestamp-coarse filesystems a data dir may sit on. api/e2e hostPath-mount paths under their data dir into pods, so their base must resolve to the same absolute path on host and node; it is `<ambient data dir>/e2e-tmp`, node-visible by the same contract `yaac cluster check`'s end-to-end probe proves on every setup. No `TMPDIR` and no kind-specific setup: `os.tmpdir()` would be wrong there, since on a kind host `/tmp` is the node's own tmpfs and pods mounting a host `/tmp/...` path hang Pending.

## Documentation (`docs/` vs `docs/plans/`)

- `docs/` holds **current-state reference** for shipped subsystems: describe how the code works *today*, in the present tense. `docs/plans/` holds **forward-looking proposals** for unimplemented or in-progress work. A doc's directory signals which it is — don't leave a shipped design under `docs/plans/`, and don't write a `docs/` reference for something that doesn't exist yet.
- Reference docs are maintained alongside the code they describe. When you ship or change a subsystem, update its `docs/` reference so it stays accurate; when a claim drifts from the code, fix the doc. Several source comments cite these docs by path as the canonical rationale (e.g. `docs/nested-containers.md`, `docs/trust-split-builds.md`), so when you rename or merge a doc, update every citation (grep the repo) so the pointers stay valid.
- Keep reference docs free of history: no "superseded" / "earlier scheme" / "was dropped" / "moved away from X" framing, no commit hashes, and few `file:line` citations (they drift — name the module or function instead). State the design and its rationale in the present tense, and *delete* obsolete alternatives rather than narrating that they were abandoned. Keep them short — favor the "why" over exhaustive per-file/per-test enumeration.
- When a plan ships (or is "close enough" that little is lost), don't keep it in `docs/plans/` as history: either delete it, or fold its still-useful current-state material into a `docs/` reference and delete the plan.
