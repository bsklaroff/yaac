- Always install dependencies with exact versions: `pnpm add -E <package>` (or `pnpm add -DE <package>` for dev deps). Add package-scoped deps in that package's directory (`pnpm --filter @yaac/<pkg> add -E …`). Deps shared by several manifests are pinned once in the `catalog:` section of pnpm-workspace.yaml and referenced as `"<pkg>": "catalog:"` — except in k8s/proxy, whose manifest is npm-installed inside the image build (npm can't resolve `catalog:`).
- Every exported function must have a unit test in its own package's `test/` dir (e.g. `packages/server/test/`, `apps/cli/test/`).
- Every CLI command argument and option must have an e2e test in `test/e2e-cli/` (or `test/e2e/`) at the repo root.
- **NEVER take credit for authoring code** — do not add "Co-Authored-By" lines, or any other AI attribution to commit messages, PR descriptions, or code comments
- Always use `pnpm lint` for linting (runs `tsc --noEmit`, the frontend `tsc`, and `eslint`).
- Limit all git commit message lines to 80 characters maximum.

## Repository Layout

The code is a pnpm workspace. Cross-package imports use the package name
(`@yaac/shared/types`); a package's own modules use Node subpath imports
(`#lib/k8s/exec`, `#components/Foo`) via each package.json's `imports` map —
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
| `apps/cli` (`@yaac/cli`) | the published `yaac` bin: entry + commands | server, auth-daemon, shared |
| `apps/desktop` (`@yaac/desktop`) | Electron shell: main-process launcher | shared only |
| `apps/frontend` (`@yaac/frontend`) | React SPA | shared only |
| `packages/server` (`@yaac/server`) | HTTP/WS daemon + all backend `lib/` | shared only |
| `packages/auth-daemon` (`@yaac/auth-daemon`) | auth helper daemon | shared only |
| `packages/shared` (`@yaac/shared`) | wire types + cross-cutting utils | nothing (type-only from others OK) |
| `packages/test-utils` (`@yaac/test-utils`) | shared test helpers + fixtures | server, shared |
| `k8s/proxy` (`yaac-proxy-sidecar`) | egress proxy sidecar | self only |

Boundaries are enforced by pnpm strict `node_modules` (an undeclared package
won't resolve) plus eslint import-restriction zones scoped to `src/**`
(so tests are unrestricted bar the no-parent-import rule). apps never import
apps; packages never import apps; server and auth-daemon never import each
other — anything they share lives in `@yaac/shared`. Under `src/`,
`process.env` may only be read in `packages/shared/src/env.ts` (enforced by
`no-process-env` on `src/**`); the rare sanctioned reads elsewhere carry an
inline disable with a justification, and `packages/test-utils` (test
infrastructure) is exempt.

The root `package.json` is the publishable `@bsklaroff/yaac`; `pnpm build`
bundles `apps/cli` (tsup) to `dist/cli.js` and copies the SPA (built by vite
to `apps/frontend/dist`) into `dist/frontend`. tsup leaves npm deps external,
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
is whatever the target server serves (see apps/desktop/README.md). It lives
in the tray (close hides; Quit never stops the server) and surfaces waiting
sessions via `/events`. `pnpm desktop:package` / `desktop:install` build the
unsigned macOS .app — the bundled server is staged from the root publish
artifact (`pnpm pack`, no hand-kept dependency list) plus a standalone Node.

## Runtime Architecture

- Sessions run as Kubernetes Jobs (one single-pod Job per session) on a local single-node cluster; podman is only the image build engine (`podman build`/`podman push` to the local registry on `localhost:5000`).
- All cluster access shells out to `kubectl` (no kubernetes client library) — matching the podman-CLI convention. Helpers live in `packages/server/src/lib/k8s/`.
- E2e tests require a wired-up cluster (`yaac cluster setup`, verified by `yaac cluster check`); unit tests must not touch podman or the cluster.

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
| `yaac-test-tools:<hash>` | `dockerfiles/Dockerfile.tools` (layered on base) |
| `yaac-test-nestable:<hash>` | `dockerfiles/Dockerfile.nestable` (layered on tools) |
| `yaac-test-proxy:<hash>` | `k8s/proxy/` (files not listed in its `.containerignore`) |

The global setup also mirrors digest-pinned upstream images into the local
registry (no content hash — the digest IS the pin): `registry:2` for
per-project registries (`packages/server/src/lib/k8s/project-registry.ts`) and the vcluster
image set (`k8s/vcluster/images.json`).

**Rules:**
- Never build images inside individual test workers — all builds belong in `test/global-setup.ts`.
- E2e tests must pass `requirePrebuilt: true` so they fail fast if an image is missing or stale rather than racing to build.
- When adding a new sidecar or container image, add it to the global setup with a content-hash tag and use `requirePrebuilt` in tests.
- For single-file images (Dockerfiles), use `fileHash()`. For multi-file build contexts, use `contextHash()` — both from `packages/server/src/lib/container/image-builder.ts`. `contextHash()` honors the context's `.containerignore` (literal paths only — it must match podman's exclusions exactly), so keep dev-only files like co-located tests listed there or they churn the image tag.
- E2e workers isolate cluster objects in per-run namespaces (`YAAC_K8S_NAMESPACE=yaac-test-<run-id>`).
- E2e test data dirs (and mock-remote repo stores) are hostPath-mounted into pods, so their path must be visible to the pod's node. They are created under `e2eTmpBase()` (`packages/test-utils/src/tmp.ts`): on a host that's `os.tmpdir()` — so on a kind host set `TMPDIR` to a path under your home directory (hostPath paths must match on host and node, and kind's node-internal tmpfs `/tmp` cannot be replaced by an extraMount). Inside a nested yaac session (`YAAC_NESTED=1`) it's the node-shared `$YAAC_DATA_DIR/e2e-tmp` — the pod's `/tmp` and `$HOME` are overlay filesystems the node can't see (hostPath mounts there hang Pending), and scratch there is removed with the session dir on cleanup.
- Tests that can't run inside a nested yaac session (in-cluster Cilium datapath assertions, vcluster-in-vcluster, podman `kind` network) are gated on `IS_NESTED_YAAC` (`packages/test-utils/src/setup.ts`) via `describe.skipIf` / `it.skipIf`. The session-create e2e family (own server+proxy+mocks) runs nested ungated — it assumes the outer server projects per-install inner redirects (docs/yaac-in-yaac-inner-egress.md); egress timeouts nested mean the host yaac predates that and needs upgrading.
