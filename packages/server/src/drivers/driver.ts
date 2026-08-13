import type { WorktreeDriver } from './contract'

/**
 * The registered `WorktreeDriver`, and the only door to it from above the
 * runtime layer (docs/layered-server.md).
 *
 * Registered once by the composition root, which is the one place that
 * knows WHICH runtime this process runs. Everything above calls
 * `worktreeDriver()` and names no substrate.
 *
 * The indirection is what makes the layering pay: this module imports only
 * `./contract`, which is types, so a mediator that reaches the runtime
 * through here pulls no cluster code — and no `@kubernetes/client-node` —
 * into its module graph. A direct import of the k8s driver would typecheck
 * identically and cost every domain unit test the client's load time.
 */

let registered: WorktreeDriver | null = null

/** Install the process's runtime, or clear it on shutdown. */
export function setWorktreeDriver(runtime: WorktreeDriver | null): void {
  registered = runtime
}

/**
 * The registered runtime. Throws rather than returning null: every caller
 * is downstream of a server that registers one at startup, so an absent
 * runtime is a wiring bug, and a test that reaches the substrate without
 * installing a fake should say so loudly instead of taking a null branch.
 */
export function worktreeDriver(): WorktreeDriver {
  if (!registered) {
    throw new Error(
      'No WorktreeDriver registered. The server registers one at startup; '
      + 'a test needs installFakeWorktreeDriver() from @yaac/test-utils.',
    )
  }
  return registered
}

/** Whether one is installed — for shutdown paths that must not construct one. */
export function hasWorktreeDriver(): boolean {
  return registered !== null
}
