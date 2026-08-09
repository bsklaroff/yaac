- Always install dependencies with exact versions: `pnpm add -E <package>` (or `pnpm add -DE <package>` for dev deps). Add package-scoped deps in that package's directory (`pnpm --filter @yaac/<pkg> add -E …`). Deps shared by several manifests are pinned once in the `catalog:` section of pnpm-workspace.yaml and referenced as `"<pkg>": "catalog:"` — except in k8s/proxy, whose manifest is npm-installed inside the image build (npm can't resolve `catalog:`).
- Unit tests live in the owning package's `test/` dir (e.g. `packages/server/test/`, `packages/cli/test/`). In `packages/server`, `test/` mirrors the `src/` layout in domain subfolders (`test/features/<domain>/`, `test/platform/…`, `test/http/`, `test/main/`, `test/routes/`) — place a new test under the subfolder matching the module it covers; the vitest include glob recurses so no config change is needed.
- What *must* be tested is a folder's **public interface**, not every export. A sealed folder has an `index.ts` barrel listing the names used outside it, mapped to `#features/<name>` in the package's `imports`; the `SEALED_FOLDERS` eslint rule then stops `src` from importing past the barrel. Seal a folder by adding its `index.ts`, a map entry, and its name to the `SEALED_FOLDERS` alternation; inside a sealed folder, modules import each other by relative path (extensionless — `./image-builder`, no `.js`), which is why the rule never fires on them. `packages/server/src/features/images` is the worked example.
- In a sealed folder, **`test/<module>.test.ts` contains one `describe` per barrel function defined in `<module>.ts`, and nothing else.** No `describe` for an internal helper, and none for a barrel function that lives in a sibling module — `ensureImage` is tested only in `build-coordinator.test.ts`, because that is where it is defined. A module whose every export is internal gets no test file at all (build-engine has none; its routing is covered through `ensureImage`).
- Internals are covered *incidentally*, by choosing argument sets for the high-level tests that drive them — a chain containing an untrusted layer exercises the whole builder-pod path. Mock at the process boundary (kubectl, spawn, podman, the registry), never at a sibling module inside the folder, so the feature runs for real and assertions land on what it hands the outside world. Prefer a few rich tests over many narrow ones. Tests may import internals for setup values (bounds, policy constants) and state-reset hooks; that is not the same as testing them.
- Coverage is measured but not gated (`pnpm vitest run --coverage`, v8, no thresholds). Use it to answer "is this internal still exercised?" before deleting a test — a sealed folder's internals are meant to stay covered, whether directly or transitively. Do not delete an internal's tests on the theory that the barrel covers them; measure first.
- Every CLI command argument and option must have an e2e test in `test/e2e-cli/` (or `test/e2e/`) at the repo root.
- E2e fixtures are shared per FILE, not per test: one `beforeAll` server + mock set, and expensive subjects (sessions, vclusters, proxies) created once and reused by every case that only reads them. A `beforeEach` that spawns a server or creates a session is the costliest mistake in this suite — e2e files are serialized, so each one is pure wall-clock. Tests that must destroy their subject (session stop, teardown assertions) run LAST in the file; state-sensitive cases reset explicitly rather than taking a fresh fixture (`resetCreds` in `auth-cli`, `resetRemote` in `remote-cli`). Prefer a few rich files over many narrow ones, and name a file `*-suite` once it carries a whole subsystem (`worktree-create-suite`, `vcluster-suite`).
- **NEVER take credit for authoring code** — do not add "Co-Authored-By" lines, or any other AI attribution to commit messages, PR descriptions, or code comments
- Always use `pnpm lint` for linting (runs `tsc --noEmit`, the frontend `tsc`, and `eslint`).
- Running tests: pick the narrowest project (`pnpm vitest run --project unit:server [file]`, `--project api`, `--project e2e`), and never pipe a run through `tail`/`head` — the failure details print *before* the summary, so truncating leaves you knowing only that something failed. A full run takes minutes, so run it in the background and read its output file rather than blocking. Every run also writes `.vitest-last-run.json`; `pnpm test:failures` prints the failing test names, files, and assertions from it, so a lost or truncated console never costs a re-run.
- Don't let monitoring shells stack up. A backgrounded command already notifies you when it exits, so wait for that notification instead of spawning `sleep N; tail …` checks against its log. If you must poll, keep at most ONE `until <done>; do sleep …; done` waiter armed at a time and let it report. Repeated pollers pile up as live shells and end up competing for CPU with the job they are watching — which is exactly how a long build or lint run gets starved.
- A dev session's init commands build and start the server once (`pnpm build`, `yaac server start`); they do **not** run `pnpm watch`. The running server therefore keeps serving whatever `dist/` held when the session started. To test a source change by hand against the live server/cluster, first make `dist/` current — a one-shot `pnpm build`, or start the `pnpm watch` loop yourself (build + serve + rebuild-on-change) and leave it running for the session.
- A DB schema change (`packages/server/src/platform/db/schema.ts`) needs a Drizzle migration: generate it with a descriptive name via `pnpm --filter @yaac/server exec drizzle-kit generate --name <change>` (e.g. `add_deleted_sessions`), and commit the emitted `packages/server/drizzle/<timestamp>_<name>/` dir. Never keep drizzle's auto-generated random suffix (`<timestamp>_<adjective_noun>`, e.g. `melodic_polaris`) — if you already generated one, delete that dir and re-run with `--name`. Migrations apply automatically on server start (`getDb()` runs `migrate()`).
- Limit all git commit message lines to 80 characters maximum.

