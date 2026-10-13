import type { WorkspaceDriver } from './contract'

/**
 * Holds the process's `WorkspaceDriver` (docs/layered-server.md). The
 * composition root registers it once; everything above calls
 * `workspaceDriver()` and never names a substrate.
 *
 * This module imports only types, so callers do not load cluster code or
 * `@kubernetes/client-node`, which keeps domain unit tests fast.
 */

let registered: WorkspaceDriver | null = null

/** Install the process's runtime, or clear it on shutdown. */
export function setWorkspaceDriver(runtime: WorkspaceDriver | null): void {
  registered = runtime
}

/**
 * The registered driver. Throws if none is registered: that is a wiring bug,
 * or a test that forgot to install a fake.
 */
export function workspaceDriver(): WorkspaceDriver {
  if (!registered) {
    throw new Error(
      'No WorkspaceDriver registered. The server registers one at startup; '
      + 'a test needs installFakeWorkspaceDriver() from @yaac/test-utils.',
    )
  }
  return registered
}

/**
 * Whether workspaces run sandboxed: in pods whose egress a proxy mediates
 * and whose mounts can sit over the project's shared tool homes. Every
 * substrate but containerless. A sandboxed workspace holds only placeholder
 * credentials, and anything it can write may hold a planted link.
 */
export function workspacesSandboxed(): boolean {
  return workspaceDriver().kind !== 'containerless'
}
