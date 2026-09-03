import fs from 'node:fs/promises'
import path from 'node:path'
import { ServerError } from '@yaac/shared/errors'
import { serverLog } from '#log'
import { realizeGitAuth } from './git-auth'
import { runHost, onPath } from './host'
import {
  assertShellSafePaths,
  assertSocketPathsFit,
  containerlessJobName,
  containerlessWorkspacePaths,
  tmuxSockDir,
  workspaceHome,
  workspaceStateDir,
} from './paths'
import { rememberWorkspace, writeMarker, type WorkspaceMarker } from './registry'
import { TOOL_HOME_VARS, overriddenToolHomeVars } from './tool-homes'
import type { RuntimeHandle, WorkspaceMount, WorkspaceSpec } from '#drivers/contract'

/**
 * Starting a workspace on the host: its private HOME, the mounts realized
 * as symlinks, and the tmux server that supervises everything in it.
 *
 * The tmux server is the unit. It is what the pod driver's Job is: the thing
 * whose existence means the workspace is up, whose death means it is gone,
 * and which deliberately outlives the yaac server that started it — a `yaac
 * server restart` must not stop anyone's agent.
 *
 * The session's shape is the same one `worktree-bin/yaac-worktree-init`
 * creates in a pod, and has to be: the placeholder window the stale reaper
 * recognizes, the window naming the status watcher parses, and the tmux
 * options the webapp's terminal rendering depends on are all read by
 * driver-neutral machinery that cannot tell the two substrates apart.
 */

/** Server-owned environment that must not leak into a workspace: the
 *  agents run as this user, and handing them the server's own wiring
 *  invites a worktree to reconfigure the server that launched it. */
const ENV_DENY_PREFIXES = ['YAAC_']

/** Host variables that could point a tool somewhere other than the project
 *  dirs staged for this workspace. See `tool-homes` for which of these the
 *  create names outright and which have nothing to name. */
const ENV_DENY_KEYS = TOOL_HOME_VARS

/**
 * The environment a workspace's processes get: the server's own, stripped
 * of its wiring, plus what the caller decided, plus the private HOME.
 *
 * Inheriting the host environment at all is a real decision, not an
 * oversight — a host-run agent needs the user's PATH to find `git`, `node`
 * and the agent CLI itself, and there is no image to have installed them.
 * What is inherited is therefore chosen twice: broadly here, then narrowed
 * by the two deny lists above.
 */
function workspaceEnvironment(
  spec: WorkspaceSpec,
  home: string,
  paths: { workspaceDir: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  // eslint-disable-next-line no-process-env -- a host-run agent needs the user's PATH to find git, node and the agent CLI; there is no image that installed them
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_DENY_PREFIXES.some((p) => key.startsWith(p))) continue
    if (ENV_DENY_KEYS.has(key)) continue
    if (value !== undefined) env[key] = value
  }
  for (const entry of spec.env) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    env[entry.slice(0, eq)] = remapMountedPath(entry.slice(eq + 1), spec.mounts, paths, home)
  }
  // After the caller's entries: the private home is this driver's to decide,
  // and it is what makes the tool-home symlinks below reachable.
  env.HOME = home
  // Seeds the tmux SERVER environment (it forks from the first client), so
  // every pane inherits it — same reason the pod's init script sets it.
  env.COLORTERM = 'truecolor'
  return env
}

/** Where a workspace's own executables go, and what is prepended to its
 *  PATH — the host stand-in for the pod's `/usr/local/bin`. */
function workspaceBinDir(home: string): string {
  return path.join(home, '.local', 'bin')
}

