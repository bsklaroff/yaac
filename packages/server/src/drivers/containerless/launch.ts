import fs from 'node:fs/promises'
import path from 'node:path'
import { ServerError } from '@yaac/shared/errors'
import { gitConfigValue } from '@yaac/shared/git'
import { AGENT_PACKAGES, agentBinDirs, agentPackagePrefix } from '@yaac/shared/tool-install'
import { serverLog } from '#lib/log'
import { shellQuote } from '#lib/shell'
import { realizeGitAuth } from './git-auth'
import { findOnPath, killPids, runHost } from './host'
import {
  assertShellSafePaths,
  assertSocketPathsFit,
  containerlessJobName,
  containerlessWorkspacePaths,
  hostShellDir,
  refFromJobName,
  tmuxSockDir,
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
import { allocatedPorts } from './ports'
import { TOOL_HOME_VARS, overriddenToolHomeVars } from './tool-homes'
import { KEEPER_STARTING, type RuntimeHandle, type WorkspaceMount, type WorkspacePaths, type WorkspaceSpec } from '#drivers/contract'

/**
 * Starting a workspace on the host: its environment (the user's own, with
 * yaac's tool homes and git credentials), its mounts, and the tmux server
 * that supervises it.
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
 * A workspace's own files, in the driver's state dir so a stop removes them,
 * and the variables naming them. Derived from the ids alone, so a restarted
 * server rebuilds them for `workspaceRunEnvironment`. The prompt stash's
 * script finds opencode's state through `YAAC_OPENCODE_STATE`.
 */
function stateEnv(projectId: string, workspaceId: string, paths: WorkspacePaths) {
  const dir = containerlessStateDir(projectId, workspaceId)
  return {
    GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'),
    GH_CONFIG_DIR: path.join(dir, 'gh'),
    YAAC_WATCH_PRS_STATE: path.join(dir, 'watch-prs-seen'),
    YAAC_OPENCODE_STATE: path.join(opencodeHome(dir), 'state'),
    YAAC_SHELL_ENV: path.join(dir, 'shell-env'),
    // A non-interactive bash, `bash -lc` included, reads it after the
    // user's files.
    BASH_ENV: path.join(dir, 'shell-env'),
    YAAC_WORKSPACE_DIR: paths.workspaceDir,
  }
}

/** opencode's XDG dirs (`opencodeWrapper`): `config` and `data` hold links
 *  to the project's dirs, `state` and `cache` are the workspace's own. */
function opencodeHome(stateDir: string): string {
  return path.join(stateDir, 'opencode')
}

/** The driver's own bin dir, holding the `opencode` wrapper. */
function ownBinDir(stateDir: string): string {
  return path.join(stateDir, 'bin')
}

/**
 * What a workspace's PATH leads with: the helper scripts a pod has in
 * `/usr/local/bin` (each mount's staged source dir), the driver's own bin
 * dir, then the pinned agents ahead of any the user installed, since launch
 * flags target the pinned versions.
 */
function pathPrefix(spec: Pick<WorkspaceSpec, 'projectId' | 'workspaceId' | 'mounts'>): string[] {
  const staged = spec.mounts.flatMap(({ mountPath, source }) =>
    source.kind === 'hostPath' && mountPath.startsWith('/usr/local/bin/') ? [path.dirname(source.path)] : [])
  return [
    ...new Set(staged),
    ownBinDir(containerlessStateDir(spec.projectId, spec.workspaceId)),
    ...agentBinDirs(),
  ]
}

/**
 * A workspace's environment: the user's (for their HOME, PATH and
 * toolchain), minus the deny lists above, plus the caller's entries and the
 * driver's own.
 */
function workspaceEnvironment(
  spec: Pick<WorkspaceSpec, 'projectId' | 'workspaceId' | 'env' | 'mounts'>,
  paths: WorkspacePaths,
): NodeJS.ProcessEnv {
  const env = userEnvironment()
  // Without `true` a terminal's `git commit` aborts on an empty message.
  if (env.CLAUDECODE !== undefined && env.GIT_EDITOR === 'true') delete env.GIT_EDITOR
  for (const key of ENV_DENY_KEYS) delete env[key]
  for (const entry of spec.env) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    env[entry.slice(0, eq)] = remapMountedPath(entry.slice(eq + 1), spec.mounts)
  }
  // After the caller's entries, so an inherited or project `GIT_CONFIG_GLOBAL`
  // cannot make git silently ignore the config the launch writes.
  Object.assign(env, stateEnv(spec.projectId, spec.workspaceId, paths))
  // The tmux server inherits this from its first client, so every pane has
  // it.
  env.COLORTERM = 'truecolor'
  env.PATH = [...pathPrefix(spec), env.PATH ?? ''].join(path.delimiter)
  return env
}

