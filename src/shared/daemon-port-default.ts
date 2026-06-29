/**
 * Port the daemon binds on 127.0.0.1 when `yaac daemon run` is invoked
 * without `--port`. A fixed default — rather than an OS-assigned ephemeral
 * port — keeps the browser-app URL (http://127.0.0.1:<port>/) stable across
 * daemon restarts so it can be bookmarked, and lets the Vite dev server fall
 * back to the right target when no daemon lock exists yet (see
 * vite.config.ts). Override per-run with `yaac daemon run --port <N>`.
 *
 * This lives in its own dependency-free module (no `@/` imports) so that
 * `vite.config.ts` can import the constant without pulling the rest of
 * `daemon-port.ts` — and its transitive `@/shared/env` import — into Vite's
 * config-load bundle, which can't resolve the `@/` alias.
 */
export const DEFAULT_DAEMON_PORT = 8787