/**
 * A caller's env value that names a path inside one of this workspace's own
 * mounts, translated to the directory that mount actually came from.
 *
 * The caller writes `spec.env` against the container layout, because that is
 * the one filesystem every driver was written against: a tool is pointed at
 * its home inside the mount that carries it, and under a pod that is exactly
 * where the mount put it. Here there is no mount, so the value has to be
 * translated — and the SOURCE is what it translates to, not the symlink this
 * driver made pointing at it.
 *
 * Both name the same files, and the difference is the string. A tool that
 * keys anything on the string it was handed sees a per-worktree home if it
 * gets the link, because the private home is per worktree, and a per-project
 * one if it gets the source, because the staged dir is per project. claude is
 * the case that proves it — its macOS Keychain item is named after a hash of
 * this exact value, and the first token refresh migrates the credential into
 * that item and deletes the file it came from, so a per-worktree name would
 * let one worktree take the credential away from its siblings. Handing over
 * the real directory makes that impossible to get wrong from a call site,
 * instead of correct only where someone remembered.
 *
 * The longest matching mount wins, so a value under a nested mount resolves
 * to the inner one's source rather than the outer's. A mount with no host
 * directory behind it (an emptyDir) has no source to name, so those fall back
 * to wherever this driver put the mount.
 *
 * Read off the mounts the spec DECLARED, not the ones `realizeMount` managed
 * to make, and a nested mount is where that matters: those are skipped here
 * rather than linked, and the destination string for one would resolve
 * through the OUTER mount's link into the outer source — a different
 * directory than the value asked for. The source is the only truthful answer
 * there. Its one sharp edge is that a skipped mount's source is not created,
 * so such a value can name a directory that does not exist yet; no caller
 * writes one today, and the alternative names the wrong directory.
 *
 * Deliberately scoped to a DECLARED mount rather than rewriting anything that
 * looks container-absolute. `envPassthrough` and `config.env` values are the
 * user's own, and a yaac dev host runs as a user whose home is literally
 * `/home/yaac` — a blanket rewrite would silently redirect a real host path
 * they passed in. A path under a mount this workspace asked for can only have
 * meant this workspace's copy of it.
 */
function remapMountedPath(
  value: string,
  mounts: WorkspaceMount[],
  paths: { workspaceDir: string },
  home: string,
): string {
  const matches = mounts.filter(({ mountPath }) =>
    value === mountPath || value.startsWith(`${mountPath}/`))
  if (matches.length === 0) return value
  const mount = matches.reduce((a, b) => b.mountPath.length > a.mountPath.length ? b : a)
  if (mount.source.kind === 'hostPath') {
    return path.join(mount.source.path, value.slice(mount.mountPath.length))
  }
  return destinationFor(value, paths, home) ?? value
}

/**
 * Realize one caller-declared mount on a host that has no mount namespaces.
 *
 * The contract anticipates this: "a host-process driver reads a hostPath as
 * a bind or a symlink". A symlink, here — a real bind mount needs root, and
 * asking a developer to run yaac as root to open a worktree is not a trade
 * this mode is for.
 *
 * Which is also the one thing symlinks cannot do that mounts can: NEST. A
 * pod mounts the project's claude dir at `/home/yaac/.claude` and then a
 * builtin skill at `/home/yaac/.claude/skills/<name>` on top of it, and the
 * two compose. Here the first is a symlink into the project's shared dir,
 * so writing the second would reach THROUGH it and leave one worktree's
 * staging in a directory every other worktree of the project reads. Those
 * are skipped and reported rather than written (see `MountOutcome`).
 *
 * A caller that wants a nested path delivered anyway states it as host
 * state instead of as a mount, which is what the shared skills roots are
 * (`reconcileSharedSkillRoots`): per project, because that is what the dir it
 * lands in already is.
 */
type MountOutcome = 'realized' | 'nothing-to-do' | 'nested' | 'in-workspace'

