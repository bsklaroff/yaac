import type { DriverKind } from '@yaac/shared/types'
import type { WorkspaceMount } from '#drivers/contract'

/** In-pod codex home; the host-side codex dir is mounted here. */
export const CODEX_CONTAINER_HOME = '/home/yaac/.codex'

/**
 * A workspace's codex home: the project's codex dir, which every worktree of
 * the project shares, and — in a pod — a pod-local `tmp` over it.
 *
 * `tmp/arg0` holds a directory per codex process, carrying the
 * `codex-linux-sandbox` alias every sandboxed command is spawned through.
 * Each codex start deletes every such directory whose flock it can take, and
 * gVisor keeps file locks per sandbox, so over the shared home a codex
 * starting in any other pod of the project — a prewarmed spare, a sibling —
 * takes the lock and deletes a running agent's helper. That agent's
 * sandboxed commands then fail ENOENT until it restarts. A host process
 * shares one kernel's locks, so containerless needs nothing.
 */
export function codexHomeMounts(driver: DriverKind, codexDir: string): WorkspaceMount[] {
  return [
    // GLOBAL.
    { source: { kind: 'hostPath', path: codexDir }, mountPath: CODEX_CONTAINER_HOME },
    ...(driver === 'containerless'
      ? []
      : [{ source: { kind: 'emptyDir' as const }, mountPath: `${CODEX_CONTAINER_HOME}/tmp` }]),
  ]
}