## Repository Layout

The code is a pnpm workspace. Cross-package imports use the package name
(`@yaac/shared/types`); a package's own modules use Node subpath imports
(`#platform/k8s/exec`, `#components/Foo`) via each package.json's `imports` map —
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
sessions via `/events`. `pnpm desktop:package` / `desktop:install` build the
unsigned macOS .app — the bundled server is staged from the root publish
artifact (`pnpm pack`, no hand-kept dependency list) plus a standalone Node.

## Runtime Architecture

- Sessions run as Kubernetes Jobs (one single-pod Job per session) on a local single-node cluster; podman is only the image build engine (`podman build`/`podman push` to the local registry on `localhost:5000`).
- A worktree's agents run in one of two **modes** (`docs/agent-modes.md`): `tui` (the tool's terminal UI, observed through tmux control mode, rendered by xterm.js) or `acp` (the tool's Agent Client Protocol adapter, driven over JSON-RPC, rendered as a chat pane). Both launch into a tmux window — tmux is the process supervisor that outlives the viewer either way; only the presentation transport differs. `agentDriver(mode)` in `#features/agents` is the seam, and `SessionStatusWatcher` owns the retry policy for both. An ACP agent is supervised in-pod by `acpd` (`dockerfiles/acpd/`, baked into the base image) so a dropped connection never kills a running turn.
- Cluster access uses the `@kubernetes/client-node` library wherever a library call applies (reads, informers/watches); `kubectl exec` is used only where a library call doesn't make sense — streaming into session pods (PTYs, port-forward relays, tmux control-mode status). Primitive helpers live in `packages/server/src/platform/k8s/`; cluster lifecycle (setup/check/delete/vcluster) lives behind the `#features/cluster` barrel. The local OCI registry is a host podman container with no Kubernetes object in it, so it sits in `packages/server/src/platform/container/registry.ts` beside the container runtime, and the datapath's names and ports are a zero-import vocabulary in `packages/server/src/platform/k8s/proxy-constants.ts`.
- Image handling is split across the cluster boundary. `#features/image-engine` is the host half — `podman build`, the content-hash tags that decide whether a build is needed, the in-memory build-row registry the webapp shows, and the host image GC — and needs no cluster, so `#features/cluster` can build netd's image during setup. `#features/images` is the half that needs one: sandboxed builder pods, the in-cluster registry promoter, the prewarm sweep, the build-cache GC. Keep that direction — a `#features/cluster` import inside image-engine puts the two features back in a cycle. `pnpm modularity` (docs/modularity-metrics.md) is what checks it.
- The server is being split in two (`docs/plans/herd-split.md`): the **server** (HTTP/WS, the database, every durable fact a client can ask about) and the **herd** (the cluster, the worktrees, the transcripts, the in-pod tmux, image builds, and the live connections into all of it). Both still run in one process, but they now talk only through two interfaces. `#herd` is every server→herd call, and `src/herd/in-process.ts` is the ONE module under `packages/server/src` allowed to import a herd feature. `#server-link` is the mirror — what a herd reports up (a discovery to persist, a change to push, a drained `yaac-spawn` to decide on) — and no herd module may import `#main`, `#routes`, `#http`, `#notify` or `#herd`. `SERVER_SRC`/`NO_HERD_FEATURES` and `HERD_SRC`/`NO_DATABASE`/`NO_SERVER` in `eslint.config.js` enforce both directions; a new call between the halves means a method on one of those interfaces, never a direct import.
- E2e tests require a wired-up cluster (`yaac cluster setup`, verified by `yaac cluster check`); unit tests must not touch podman or the cluster. Developing inside a yaac session already satisfies this — the session ships a ready vcluster and podman, so e2e is runnable there and an e2e-affecting change should be run rather than left unverified (`yaac cluster check`'s `skipped — nested yaac` lines are expected).

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
per-project registries (`packages/server/src/features/cluster/project-registry.ts`), the vcluster
image set (`k8s/vcluster/images.json`), and `quay.io/podman/stable` for the
sandboxed builder pods (`packages/server/src/features/images/builder-pod.ts`),
and `envoyproxy/envoy` for netd's redirect sidecar
(`packages/server/src/features/cluster/netd.ts`).

**Rules:**
- Never build images inside individual test workers — all builds belong in `test/global-setup.ts`.
- E2e tests must pass `requirePrebuilt: true` so they fail fast if an image is missing or stale rather than racing to build.
- When adding a new sidecar or container image, add it to the global setup with a content-hash tag and use `requirePrebuilt` in tests.
- For single-file images (Dockerfiles), use `fileHash()`. For multi-file build contexts, use `contextHash()` — both from `packages/server/src/features/image-engine/image-builder.ts`. `contextHash()` honors the context's `.containerignore` (literal paths only — it must match podman's exclusions exactly), so keep dev-only files like co-located tests listed there or they churn the image tag.
- E2e workers isolate cluster objects in per-run namespaces (`YAAC_K8S_NAMESPACE=yaac-test-<run-id>`).
- Test scratch (data dirs, mock-remote repo stores, CLI scratch) comes from `testTmpBase()` (`packages/test-utils/src/tmp.ts`), which answers to the audience rather than the platform. A hermetic `unit:*` run — declared by unit-setup calling `setHermeticScratch(true)` — creates no pod, so it gets `os.tmpdir()`: local, fast, OS-reaped, and off the timestamp-coarse filesystems a data dir may sit on. api/e2e hostPath-mount paths under their data dir into pods, so their base must resolve to the same absolute path on host and node; it is `<ambient data dir>/e2e-tmp`, node-visible by the same contract `yaac cluster check`'s end-to-end probe proves on every setup. No `TMPDIR` and no kind-specific setup: `os.tmpdir()` would be wrong there (on a kind host `/tmp` is the node's own tmpfs, and pods mounting a host `/tmp/...` path hang Pending), and inside a nested yaac session the pod's `/tmp` and `$HOME` are overlay filesystems the node can't see, where `$YAAC_DATA_DIR` is the node-shared mount (scratch there is removed with the session dir on cleanup).
- Tests that can't run inside a nested yaac session (host-side datapath assertions, vcluster-in-vcluster, podman `kind` network) are gated on `IS_NESTED_YAAC` (`packages/test-utils/src/setup.ts`) via `describe.skipIf` / `it.skipIf`. The session-create e2e family (own server+proxy+mocks) runs nested ungated — it assumes the host netd redirects the vcluster's synced pods (docs/nested-containers.md); egress timeouts nested mean the host yaac predates that and needs upgrading.

