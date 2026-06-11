- Always install dependencies with exact versions: `pnpm add -E <package>` (or `pnpm add -DE <package>` for dev deps).
- Every exported function must have a unit test in `test/unit/`.
- Every CLI command argument and option must have an e2e test in `test/e2e/`.
- **NEVER take credit for authoring code** — do not add "Co-Authored-By" lines, or any other AI attribution to commit messages, PR descriptions, or code comments
- Always use `pnpm lint` for linting (runs both `tsc --noEmit` and `eslint`).
- Limit all git commit message lines to 80 characters maximum.

## Runtime Architecture

- Sessions run as Kubernetes Jobs (one single-pod Job per session) on a local single-node cluster; podman is only the image build engine (`podman build`/`podman push` to the local registry on `localhost:5000`).
- All cluster access shells out to `kubectl` (no kubernetes client library) — matching the podman-CLI convention. Helpers live in `src/lib/k8s/`.
- E2e tests require a wired-up cluster (`./scripts/setup-kind-cluster.sh`, verified by `yaac cluster check`); unit tests must not touch podman or the cluster.

## Test Image Management

All container images used by e2e tests are pre-built in `test/global-setup.ts` before any test worker starts, then pushed to the local registry so the cluster can pull them. Image tags include a content hash of their source files (e.g., `yaac-test-base:<hash>`), so they are automatically rebuilt when source files change and stale images can never be used.

**Pre-built images:**
| Image | Source |
|-------|--------|
| `yaac-test-base:<hash>` | `dockerfiles/Dockerfile.default` |
| `yaac-test-tools:<hash>` | `dockerfiles/Dockerfile.tools` (layered on base) |
| `yaac-test-proxy:<hash>` | `k8s/proxy/` (all files in directory) |

**Rules:**
- Never build images inside individual test workers — all builds belong in `test/global-setup.ts`.
- E2e tests must pass `requirePrebuilt: true` so they fail fast if an image is missing or stale rather than racing to build.
- When adding a new sidecar or container image, add it to the global setup with a content-hash tag and use `requirePrebuilt` in tests.
- For single-file images (Dockerfiles), use `fileHash()`. For multi-file build contexts, use `contextHash()` — both from `src/lib/image-builder.ts`.
- E2e workers isolate cluster objects in per-run namespaces (`YAAC_K8S_NAMESPACE=yaac-test-<run-id>`).
- E2e test data dirs live under `os.tmpdir()` and are hostPath-mounted into pods, so the kind node must see the host temp dir. Set `TMPDIR` to a path under your home directory when running e2e — hostPath paths must match on host and node, and kind's node-internal tmpfs `/tmp` cannot be replaced by an extraMount.