/**
 * The environment for commands the server runs in a workspace (`exec`,
 * streams, the changes diff), so they see the workspace's config, not the
 * server's. The launch's full copy while held in memory; after a server
 * restart, rebuilt from the marker, which omits credentials (none of these
 * commands need them).
 */
export function workspaceRunEnvironment(jobName: string): NodeJS.ProcessEnv {
  const ref = refFromJobName(jobName)
  const held = workspaceEnv(ref.workspaceId)
  if (held !== undefined) return held
  const env = workspaceEnvironment({ ...ref, env: [], mounts: [] }, containerlessWorkspacePaths(jobName))
  Object.assign(env, workspaceLaunchEnv(ref.workspaceId))
  return env
}

/** The launch's own env entries minus credentials, for the marker
 *  (`WorkspaceMarker.launchEnv`). */
function persistableLaunchEnv(
  env: NodeJS.ProcessEnv,
  spec: Pick<WorkspaceSpec, 'env' | 'secretEnvKeys'>,
  added: Record<string, string>,
): Record<string, string> {
  const secret = new Set(spec.secretEnvKeys)
  const keys = [
    ...spec.env.map((e) => e.slice(0, Math.max(0, e.indexOf('=')))),
    ...Object.keys(added),
  ]
  const out: Record<string, string> = {}
  for (const key of keys) {
    const value = env[key]
    if (key !== '' && !secret.has(key) && value !== undefined) out[key] = value
  }
  return out
}

/**
 * Translate an env value naming a path inside a declared hostPath mount
 * (callers write container paths) to the mount's host source directory. The
 * string matters: claude names its macOS Keychain item after a hash of its
 * config dir, so it must be the project's dir on every workspace.
 *
 * The longest matching mount wins. Only declared mounts are translated, never
 * arbitrary container-looking paths, since a user's own env values may be
 * real host paths (a dev host's home can be `/home/yaac`).
 */
function remapMountedPath(value: string, mounts: WorkspaceMount[]): string {
  let best: { mountPath: string; source: string } | undefined
  for (const { mountPath, source } of mounts) {
    if (source.kind !== 'hostPath') continue
    if (value !== mountPath && !value.startsWith(`${mountPath}/`)) continue
    if (best === undefined || mountPath.length > best.mountPath.length) best = { mountPath, source: source.path }
  }
  return best === undefined ? value : path.join(best.source, value.slice(best.mountPath.length))
}

/** Where a pod's opencode mount lands in the wrapper's XDG dirs, or null
 *  for any other mount. */
function opencodeDestination(mountPath: string, home: string): string | null {
  for (const [prefix, dir] of [['/home/yaac/.config/', 'config'], ['/home/yaac/.local/share/', 'data']] as const) {
    if (mountPath.startsWith(prefix)) return path.join(home, dir, mountPath.slice(prefix.length))
  }
  return null
}

