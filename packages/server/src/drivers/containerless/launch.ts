import fs from 'node:fs/promises'
import path from 'node:path'
import { ServerError } from '@yaac/shared/errors'
import { agentBinDirs } from '@yaac/shared/tool-install'
import { serverLog } from '#log'
import { realizeGitAuth } from './git-auth'
import { runHost, onPath } from './host'
import {
  assertShellSafePaths,
  assertSocketPathsFit,
  containerlessJobName,
  containerlessWorkspacePaths,
  refFromJobName,
  tmuxSockDir,
  workspaceHome,
  containerlessStateDir,
} from './paths'
import {
  rememberWorkspace,
  sshAgentPidOf,
  workspaceEnv,
  workspaceLaunchEnv,
  writeMarker,
  type WorkspaceMarker,
} from './registry'
import { TOOL_HOME_VARS, overriddenToolHomeVars } from './tool-homes'
import type { RuntimeHandle, WorkspaceMount, WorkspaceSpec } from '#drivers/contract'

/**
 * Starting a workspace on the host: its private HOME, mounts realized as
 * symlinks, and the tmux server that supervises it.
 *
 * The tmux server is the unit (the equivalent of the pod driver's Job): it
 * existing means the workspace is up, and it outlives a `yaac server
 * restart`. Its session must match what `workspace-bin/yaac-workspace-init`
 * creates in a pod (placeholder window, window names, tmux options), since
 * driver-neutral code reads them.
 */

/** Server settings that must not leak into a workspace, which could use
 *  them to reconfigure the server. */
const ENV_DENY_PREFIXES = ['YAAC_']

/**
 * Variables a claude session sets on its child processes, inherited if the
 * server was started from inside one. A workspace must not see them: e.g.
 * `CLAUDE_CODE_CHILD_SESSION` disables transcript saving, and the messaging
 * pair would reach the parent session. List taken from the pinned claude.
 * Claude also sets `GIT_EDITOR=true`, which `workspaceEnvironment` removes
 * only in that exact case, since a host `GIT_EDITOR` may be a real setting.
 */
export const AGENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'AI_AGENT',
  'CLAUDE_EFFORT',
  'TRACEPARENT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
]

/** Host tool-home variables (see `tool-homes`) and agent session markers. */
const ENV_DENY_KEYS = [...TOOL_HOME_VARS, ...AGENT_SESSION_VARS]

/**
 * The server's environment minus its own `YAAC_*` settings, for processes
 * run as the user (workspaces, and the npm that installs agents).
 */
export function userEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  // eslint-disable-next-line no-process-env -- a host-run agent needs the user's PATH to find git, node and the rest of their toolchain; there is no image that installed them
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_DENY_PREFIXES.some((p) => key.startsWith(p))) continue
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * A workspace's environment: the user's (for their PATH and toolchain),
 * minus the deny lists above, plus the caller's entries and the private
 * HOME.
 */
function workspaceEnvironment(
  spec: Pick<WorkspaceSpec, 'env' | 'mounts'>,
  home: string,
  paths: { workspaceDir: string },
): NodeJS.ProcessEnv {
  const env = userEnvironment()
  // Without `true` a terminal's `git commit` aborts on an empty message.
  if (env.CLAUDECODE !== undefined && env.GIT_EDITOR === 'true') delete env.GIT_EDITOR
  for (const key of ENV_DENY_KEYS) delete env[key]
  for (const entry of spec.env) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    env[entry.slice(0, eq)] = remapMountedPath(entry.slice(eq + 1), spec.mounts, paths, home)
  }
  // After the caller's entries: the tool-home symlinks live in this HOME.
  env.HOME = home
  // The tmux server inherits this from its first client, so every pane has
  // it.
  env.COLORTERM = 'truecolor'
  // The workspace's helper scripts, then the pinned agents ahead of any the
  // user installed, since launch flags target the pinned versions.
  env.PATH = [workspaceBinDir(home), ...agentBinDirs(), env.PATH ?? ''].join(path.delimiter)
  return env
}

function gitconfigPathFor(home: string): string {
  return path.join(home, '.gitconfig')
}

/**
 * The environment for commands the server runs in a workspace (`exec`,
 * streams, the changes diff), so they see the workspace's config, not the
 * server's. The launch's full copy while held in memory; after a server
 * restart, rebuilt from the marker, which omits credentials (none of these
 * commands need them).
 */