## Documentation (`docs/` vs `docs/plans/`)

- `docs/` holds **current-state reference** for shipped subsystems: describe how the code works *today*, in the present tense. `docs/plans/` holds **forward-looking proposals** for unimplemented or in-progress work. A doc's directory signals which it is — don't leave a shipped design under `docs/plans/`, and don't write a `docs/` reference for something that doesn't exist yet.
- Reference docs are maintained alongside the code they describe. When you ship or change a subsystem, update its `docs/` reference so it stays accurate; when a claim drifts from the code, fix the doc. Several source comments cite these docs by path as the canonical rationale (e.g. `docs/nested-containers.md`, `docs/trust-split-builds.md`), so when you rename or merge a doc, update every citation (grep the repo) so the pointers stay valid.
- Keep reference docs free of history: no "superseded" / "earlier scheme" / "was dropped" / "moved away from X" framing, no commit hashes, and few `file:line` citations (they drift — name the module or function instead). State the design and its rationale in the present tense, and *delete* obsolete alternatives rather than narrating that they were abandoned. Keep them short — favor the "why" over exhaustive per-file/per-test enumeration.
- When a plan ships (or is "close enough" that little is lost), don't keep it in `docs/plans/` as history: either delete it, or fold its still-useful current-state material into a `docs/` reference and delete the plan.