/**
 * Realize a declared mount, which nothing here can bind (that would need
 * root). Every mount a create declares already has a route: the checkout
 * and the `WorkspacePaths` dirs are in place, staged helper scripts go on
 * PATH, the tool homes and pnpm store are named by an env value the caller
 * set (`remapMountedPath`), and opencode's dirs become links in its
 * wrapper's XDG dirs. Anything else refuses the create, so a mount can
 * never quietly write into the user's own home.
 */
async function realizeMount(
  mount: WorkspaceMount,
  env: readonly string[],
  paths: WorkspacePaths,
  opencode: string,
): Promise<void> {
  const { mountPath, source } = mount
  if (source.kind === 'emptyDir') return
  if (mountPath === '/workspace' || mountPath === paths.workspaceDir || mountPath === source.path
    || source.path === paths.acpLogDir || source.path === paths.attachmentsDir
    || mountPath.startsWith('/usr/local/bin/')) return
  const link = opencodeDestination(mountPath, opencode)
  const named = env.some((entry) => {
    const value = entry.slice(entry.indexOf('=') + 1)
    return value === mountPath || value.startsWith(`${mountPath}/`)
  })
  if (link === null && !named) {
    throw new ServerError('VALIDATION', `containerless: no host equivalent for a mount at ${mountPath}`)
  }
  // So a first-run tool home is not a missing dir (or a dangling link).
  if (source.type === 'Directory' || source.type === 'DirectoryOrCreate' || !source.type) {
    await fs.mkdir(source.path, { recursive: true }).catch(() => { /* exists, or a file */ })
  }
  if (link === null) return
  await fs.mkdir(path.dirname(link), { recursive: true })
  // Replace whatever a previous launch left.
  await fs.rm(link, { recursive: true, force: true }).catch(() => { /* nothing there */ })
  await fs.symlink(source.path, link)
}

/**
 * The `opencode` the workspace finds first on PATH: the pinned binary on
 * this workspace's XDG dirs. opencode has no home variable, and setting the
 * XDG variables for the whole workspace would hide the user's own layout
 * from every other tool. State is per workspace because a plain `opencode`
 * joins a background service there, which keeps the environment of the
 * first client that started it.
 */
function opencodeWrapper(home: string): string {
  const pinned = AGENT_PACKAGES.opencode
  if (pinned === undefined) throw new Error('containerless: opencode has no pinned package')
  return [
    '#!/bin/sh',
    '# Written by yaac: the pinned opencode on this workspace\'s own dirs.',
    ...(['config', 'data', 'state', 'cache'] as const).map((dir) =>
      `export XDG_${dir.toUpperCase()}_HOME=${shellQuote(path.join(home, dir))}`),
    `exec ${shellQuote(path.join(agentPackagePrefix(pinned), 'bin', 'opencode'))} "$@"`,
    '',
  ].join('\n')
}

/**
 * The `YAAC_SHELL_ENV` file a shell sources after the user's rc files
 * (`host-shell/`, and bash's `BASH_ENV`): every entry the launch set, the
 * tool-home variables it cleared, and the PATH prefix, put back first
 * unless it already leads. It holds the launch's credentials, so it is
 * owner-only. `fish` selects fish syntax, for the file a fish pane sources
 * through `-C`.
 */
function shellEnvScript(env: NodeJS.ProcessEnv, keys: string[], prefix: string[], fish = false): string {
  const quote = fish ? (v: string): string => `'${v.replace(/[\\']/g, '\\$&')}'` : shellQuote
  const lead = prefix.join(path.delimiter)
  return [
    '# Written by yaac: re-applied after your shell rc (host-shell/).',
    ...[...new Set([...TOOL_HOME_VARS, ...keys])].map((key) => {
      const value = env[key]
      if (fish) return value === undefined ? `set -e ${key}` : `set -gx ${key} ${quote(value)}`
      return value === undefined ? `unset ${key}` : `export ${key}=${quote(value)}`
    }),
    ...(fish
      ? [`test "$PATH[1]" = ${quote(prefix[0] ?? '')}; or set -gx PATH ${prefix.map(quote).join(' ')} $PATH`]
      : [`case ":$PATH:" in ${quote(`:${lead}:`)}*) ;; *) PATH=${quote(lead)}:$PATH ;; esac`, 'export PATH']),
    '',
  ].join('\n')
}