export function workspaceRunEnvironment(jobName: string): NodeJS.ProcessEnv {
  const { projectSlug, workspaceId } = refFromJobName(jobName)
  const held = workspaceEnv(workspaceId)
  if (held !== undefined) return held
  const home = workspaceHome(projectSlug, workspaceId)
  const env = workspaceEnvironment(
    { env: [], mounts: [] },
    home,
    containerlessWorkspacePaths(jobName),
  )
  Object.assign(env, workspaceLaunchEnv(workspaceId))
  env.GIT_CONFIG_GLOBAL = gitconfigPathFor(home)
  return env
}

/** The launch's own env entries minus credentials, for the marker
 *  (`WorkspaceMarker.launchEnv`). */
function persistableLaunchEnv(
  env: NodeJS.ProcessEnv,
  spec: Pick<WorkspaceSpec, 'env' | 'secretEnvKeys'>,
  gitAuthEnv: Record<string, string>,
): Record<string, string> {
  const secret = new Set(spec.secretEnvKeys)
  const keys = [
    ...spec.env.map((e) => e.slice(0, Math.max(0, e.indexOf('=')))),
    ...Object.keys(gitAuthEnv),
  ]
  const out: Record<string, string> = {}
  for (const key of keys) {
    const value = env[key]
    if (key !== '' && !secret.has(key) && value !== undefined) out[key] = value
  }
  return out
}

/** The workspace's bin dir, first on its PATH (the pod's `/usr/local/bin`). */
function workspaceBinDir(home: string): string {
  return path.join(home, '.local', 'bin')
}

/**
 * Translate an env value naming a path inside a declared mount (callers write
 * container paths) to the mount's host source directory, not this driver's
 * symlink to it. The string matters: claude names its macOS Keychain item
 * after a hash of its config dir, and a per-workspace path would let one
 * workspace take the credential from its siblings.
 *
 * The longest matching mount wins. emptyDir mounts fall back to where the
 * driver put them. Only declared mounts are translated, never arbitrary
 * container-looking paths, since a user's own env values may be real host
 * paths (a dev host's home can be `/home/yaac`).
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
 * Realize a declared mount as a symlink (a bind mount would need root).
 *
 * Symlinks cannot nest like mounts: a mount under another mount's path would
 * write through the outer symlink into the project's shared dir. Those are
 * skipped and reported (`MountOutcome`); callers deliver such paths as host
 * state instead (e.g. `reconcileSharedSkillRoots`).
 */
type MountOutcome = 'realized' | 'nothing-to-do' | 'nested' | 'in-workspace'

async function realizeMount(
  mount: WorkspaceMount,
  paths: { workspaceDir: string },
  home: string,
): Promise<MountOutcome> {
  const { mountPath, source } = mount
  // emptyDir: a plain directory on the host.
  if (source.kind === 'emptyDir') return 'nothing-to-do'
  if (source.kind === 'pvc') {
    throw new ServerError(
      'VALIDATION',
      `containerless: cannot realize a volume claim mount at ${mountPath}`,
    )
  }

  // Already in place: the checkout, and the main clone at its own path.
  if (mountPath === paths.workspaceDir || mountPath === '/workspace') return 'nothing-to-do'
  if (mountPath === source.path) return 'nothing-to-do'

  // Skip mounts into the checkout: git would see a symlink as an untracked
  // file (and could commit it), and the ephemeral-modules symlink guard
  // would reject it. The checkout is on local disk, so a cache can simply
  // live there.
  if (mountPath.startsWith('/workspace/')
    || mountPath.startsWith(`${paths.workspaceDir}/`)) return 'in-workspace'

  const dest = destinationFor(mountPath, paths, home)
  if (dest === null) {
    // A config asking for something only a container can provide.
    throw new ServerError(
      'VALIDATION',
      `containerless: no host equivalent for a mount at ${mountPath}`,
    )
  }

  // Would write through another mount's symlink into shared state.
  if (await hasSymlinkedAncestor(dest, home)) return 'nested'

  await fs.mkdir(path.dirname(dest), { recursive: true })
  // Create a directory source so a first-run tool home is not a dangling
  // link.
  if (source.type === 'Directory' || source.type === 'DirectoryOrCreate' || !source.type) {
    await fs.mkdir(source.path, { recursive: true }).catch(() => { /* exists, or a file */ })
  }
  // Replace whatever a previous launch left.
  await fs.rm(dest, { recursive: true, force: true }).catch(() => { /* nothing there */ })
  await fs.symlink(source.path, dest)
  return 'realized'
}