async function realizeMount(
  mount: WorkspaceMount,
  paths: { workspaceDir: string; repoGitDir: string },
  home: string,
): Promise<MountOutcome> {
  const { mountPath, source } = mount
  // An emptyDir is scratch the workspace would have created for itself;
  // on a host every such path is already just a directory.
  if (source.kind === 'emptyDir') return 'nothing-to-do'
  if (source.kind === 'pvc') {
    throw new ServerError(
      'VALIDATION',
      `containerless: cannot realize a volume claim mount at ${mountPath}`,
    )
  }

  // Already where the workspace looks for it.
  if (mountPath === paths.workspaceDir || mountPath === paths.repoGitDir) return 'nothing-to-do'
  if (mountPath === '/workspace' || mountPath === '/repo/.git') return 'nothing-to-do'

  // A mount INTO the checkout is skipped rather than linked. Under a pod
  // these redirect `node_modules` and cache volumes onto storage that is
  // not the pod's ephemeral disk, and git never sees them because they are
  // mounts. A symlink is not a mount: git reports it as an untracked file
  // (so it lands in the review diff, and `git add -A` commits an absolute
  // host path), and the ephemeral-modules guard — which exists to stop a
  // committed `foo -> /anywhere` becoming a host-side mkdir — trips on the
  // driver's own link, which made a stopped worktree unrestartable.
  //
  // Nothing is lost that this substrate needs: the checkout is on the
  // host's own disk, so `node_modules` living in it is exactly where a
  // developer would put it. What is lost is the per-worktree module cache,
  // which was a pod-storage optimization.
  if (mountPath.startsWith('/workspace/')
    || mountPath.startsWith(`${paths.workspaceDir}/`)) return 'in-workspace'

  const dest = destinationFor(mountPath, paths, home)
  if (dest === null) {
    // Deliberately loud. The cause is a config asking for something only a
    // container can give (a sidecar's socket, a path outside the
    // workspace), and the honest answer is that this mode cannot.
    throw new ServerError(
      'VALIDATION',
      `containerless: no host equivalent for a mount at ${mountPath}`,
    )
  }

  // A destination whose own parent is a link this driver made would be
  // written through it, into shared state (see the note above).
  if (await hasSymlinkedAncestor(dest, home)) return 'nested'

  await fs.mkdir(path.dirname(dest), { recursive: true })
  // The source has to exist for a File mount to make sense; a directory
  // source is created so a first-run tool home is not a dangling link.
  if (source.type === 'Directory' || source.type === 'DirectoryOrCreate' || !source.type) {
    await fs.mkdir(source.path, { recursive: true }).catch(() => { /* exists, or a file */ })
  }
  // Replace whatever a previous launch left: a symlink is idempotent state,
  // and a relaunch after a failed attempt must not trip over its own link.
  await fs.rm(dest, { recursive: true, force: true }).catch(() => { /* nothing there */ })
  await fs.symlink(source.path, dest)
  return 'realized'
}

/** Where a container-absolute mount path lands on this host, or null when
 *  it names a filesystem this driver has no answer for. */
function destinationFor(
  mountPath: string,
  paths: { workspaceDir: string },
  home: string,
): string | null {
  const inHome = underPrefix(mountPath, '/home/yaac/') ?? underPrefix(mountPath, `${home}/`)
  if (inHome !== null) return path.join(home, inHome)
  // The pod's `/usr/local/bin` is where the server stages the helper
  // scripts a worktree's agent can run (`yaac-mama`, the init script).
  // There is no writable system bin here, so they go in the workspace's own
  // bin dir, which the launch puts on its PATH.
  const inBin = underPrefix(mountPath, '/usr/local/bin/')
  if (inBin !== null) return path.join(workspaceBinDir(home), inBin)
  const inWorkspace = underPrefix(mountPath, '/workspace/')
  if (inWorkspace !== null) return path.join(paths.workspaceDir, inWorkspace)
  if (underPrefix(mountPath, `${paths.workspaceDir}/`) !== null) return mountPath
  return null
}

/** Whether any directory between `dest` and `home` is a symlink — i.e.
 *  whether writing `dest` would land somewhere other than where it reads. */
