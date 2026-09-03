import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PACKAGE_ROOT, serverLocalPath } from '@yaac/shared/paths'
import { acpLogDir, repoDir, worktreeDir, worktreeStateDir } from '@yaac/shared/project-paths'
import type { WorkspacePaths } from '#drivers/contract'

/**
 * Every path this driver derives, and the naming that lets it derive them
 * from a handle alone.
 *
 * The pod driver can answer one fixed set of paths for every workspace
 * because each pod has its own mount namespace. Host processes share one
 * filesystem, so every path here is per-worktree — most of all the tmux
 * socket, which is the difference between "each worktree has a tmux server"
 * and "every worktree fights over one".
 */

/**
 * The runtime's own name for a workspace, and the whole of what the layers
 * above hold onto.
 *
 * Shaped so identity can be read back out of it: the trailing 36 characters
 * are the worktree id (a UUID), so the slug — which may itself contain
 * dashes — is whatever sits between the prefix and that tail. The k8s
 * driver names its Jobs on the same principle, and for the same reason:
 * `workspacePaths` and a detached teardown both have to work from the name
 * alone, with no registry left to consult.
 */
export function containerlessJobName(projectSlug: string, worktreeId: string): string {
  return `cl-${projectSlug}-${worktreeId}`
}

/** The identity `containerlessJobName` encoded. Throws on anything else —
 *  a handle this driver did not mint is a wiring bug, not a lookup miss. */
export function refFromJobName(jobName: string): { projectSlug: string; worktreeId: string } {
  const body = jobName.startsWith('cl-') ? jobName.slice(3) : ''
  // 36 for the UUID, 1 for the dash before it, and at least 1 slug character.
  if (body.length < 38) throw new Error(`not a containerless workspace handle: ${jobName}`)
  return {
    projectSlug: body.slice(0, body.length - 37),
    worktreeId: body.slice(-36),
  }
}

/**
 * The socket-path budget: `sockaddr_un.sun_path` is 104 bytes on macOS and
 * 108 on Linux, and a path over it fails to bind rather than truncating
 * usefully.
 *
 * macOS is the binding constraint and the reason every component below is
 * hashed rather than spelled out: a per-user `TMPDIR` there is
 * `/var/folders/XX/<~30 chars>/T` — about 48 bytes before yaac writes
 * anything. A full worktree UUID (36) plus a directory plus `.sock` would
 * clear the limit on its own, so the id is carried as a 12-hex-char digest
 * (48 bits — no realistic number of worktrees collides) and the install key
 * as 8. Worst case lands near 80 bytes, with room to spare.
 */
const SUN_PATH_MAX = 104

/** A worktree id, short enough to put in a socket path. See SUN_PATH_MAX. */
function shortId(worktreeId: string): string {
  return createHash('sha256').update(worktreeId).digest('hex').slice(0, 12)
}

/**
 * The directory holding every worktree's tmux socket, under the OS temp dir
 * rather than the data dir.
 *
 * Forced by the platform (see SUN_PATH_MAX): a data-dir path
 * (`~/.yaac/projects/<slug>/sessions/<uuid>/…`) is far over budget, and
 * `os.tmpdir()` is the shortest writable place on both platforms. It costs
 * nothing durable: a reboot clears it, and after a reboot every tmux server
 * it named is gone too, which is exactly what the recovery scan should
 * conclude. What IS durable — the marker that says this worktree exists —
 * lives under the data dir.
 *
 * Keyed by the install's own root so two servers on one host (a test run
 * beside a real one, two data dirs) never collide on a worktree id.
 */
export function tmuxSockDir(): string {
  const key = createHash('sha256').update(serverLocalPath()).digest('hex').slice(0, 8)
  return path.join(os.tmpdir(), `yaac-${key}`)
}

/**
 * Characters that would not survive being interpolated into the command
 * text the layers above author.
 *
 * Those strings are built with the quoting their own nesting needs — a tmux
 * prefix sits both at the top level of an `exec` and inside a single-quoted
 * script body, so it cannot carry quotes of its own — which works because
 * under the pod driver every path in them is a compile-time constant. Here
 * they are derived from `os.tmpdir()` and the data dir, so the same
 * guarantee has to be checked rather than assumed. Refusing at launch, with
 * the offending path named, beats a worktree whose `cd` silently ran
 * somewhere else.
 */
const SHELL_UNSAFE = /[^A-Za-z0-9_@%+=:,./-]/

/**
 * Fail a launch whose paths would not survive the command text, with the
 * reason and the fix.
 */
export function assertShellSafePaths(paths: WorkspacePaths): void {
  const offender = ([
    ['tmux socket', paths.tmuxSock],
    ['workspace', paths.workspaceDir],
    ['repo git dir', paths.repoGitDir],
    ['scratch', paths.scratchDir],
    ['acp socket dir', paths.acpSockDir],
  ] as const).find(([, value]) => SHELL_UNSAFE.test(value))
  if (!offender) return
  const [what, value] = offender
  throw new Error(
    `containerless: the ${what} path contains a character that cannot be `
    + `carried into a worktree's shell commands (${value}). Use a data dir `
    + 'and a TMPDIR without spaces or shell metacharacters.',
  )
}

