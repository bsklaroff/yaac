- Always install dependencies with exact versions: `pnpm add -E <package>` (or `pnpm add -DE <package>` for dev deps).
- Every exported function must have a unit test in `test/unit/`.
- Every CLI command argument and option must have an e2e test in `test/e2e/`.
- **NEVER take credit for authoring code** — do not add "Co-Authored-By" lines, or any other AI attribution to commit messages, PR descriptions, or code comments
- Always use `pnpm lint` for linting (runs both `tsc --noEmit` and `eslint`).
- Limit all git commit message lines to 80 characters maximum.

## Test Image Management

All container images used by e2e tests are pre-built in `test/global-setup.ts` before any test worker starts. Image tags include a content hash of their source files (e.g., `yaac-test-base:<hash>`), so they are automatically rebuilt when source files change and stale images can never be used.

**Pre-built images:**
| Image | Source |
|-------|--------|
| `yaac-test-base:<hash>` | `dockerfiles/Dockerfile.default` |
| `yaac-test-base-nestable:<hash>` | `dockerfiles/Dockerfile.nestable` (layered on base) |
| `yaac-test-proxy:<hash>` | `podman/proxy-sidecar/` (all files in directory) |
| `yaac-test-ssh-agent:<hash>` | `podman/ssh-agent-sidecar/` (all files in directory) |

**Rules:**
- Never build images inside individual test workers — all builds belong in `test/global-setup.ts`.
- E2e tests must pass `requirePrebuilt: true` so they fail fast if an image is missing or stale rather than racing to build.
- When adding a new sidecar or container image, add it to the global setup with a content-hash tag and use `requirePrebuilt` in tests.
- For single-file images (Dockerfiles), use `fileHash()`. For multi-file build contexts, use `contextHash()` — both from `src/lib/image-builder.ts`.