async function hasSymlinkedAncestor(dest: string, home: string): Promise<boolean> {
  let dir = path.dirname(dest)
  while (dir.startsWith(home) && dir !== home) {
    try {
      if ((await fs.lstat(dir)).isSymbolicLink()) return true
    } catch {
      // Does not exist yet, so nothing it could be pointing through.
    }
    dir = path.dirname(dir)
  }
  return false
}

function underPrefix(value: string, prefix: string): string | null {
  return value.startsWith(prefix) ? value.slice(prefix.length) : null
}

/** The login shell a workspace's windows run. Falls back through the host's
 *  own preference, since there is no image guaranteeing zsh exists. */
async function resolveShell(): Promise<string> {
  // eslint-disable-next-line no-process-env -- the workspace's login shell is the host user's own preference, which only the environment states
  for (const candidate of [process.env.SHELL, 'zsh', 'bash']) {
    if (candidate === undefined) continue
    if (path.isAbsolute(candidate) || await onPath(candidate)) return candidate
  }
  return 'sh'
}

/** See `WorktreeDriver.launch`. */
export async function launchWorkspace(spec: WorkspaceSpec): Promise<RuntimeHandle> {
  const jobName = containerlessJobName(spec.projectSlug, spec.workspaceId)
  const paths = containerlessWorkspacePaths(jobName)
  const home = workspaceHome(spec.projectSlug, spec.workspaceId)

  // Both before anything is created, and for the same reason: each failure
  // is otherwise silent or opaque — a socket over the platform's limit
  // fails inside tmux, and a path with a space runs a `cd` somewhere else.
  assertSocketPathsFit(paths)
  assertShellSafePaths(paths)

  spec.onProgress?.('Preparing the worktree environment...')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(paths.scratchDir, { recursive: true })
  await fs.mkdir(paths.acpLogDir, { recursive: true })
  await fs.mkdir(paths.acpSockDir, { recursive: true })
  // 0700: the socket dir is shared with every other worktree's on this
  // host, and a tmux socket is a full command channel into the workspace.
  await fs.mkdir(tmuxSockDir(), { recursive: true, mode: 0o700 })

  await fs.mkdir(workspaceBinDir(home), { recursive: true })
  let nested = 0
  let inWorkspace = 0
  for (const mount of spec.mounts) {
    const outcome = await realizeMount(mount, paths, home)
    if (outcome === 'nested') nested++
    if (outcome === 'in-workspace') inWorkspace++
  }
  if (inWorkspace > 0) {
    serverLog(
      `[server] containerless ${spec.workspaceId}: left ${String(inWorkspace)} path(s) `
      + 'in the checkout rather than redirecting them (node_modules, cache volumes)',
    )
  }
  if (nested > 0) {
    // Nothing routinely lands here: the one caller that layered over a tool
    // home (yaac's builtin skills) now writes the host's shared skills roots
    // directly. A count here means a new caller expects mounts to compose.
    serverLog(
      `[server] containerless ${spec.workspaceId}: skipped ${String(nested)} mount(s) `
      + 'that would nest inside another, writing through it into shared state',
    )
  }

  const env = workspaceEnvironment(spec, home, paths)
  // Said out loud, because ignoring a user's environment is otherwise
  // indistinguishable from honoring it: the agent reads this project's tool
  // config either way, and only the user knows they had pointed it
  // somewhere else. Reported per create rather than once at startup because
  // this is the moment it takes effect, and a create is what the user is
  // watching. `yaac host check` answers the same question ahead of time.
  // Only what the workspace actually ends up without: a spec that re-supplies
  // one of these (envPassthrough, config.env) has overruled the host itself,
  // and announcing a value the agent is about to receive would be a lie about
  // the one thing this notice exists to report.
  const overridden = overriddenToolHomeVars().filter((key) => env[key] === undefined)
  if (overridden.length > 0) {
    const message = `Ignoring ${overridden.join(', ')} from this host's environment `
      + "— a worktree's agent reads this project's tool config, under its own HOME."
    spec.onProgress?.(message)
    serverLog(`[server] containerless ${spec.workspaceId}: ${message}`)
  }

  // The helper scripts staged above are only useful if the workspace can
  // find them — the pod gets that from `/usr/local/bin` already being on
  // PATH, and here it has to be said.
  env.PATH = `${workspaceBinDir(home)}${path.delimiter}${env.PATH ?? ''}`

  // Git identity, trust and authentication, in the workspace's OWN home —
  // the pod driver writes the same settings from its postStart hook, into a
  // home that is per-pod for exactly the same reason this one is
  // per-worktree: a `--global` write must never race another worktree's.
  //
  // Authentication is the half a pod does NOT write, because a pod never
  // holds a credential to write; here the workspace is handed the real one
  // and this is where it lands (see `git-auth`).
  const gitAuth = await realizeGitAuth({
    home,
    credential: spec.gitCredential,
    knownHostsFile: spec.ssh?.knownHostsFile,
  })
  const gitName = env.YAAC_GIT_NAME ?? env.GIT_AUTHOR_NAME
  const gitEmail = env.YAAC_GIT_EMAIL ?? env.GIT_AUTHOR_EMAIL
  const gitconfig = [
    '[user]',
    ...(gitName !== undefined ? [`\tname = ${gitName}`] : []),
    ...(gitEmail !== undefined ? [`\temail = ${gitEmail}`] : []),
    '[safe]',
    `\tdirectory = ${paths.workspaceDir}`,
    `\tdirectory = ${paths.repoGitDir}`,
    ...gitAuth.gitconfig,
    '',
  ].join('\n')
  const gitconfigPath = path.join(home, '.gitconfig')
  await fs.writeFile(gitconfigPath, gitconfig)
  // After the caller's entries, like HOME above: this is the driver's own
  // wiring, and a passthrough value cannot be allowed to disarm the host
  // verification the ssh command carries.
  Object.assign(env, gitAuth.env)
  // Pinned rather than left to `$HOME` to find: this workspace inherits the
  // server's environment, and a server started with `GIT_CONFIG_GLOBAL` set
  // would have everything written above — the identity, the trusted
  // directories, the credential helper — silently ignored in favor of
  // whatever that names. Assigned LAST for the same reason, and any filter
  // this environment grows must leave it alone: strip it and the workspace's
  // git config goes quiet, with nothing to say it did.
  env.GIT_CONFIG_GLOBAL = gitconfigPath

  const shell = await resolveShell()
  const statusRight = env.YAAC_STATUS_RIGHT ?? ''

  spec.onProgress?.('Starting the worktree session...')
  // The session opens on a long-sleep placeholder rather than the agent,
  // exactly as the pod's init hook does: the agent is respawned in once
  // setup finishes, and a fast-failing command here would end the tmux
  // session before that. The placeholder is also what the stale reaper's
  // pane probe recognizes as "started but not yet running an agent" — that
  // probe reads `pane_current_command`, so what matters is that this stays
  // a `sleep`, not what it is counting to.
  //
  // A COUNT rather than `infinity`, unlike the pod's, and that is the whole
  // reason this differs: `sleep infinity` is a GNU coreutils extension, and
  // the BSD `sleep` a macOS host has rejects it outright. The placeholder
  // would exit instantly, tmux would close its only window, and the session
  // — the worktree — would be gone before `awaitAgentTransport` ever asked
  // for it. A pod runs its own image's coreutils and is unaffected; this
  // runs whatever the host has.
  //
  // -x/-y are generous so the respawned agent inherits a window larger than
  // any real terminal; tmux shrinks it to the client on attach, and
  // shrink-then-render is what TUIs handle reliably.
  await runHost([
    'tmux', '-S', paths.tmuxSock, '-u',
    'new-session', '-d', '-s', 'yaac', '-n', spec.tool,
    '-x', '500', '-y', '200', '-c', paths.workspaceDir,
    // ~68 years, the largest a 32-bit `time_t` will take.
    'sleep 2147483647',
  ], { cwd: paths.workspaceDir, env, timeoutMs: 30_000 })

  // Session UX options, one invocation — the same set the pod's init hook
  // applies, and for the same reasons (bells reaching the client, CSI-u
  // extended keys for agent TUIs, RGB passthrough so diffs are readable).
  // `default-shell` is the one addition: a pod has a known shell in its
  // image and a host does not.
  await runHost([
    'tmux', '-S', paths.tmuxSock,
    'set-option', '-g', 'default-shell', shell, ';',
    'set-option', '-g', 'history-limit', '200000', ';',
    'set-option', '-g', 'mouse', 'on', ';',
    'set-option', '-g', 'focus-events', 'on', ';',
    'set-option', '-g', 'monitor-bell', 'on', ';',
    'set-option', '-g', 'bell-action', 'any', ';',
    'set-option', '-g', 'visual-bell', 'off', ';',
    'set-option', '-g', 'allow-passthrough', 'on', ';',
    'set-option', '-g', 'extended-keys', 'on', ';',
    'set-option', '-g', 'default-terminal', 'tmux-256color', ';',
    'set-option', '-as', 'terminal-features', ',*:RGB', ';',
    'set-option', '-t', 'yaac', 'status-right-length', '80', ';',
    'set-option', '-t', 'yaac', 'status-right', statusRight, ';',
    'bind-key', 'k', 'confirm-before', '-p', 'kill this yaac session? (y/n)', 'kill-server',
  ], { env, timeoutMs: 30_000 }).catch((err: unknown) => {
    // Cosmetic to a fault: every one of these is a display or input-handling
    // preference, and a worktree whose bells do not ring is far better than
    // a create that failed after the session came up.
    serverLog(`[server] containerless ${spec.workspaceId}: tmux options failed: ${String(err)}`)
  })

  const marker: WorkspaceMarker = {
    projectSlug: spec.projectSlug,
    worktreeId: spec.workspaceId,
    tool: spec.tool,
    declaredTool: spec.tool,
    mode: spec.mode,
    prewarm: spec.prewarm,
    createdAtMs: Date.now(),
    ...(await tmuxServerPid(paths.tmuxSock, env)),
  }
  await writeMarker(marker)
  return rememberWorkspace(marker, env)
}