/**
 * The workspace's shell: `$SHELL`, else zsh, bash, then `/bin/sh`. Always an
 * absolute path to an executable.
 */
async function resolveShell(): Promise<string> {
  // eslint-disable-next-line no-process-env -- the workspace's login shell is the host user's own preference, which only the environment states
  for (const candidate of [process.env.SHELL, 'zsh', 'bash']) {
    if (candidate === undefined) continue
    const found = path.isAbsolute(candidate)
      ? await fs.access(candidate, fs.constants.X_OK).then(() => candidate, () => null)
      : await findOnPath(candidate)
    if (found !== null) return found
  }
  return '/bin/sh'
}

/**
 * The shells a workspace runs: tmux's `default-shell`, which runs every
 * window command as `<shell> -c`, and how a pane's interactive shell starts
 * (`default-command`), with what they need in the environment to read
 * yaac's startup files around the user's own (`host-shell/`).
 *
 * zsh and bash run the launches too, as a pod's zsh does: `zsh -c` reads
 * the startup files through `ZDOTDIR`, and `bash -c` its `BASH_ENV`, both
 * re-applying yaac's settings after the user's rc. A pane's bash reads a
 * `--rcfile` that does a login shell's reads. fish has no hook after
 * `config.fish` but its `-C` flag, which a tmux command cannot pass, so its
 * launches, like any other shell's, run under /bin/sh, which reads no rc; a
 * fish pane re-applies through `-C`.
 *
 * Every zsh reads the startup files through `ZDOTDIR`, whatever the user's
 * shell, since an agent may start a zsh of its own. `ZDOTDIR` is a dir in
 * the state dir linking the shipped files, since zsh writes there while it
 * points at them (Debian's global `compinit` dump, macOS's history default).
 */
async function workspaceShells(
  shell: string,
  host: NodeJS.ProcessEnv,
  stateDir: string,
): Promise<{ defaultShell: string; command: string; env: Record<string, string> }> {
  const dir = hostShellDir()
  const zdotdir = path.join(stateDir, 'zsh')
  await fs.rm(zdotdir, { recursive: true, force: true })
  await fs.mkdir(zdotdir, { recursive: true })
  for (const name of await fs.readdir(path.join(dir, 'zsh'))) {
    await fs.symlink(path.join(dir, 'zsh', name), path.join(zdotdir, name))
  }
  // Started from inside another workspace, ZDOTDIR may name that
  // workspace's wrapper; the user's own dir is the one it recorded.
  // eslint-disable-next-line no-process-env -- set only by an outer workspace, and dropped from `host` with the other YAAC_ variables
  const outer = process.env.YAAC_USER_ZDOTDIR
  const env = { ZDOTDIR: zdotdir, YAAC_USER_ZDOTDIR: outer ?? host.ZDOTDIR ?? host.HOME ?? '' }
  const login = `exec ${shellQuote(shell)} -l`
  switch (path.basename(shell)) {
    case 'zsh':
      return { defaultShell: shell, command: login, env }
    case 'bash':
      return {
        defaultShell: shell,
        command: `exec ${shellQuote(shell)} --rcfile ${shellQuote(path.join(dir, 'bash', 'rc'))}`,
        env,
      }
    case 'fish':
      return {
        defaultShell: '/bin/sh',
        command: `${login} -C ${shellQuote(`source ${shellQuote(fishEnvFile(stateDir))}`)}`,
        env: { ...env, XDG_DATA_DIRS: [dir, host.XDG_DATA_DIRS || '/usr/local/share:/usr/share'].join(path.delimiter) },
      }
    default:
      return { defaultShell: '/bin/sh', command: login, env }
  }
}