/**
 * Fail a launch whose sockets would not bind, with the reason.
 *
 * A `TMPDIR` long enough to blow the budget is rare but not impossible, and
 * the failure it produces otherwise is an opaque bind error from tmux with
 * nothing pointing at the cause.
 */
export function assertSocketPathsFit(paths: WorkspacePaths): void {
  // The acpd socket is the longest thing written under the dir: one window
  // name (`claude-2`) plus the extension.
  const longest = path.join(paths.acpSockDir, 'opencode-2.sock')
  const over = [paths.tmuxSock, longest].filter((p) => Buffer.byteLength(p) > SUN_PATH_MAX)
  if (over.length === 0) return
  throw new Error(
    `containerless: socket path exceeds the ${String(SUN_PATH_MAX)}-byte limit `
    + `(${String(over[0])}). Set TMPDIR to a shorter directory.`,
  )
}

/** Where this driver keeps its own per-worktree state, under the state dir
 *  the worktree already owns — so a worktree's teardown carries it away. */
export function workspaceStateDir(projectSlug: string, worktreeId: string): string {
  return path.join(worktreeStateDir(projectSlug, worktreeId), 'containerless')
}

/**
 * The durable record that this driver launched a workspace.
 *
 * The substrate's analogue of a Job object: what a restart re-reads to
 * learn which worktrees it left running, since a tmux server outlives the
 * server that started it and there is nothing else on the host to enumerate.
 */
export function markerPath(projectSlug: string, worktreeId: string): string {
  return path.join(workspaceStateDir(projectSlug, worktreeId), 'workspace.json')
}

/**
 * The `$HOME` a workspace's processes run with.
 *
 * A private home per worktree, its entries symlinked to the per-project
 * tool homes the caller staged (`~/.yaac/projects/<slug>/claude`, …). That
 * is how a `hostPath` mount at `/home/yaac/.claude` is realized without a
 * container: the contract's own note that "a host-process driver reads a
 * hostPath as a bind or a symlink".
 */
export function workspaceHome(projectSlug: string, worktreeId: string): string {
  return path.join(workspaceStateDir(projectSlug, worktreeId), 'home')
}

/**
 * Where this driver's things are for one workspace — the contract's
 * `workspacePaths`, and the answer every command the layers above author is
 * written against.
 */
export function containerlessWorkspacePaths(jobName: string): WorkspacePaths {
  const { projectSlug, worktreeId } = refFromJobName(jobName)
  const state = workspaceStateDir(projectSlug, worktreeId)
  return {
    tmuxSock: path.join(tmuxSockDir(), `${shortId(worktreeId)}.sock`),
    // The checkout is a real host path that already exists: `git worktree
    // add` put it there, and nothing has to re-point its plumbing.
    workspaceDir: worktreeDir(projectSlug, worktreeId),
    repoGitDir: path.join(repoDir(projectSlug), '.git'),
    scratchDir: path.join(state, 'scratch'),
    // Beside the socket rather than under the state dir, for the sun_path
    // reason above: an acpd socket is addressed the same way tmux's is.
    acpSockDir: path.join(tmuxSockDir(), shortId(worktreeId)),
    // Same reason again: an ssh-agent socket is a UNIX socket path, and a
    // state-dir one would blow the same sun_path limit.
    sshAgentSock: path.join(tmuxSockDir(), `${shortId(worktreeId)}-ssh.sock`),
    // The one path here that is NOT this driver's own: the conversation record
    // is read by the layers above (the chat pane's tail, the registry's
    // first-prompt scan, the stopped worktree's transcript) at the shared
    // project location, so a driver-private one would be written where nobody
    // looks. It is also the only per-worktree thing that must outlive the
    // state dir above — that is pruned on stop, and a stopped worktree's
    // conversation stays readable.
    acpLogDir: acpLogDir(projectSlug, worktreeId),
    acpdEntry: acpdEntry(),
  }
}

/**
 * acpd's entry module on the host.
 *
 * The pod driver runs the copy baked into the worktree image at
 * `/opt/yaac/acpd`; there is no image here, so it runs the one that ships
 * with yaac itself. Both come from the same `dockerfiles/acpd` source — the
 * image COPYs it in, and the CLI build copies it into `dist/` — so the two
 * drivers supervise ACP agents with the same supervisor.
 *
 * `PACKAGE_ROOT` is the repo root in dev and `dist/` in a built install, and
 * `dockerfiles/acpd` is where the build puts it in both.
 */
export function acpdEntry(): string {
  return path.join(PACKAGE_ROOT, 'dockerfiles', 'acpd', 'main.js')
}