/** Where a container mount path lands on this host, or null if it has no
 *  host equivalent. */
function destinationFor(
  mountPath: string,
  paths: { workspaceDir: string },
  home: string,
): string | null {
  const inHome = underPrefix(mountPath, '/home/yaac/') ?? underPrefix(mountPath, `${home}/`)
  if (inHome !== null) return path.join(home, inHome)
  // The pod's `/usr/local/bin` maps to the workspace's own bin dir.
  const inBin = underPrefix(mountPath, '/usr/local/bin/')
  if (inBin !== null) return path.join(workspaceBinDir(home), inBin)
  const inWorkspace = underPrefix(mountPath, '/workspace/')
  if (inWorkspace !== null) return path.join(paths.workspaceDir, inWorkspace)
  if (underPrefix(mountPath, `${paths.workspaceDir}/`) !== null) return mountPath
  return null
}

/** Whether any directory between `dest` and `home` is a symlink. */
async function hasSymlinkedAncestor(dest: string, home: string): Promise<boolean> {
  let dir = path.dirname(dest)
  while (dir.startsWith(home) && dir !== home) {
    try {
      if ((await fs.lstat(dir)).isSymbolicLink()) return true
    } catch {
      // Does not exist yet.
    }
    dir = path.dirname(dir)
  }
  return false
}

function underPrefix(value: string, prefix: string): string | null {
  return value.startsWith(prefix) ? value.slice(prefix.length) : null
}

/** The workspace's shell: `$SHELL`, else zsh, bash, then sh. */
async function resolveShell(): Promise<string> {
  // eslint-disable-next-line no-process-env -- the workspace's login shell is the host user's own preference, which only the environment states
  for (const candidate of [process.env.SHELL, 'zsh', 'bash']) {
    if (candidate === undefined) continue
    if (path.isAbsolute(candidate) || await onPath(candidate)) return candidate
  }
  return 'sh'
}

