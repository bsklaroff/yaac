import type { DriverKind } from '@yaac/shared/types'
import type { WorkspaceMount } from '#drivers/contract'

/** In-pod codex home; the host-side codex dir is mounted here. */
export const CODEX_CONTAINER_HOME = '/home/yaac/.codex'

/**
 * A workspace's codex home: the project's shared codex dir, plus (in a pod) a
 * pod-local `tmp` over it.
 *
 * `tmp/arg0` holds a per-process dir with the `codex-linux-sandbox` helper.
 * Each codex start deletes every such dir whose flock it can take, and gVisor
 * keeps file locks per sandbox. With a shared `tmp`, a codex starting in
 * another pod would delete a running agent's helper, breaking its sandboxed
 * commands. Host processes share one kernel's locks, so containerless needs
 * no overlay.
 */
export function codexHomeMounts(driver: DriverKind, codexDir: string): WorkspaceMount[] {
  return [
    { source: { kind: 'hostPath', path: codexDir }, mountPath: CODEX_CONTAINER_HOME },
    ...(driver === 'containerless'
      ? []
      : [{ source: { kind: 'emptyDir' as const }, mountPath: `${CODEX_CONTAINER_HOME}/tmp` }]),
  ]
}
