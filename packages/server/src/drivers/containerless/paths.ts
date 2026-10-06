import path from 'node:path'
import { createHash } from 'node:crypto'
import { PACKAGE_ROOT, installTmpDir } from '@yaac/shared/paths'
import {
  acpLogDir,
  workspaceAttachmentsDir,
  workspaceDir,
  workspaceStateDir,
} from '@yaac/shared/project-paths'
import type { WorkspacePaths } from '#drivers/contract'

/**
 * The paths this driver uses, all derivable from a job name. Unlike pods,
 * host processes share one filesystem, so every path (the tmux socket above
 * all) is per workspace.
 */

/**
 * A workspace's job name. The project and workspace can be read back from it
 * (the last 36 chars are the UUID), so `workspacePaths` and a detached
 * teardown work from the name alone.
 */
export function containerlessJobName(projectId: string, workspaceId: string): string {
  return `cl-${projectId}-${workspaceId}`
}

/** Decode `containerlessJobName`. Throws on anything else (a wiring bug). */
export function refFromJobName(jobName: string): { projectId: string; workspaceId: string } {
  const body = jobName.startsWith('cl-') ? jobName.slice(3) : ''
  // 36 for the UUID, 1 for the dash before it, and the project id.
  if (body.length < 38) throw new Error(`not a containerless workspace handle: ${jobName}`)
  return {
    projectId: body.slice(0, body.length - 37),
    workspaceId: body.slice(-36),
  }
}

/**
 * Max UNIX socket path length (`sun_path`: 104 bytes on macOS, 108 on
 * Linux). macOS's `TMPDIR` alone is about 48 bytes, so socket names use a
 * 12-hex-char hash of the workspace id instead of the full UUID.
 */
const SUN_PATH_MAX = 104

/** A workspace id, short enough to put in a socket path. See SUN_PATH_MAX. */
function shortId(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex').slice(0, 12)
}

/**
 * The dir holding every workspace's tmux socket: the install's temp dir
 * (short enough for SUN_PATH_MAX). Markers, which must survive a reboot,
 * live under the data dir instead.
 */
export function tmuxSockDir(): string {
  return installTmpDir()
}

/**
 * Characters that are unsafe in the unquoted paths the layers above embed in
 * shell commands. Pod paths are constants; these come from the temp and data
 * dirs, so they are checked.
 */
const SHELL_UNSAFE = /[^A-Za-z0-9_@%+=:,./-]/

/** Fail a launch whose paths contain `SHELL_UNSAFE` characters. */
export function assertShellSafePaths(paths: WorkspacePaths): void {
  const offender = ([
    ['tmux socket', paths.tmuxSock],
    ['workspace', paths.workspaceDir],
    ['scratch', paths.scratchDir],
    ['acp socket dir', paths.acpSockDir],
  ] as const).find(([, value]) => SHELL_UNSAFE.test(value))
  if (!offender) return
  const [what, value] = offender
  throw new Error(
    `containerless: the ${what} path contains a character that cannot be `
    + `carried into a workspace's shell commands (${value}). Use a data dir `
    + 'and a TMPDIR without spaces or shell metacharacters.',
  )
}

/** Fail a launch whose socket paths exceed SUN_PATH_MAX (otherwise tmux
 *  fails with an opaque bind error). */
export function assertSocketPathsFit(paths: WorkspacePaths): void {
  // The longest acpd socket name.
  const longest = path.join(paths.acpSockDir, 'opencode-2.sock')
  const over = [paths.tmuxSock, longest].filter((p) => Buffer.byteLength(p) > SUN_PATH_MAX)
  if (over.length === 0) return
  throw new Error(
    `containerless: socket path exceeds the ${String(SUN_PATH_MAX)}-byte limit `
    + `(${String(over[0])}). Set TMPDIR to a shorter directory.`,
  )
}

/** This driver's per-workspace state, under the workspace state dir so
 *  teardown removes it. */
export function containerlessStateDir(projectId: string, workspaceId: string): string {
  return path.join(workspaceStateDir(projectId, workspaceId), 'containerless')
}

/** The marker recording that this driver launched a workspace (the
 *  equivalent of a Job object), read on server start. */
export function markerPath(projectId: string, workspaceId: string): string {
  return path.join(containerlessStateDir(projectId, workspaceId), 'workspace.json')
}

/** The workspace's private `$HOME`; mounts under `/home/yaac` become
 *  symlinks in it. */
export function workspaceHome(projectId: string, workspaceId: string): string {
  return path.join(containerlessStateDir(projectId, workspaceId), 'home')
}

/** See `WorkspaceDriver.workspacePaths`. */
export function containerlessWorkspacePaths(jobName: string): WorkspacePaths {
  const { projectId, workspaceId } = refFromJobName(jobName)
  const state = containerlessStateDir(projectId, workspaceId)
  return {
    tmuxSock: path.join(tmuxSockDir(), `${shortId(workspaceId)}.sock`),
    workspaceDir: workspaceDir(projectId, workspaceId),
    scratchDir: path.join(state, 'scratch'),
    // Socket paths go in the temp dir, for SUN_PATH_MAX.
    acpSockDir: path.join(tmuxSockDir(), shortId(workspaceId)),
    sshAgentSock: path.join(tmuxSockDir(), `${shortId(workspaceId)}-ssh.sock`),
    // The shared project location the layers above read, which also
    // survives stop.
    acpLogDir: acpLogDir(projectId, workspaceId),
    attachmentsDir: workspaceAttachmentsDir(projectId, workspaceId),
    acpdEntry: acpdEntry(),
  }
}

/**
 * acpd's entry module as shipped with yaac (the image bakes the same
 * `dockerfiles/acpd` source in at `/opt/yaac/acpd`). `PACKAGE_ROOT` is the
 * repo root in dev and `dist/` when built.
 */
export function acpdEntry(): string {
  return path.join(PACKAGE_ROOT, 'dockerfiles', 'acpd', 'main.js')
}