/** See `WorkspaceDriver.launch`. */
export async function launchWorkspace(spec: WorkspaceSpec): Promise<RuntimeHandle> {
  const jobName = containerlessJobName(spec.projectSlug, spec.workspaceId)
  const paths = containerlessWorkspacePaths(jobName)
  const home = workspaceHome(spec.projectSlug, spec.workspaceId)

  // Before creating anything; both failures are otherwise obscure.
  assertSocketPathsFit(paths)
  assertShellSafePaths(paths)

  spec.onProgress?.('Preparing the workspace environment...')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(paths.scratchDir, { recursive: true })
  await fs.mkdir(paths.acpLogDir, { recursive: true })
  await fs.mkdir(paths.acpSockDir, { recursive: true })
  // 0700: a tmux socket gives full control of its workspace.
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
      + 'in the checkout rather than redirecting them (cache volumes)',
    )
  }
  if (nested > 0) {
    // Unexpected: it means a caller expects mounts to nest.
    serverLog(
      `[server] containerless ${spec.workspaceId}: skipped ${String(nested)} mount(s) `
      + 'that would nest inside another, writing through it into shared state',
    )
  }

  const env = workspaceEnvironment(spec, home, paths)
  // Tell the user which host tool-home variables were dropped (unless the
  // project env set them again), since ignoring them is otherwise silent.
  const overridden = overriddenToolHomeVars().filter((key) => env[key] === undefined)
  if (overridden.length > 0) {
    const message = `Ignoring ${overridden.join(', ')} from this host's environment `
      + "— a workspace's agent reads this project's tool config, under its own HOME."
    spec.onProgress?.(message)
    serverLog(`[server] containerless ${spec.workspaceId}: ${message}`)
  }

  // Git identity, trust and auth in the workspace's own HOME, as the pod's
  // init script writes them (auth only here; see `git-auth`).
  const priorAgentPid = sshAgentPidOf(spec.workspaceId)
  const gitAuth = await realizeGitAuth({
    home,
    credential: spec.gitCredential,
    knownHostsFile: spec.ssh?.knownHostsFile,
    agentSock: paths.sshAgentSock,
    ...(priorAgentPid !== undefined ? { priorAgentPid } : {}),
  })
  const gitName = env.YAAC_GIT_NAME ?? env.GIT_AUTHOR_NAME
  const gitEmail = env.YAAC_GIT_EMAIL ?? env.GIT_AUTHOR_EMAIL
  const gitconfig = [
    '[user]',
    ...(gitName !== undefined ? [`\tname = ${gitConfigValue(gitName)}`] : []),
    ...(gitEmail !== undefined ? [`\temail = ${gitConfigValue(gitEmail)}`] : []),
    '[safe]',
    `\tdirectory = ${paths.workspaceDir}`,
    ...gitAuth.gitconfig,
    '',
  ].join('\n')
  const gitconfigPath = gitconfigPathFor(home)
  await fs.writeFile(gitconfigPath, gitconfig)
  // After the caller's entries, so none can disable ssh host verification.
  Object.assign(env, gitAuth.env)
  // Set explicitly and last, so an inherited `GIT_CONFIG_GLOBAL` cannot make
  // git silently ignore the config written above.
  env.GIT_CONFIG_GLOBAL = gitconfigPath

  const shell = await resolveShell()
  const statusRight = env.YAAC_STATUS_RIGHT ?? ''

  spec.onProgress?.('Starting the workspace session...')
  // Start on a `sleep infinity` placeholder, as the pod's init script does;
  // the agent is respawned in after setup, and the stale reaper recognizes
  // the placeholder. A large -x/-y lets tmux shrink to the client on attach,
  // which TUIs handle better than growing.
  //
  // `update-environment` is emptied before any client attaches; otherwise
  // the liveness watch (attaching with the server's env) would give the
  // panes the host's SSH_AUTH_SOCK. `history-limit` is set before the
  // session, since tmux fixes a pane's limit when it is created and the
  // agent keeps this first pane across respawns.
  await runHost([
    'tmux', '-S', paths.tmuxSock, '-u',
    'start-server', ';',
    'set-option', '-g', 'history-limit', '200000', ';',
    'new-session', '-d', '-s', 'yaac', '-n', spec.tool,
    '-x', '500', '-y', '200', '-c', paths.workspaceDir,
    'sleep infinity', ';',
    'set-option', '-g', 'update-environment', '',
  ], { cwd: paths.workspaceDir, env, timeoutMs: 30_000 })

  // The same UX options as the pod's init script, plus `default-shell`.
  await runHost([
    'tmux', '-S', paths.tmuxSock,
    'set-option', '-g', 'default-shell', shell, ';',
    'set-option', '-s', 'escape-time', '10', ';',
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
    // Cosmetic; do not fail the create.
    serverLog(`[server] containerless ${spec.workspaceId}: tmux options failed: ${String(err)}`)
  })

  const marker: WorkspaceMarker = {
    projectSlug: spec.projectSlug,
    workspaceId: spec.workspaceId,
    tool: spec.tool,
    declaredTool: spec.tool,
    mode: spec.mode,
    prewarm: spec.prewarm,
    createdAtMs: Date.now(),
    ...(await tmuxServerPid(paths.tmuxSock, env)),
    // So teardown can kill the ssh-agent.
    ...(gitAuth.agentPid !== undefined ? { sshAgentPid: gitAuth.agentPid } : {}),
    launchEnv: persistableLaunchEnv(env, spec, gitAuth.env),
  }
  await writeMarker(marker)
  return rememberWorkspace(marker, env)
}

/** The tmux server's pid, for the port scan. Omitted on failure. */
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

/** See `WorkspaceDriver.prepareSubstrate`. Nothing to prepare here. */
export function prepareSubstrate(): Promise<{ readonly kind: 'workspace-substrate' }> {
  return Promise.resolve({ kind: 'workspace-substrate' } as const)
}

/** See `WorkspaceDriver.awaitReady`. Ready once `launch` resolves. */
export function awaitReady(): Promise<void> {
  return Promise.resolve()
}

export { containerlessStateDir }

/** Quote and escape a git-config value so it reads back verbatim and
 *  cannot break the file. */
function gitConfigValue(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n')}"`
}