/** The tmux server's pid, for the port scan's process-tree walk. Absent
 *  rather than fatal: without it ports simply go unreported. */
async function tmuxServerPid(
  sock: string,
  env: NodeJS.ProcessEnv,
): Promise<{ tmuxPid?: number }> {
  try {
    const { stdout } = await runHost(
      ['tmux', '-S', sock, 'display-message', '-p', '#{pid}'],
      { env, timeoutMs: 10_000 },
    )
    const pid = Number(stdout.trim())
    return Number.isInteger(pid) && pid > 0 ? { tmuxPid: pid } : {}
  } catch {
    return {}
  }
}

/**
 * Everything a workspace needs standing up around it — which here is
 * nothing.
 *
 * There is no image to build, no egress policy to install and no cluster to
 * prepare; the checkout the caller made IS the substrate. The receipt is
 * still taken and handed back to `launch`, because the contract's shape is
 * what lets a retried launch reuse one preparation, and answering it
 * honestly costs a single object.
 */
export function prepareSubstrate(): Promise<{ readonly kind: 'workspace-substrate' }> {
  return Promise.resolve({ kind: 'workspace-substrate' } as const)
}

/** See `WorktreeDriver.awaitReady`. The session exists the moment `launch`
 *  resolved — there is no scheduler, no image pull and no kubelet between
 *  the two — so readiness is already proven. */
export function awaitReady(): Promise<void> {
  return Promise.resolve()
}

/** Where the workspace's state dir lives, for a teardown that must remove
 *  it. Re-exported so teardown need not reach into `paths` for one name. */
export { workspaceStateDir }