/** The fish-syntax `YAAC_SHELL_ENV` a fish pane sources. */
function fishEnvFile(stateDir: string): string {
  return path.join(stateDir, 'shell-env.fish')
}

/** See `WorkspaceDriver.launch`. */
export async function launchWorkspace(spec: WorkspaceSpec): Promise<RuntimeHandle> {
  const jobName = containerlessJobName(spec.projectId, spec.workspaceId)
  const paths = containerlessWorkspacePaths(jobName)
  const stateDir = containerlessStateDir(spec.projectId, spec.workspaceId)
  const opencode = opencodeHome(stateDir)
  const files = stateEnv(spec.projectId, spec.workspaceId, paths)

  // Before creating anything; both failures are otherwise obscure.
  assertSocketPathsFit(paths)
  assertShellSafePaths(paths)

  spec.onProgress?.('Preparing the workspace environment...')
  // The private HOME an older yaac gave this workspace, with its
  // credential store (docs/legacy-compat-shims.md).
  await fs.rm(path.join(stateDir, 'home'), { recursive: true, force: true })
  await fs.mkdir(paths.scratchDir, { recursive: true })
  await fs.mkdir(paths.acpLogDir, { recursive: true })
  await fs.mkdir(paths.acpSockDir, { recursive: true })
  // 0700: a tmux socket gives full control of its workspace.
  await fs.mkdir(tmuxSockDir(), { recursive: true, mode: 0o700 })
  for (const dir of ['state', 'cache']) await fs.mkdir(path.join(opencode, dir), { recursive: true })
  for (const mount of spec.mounts) await realizeMount(mount, spec.env, paths, opencode)
  await fs.mkdir(ownBinDir(stateDir), { recursive: true })
  await fs.writeFile(path.join(ownBinDir(stateDir), 'opencode'), opencodeWrapper(opencode), { mode: 0o755 })

  const env = workspaceEnvironment(spec, paths)
  // Tell the user which host tool-home variables were dropped or replaced
  // (unless the project env set them to the same value), since ignoring
  // them is otherwise silent.
  const host = userEnvironment()
  const overridden = overriddenToolHomeVars().filter((key) => env[key] !== host[key])
  if (overridden.length > 0) {
    const message = `Ignoring ${overridden.join(', ')} from this host's environment `
      + '— a workspace uses this project\'s tool config instead.'
    spec.onProgress?.(message)
    serverLog(`[server] containerless ${spec.workspaceId}: ${message}`)
  }

  // Git identity, trust and auth, as the pod's init script writes them
  // (auth only here; see `git-auth`).
  const priorAgentPid = sshAgentPidOf(spec.workspaceId)
  const gitAuth = await realizeGitAuth({
    dir: stateDir,
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
  // Owner-only, since a hosted remote's token is in it.
  await fs.writeFile(files.GIT_CONFIG_GLOBAL, gitconfig, { mode: 0o600 })
  await fs.chmod(files.GIT_CONFIG_GLOBAL, 0o600)
  // After the caller's entries, so none can disable ssh host verification.
  Object.assign(env, gitAuth.env)

  // The user's rc runs in their shells, so what yaac sets is put back
  // after it (`workspaceShells`).
  const shell = await resolveShell()
  const startup = await workspaceShells(shell, host, stateDir)
  const added = { ...gitAuth.env, ...startup.env, SHELL: shell }
  Object.assign(env, added)
  const launchKeys = [
    ...spec.env.map((e) => e.slice(0, Math.max(0, e.indexOf('=')))).filter(Boolean),
    ...Object.keys(files),
    ...Object.keys(added),
  ]
  for (const [file, fish] of [[files.YAAC_SHELL_ENV, false], [fishEnvFile(stateDir), true]] as const) {
    await fs.writeFile(file, shellEnvScript(env, launchKeys, pathPrefix(spec), fish), { mode: 0o600 })
    await fs.chmod(file, 0o600)
  }

  spec.onProgress?.('Starting the workspace session...')
  // One tmux call, since each costs a process start. It opens on the keeper
  // window, as the pod's init script does (`KEEPER_STARTING`); sessions get
  // windows of their own after setup. macOS's sleep has no `infinity`. A
  // large -x/-y lets tmux shrink to the client on attach, which TUIs handle
  // better than growing.
  //
  // `update-environment` is emptied before any client attaches; otherwise
  // the liveness watch (attaching with the server's env) would give the
  // panes the host's SSH_AUTH_SOCK. `history-limit` and the shells are set
  // before the session, since tmux fixes a pane's limit and shell when it is
  // created.
  //
  // `-f /dev/null`, as in a pod: the user's `~/.tmux.conf` could set hooks,
  // rename windows or end the session. Then the same UX options as the
  // pod's init script. tmux stops a command list at its first error, so
  // these take `-q`: an option an older tmux lacks is skipped rather than
  // failing the create.
  // Last, the server's pid, the root of the port scan's process tree.
  const { stdout } = await runHost([
    'tmux', '-S', paths.tmuxSock, '-f', '/dev/null', '-u',
    'start-server', ';',
    'set-option', '-g', 'history-limit', '200000', ';',
    'set-option', '-g', 'default-shell', startup.defaultShell, ';',
    'set-option', '-g', 'default-command', startup.command, ';',
    'new-session', '-d', '-s', 'yaac', '-n', KEEPER_STARTING,
    '-x', '500', '-y', '200', '-c', paths.workspaceDir,
    'sleep 2147483647', ';',
    'set-option', '-g', 'update-environment', '', ';',
    'set-option', '-sq', 'escape-time', '10', ';',
    'set-option', '-gq', 'mouse', 'on', ';',
    'set-option', '-gq', 'focus-events', 'on', ';',
    'set-option', '-gq', 'monitor-bell', 'on', ';',
    'set-option', '-gq', 'bell-action', 'any', ';',
    'set-option', '-gq', 'visual-bell', 'off', ';',
    'set-option', '-gq', 'allow-passthrough', 'on', ';',
    'set-option', '-gq', 'extended-keys', 'on', ';',
    'set-option', '-gq', 'default-terminal', 'tmux-256color', ';',
    'set-option', '-gqa', 'terminal-features', ',*:RGB', ';',
    'set-option', '-q', '-t', 'yaac', 'status-right-length', '80', ';',
    'set-option', '-q', '-t', 'yaac', 'status-right', env.YAAC_STATUS_RIGHT ?? '', ';',
    'bind-key', 'k', 'confirm-before', '-p', 'kill this yaac session? (y/n)', 'kill-server', ';',
    'display-message', '-p', '#{pid}',
  ], { cwd: paths.workspaceDir, env, timeoutMs: 30_000 }).catch(async (err: unknown) => {
    // The session may be up even though the call failed, and with no marker
    // yet nothing would find it or the ssh-agent to tear them down.
    await runHost(['tmux', '-S', paths.tmuxSock, 'kill-server'], { timeoutMs: 5_000 }).catch(() => {})
    if (gitAuth.agentPid !== undefined) killPids([gitAuth.agentPid], 'SIGTERM')
    throw err
  })
  const tmuxPid = Number(stdout.trim())

  const marker: WorkspaceMarker = {
    projectId: spec.projectId,
    workspaceId: spec.workspaceId,
    createdAtMs: Date.now(),
    ...(Number.isInteger(tmuxPid) && tmuxPid > 0 ? { tmuxPid } : {}),
    // So teardown can kill the ssh-agent.
    ...(gitAuth.agentPid !== undefined ? { sshAgentPid: gitAuth.agentPid } : {}),
    launchEnv: persistableLaunchEnv(env, spec, added),
  }
  const ports = allocatedPorts(spec.workspaceId)
  if (ports.length > 0) marker.ports = ports
  await writeMarker(marker)
  return rememberWorkspace(marker, env)
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
