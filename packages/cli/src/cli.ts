import { Command, Argument, Option, type Help } from 'commander'
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the repo-root package.json is the published @bsklaroff/yaac manifest and the single source of truth for the CLI version (inlined by tsup at build time).
import pkg from '../../../package.json' with { type: 'json' }
import { exitOnApiError } from '@yaac/shared/server-api'
import { AGENT_MODES, PERMISSION_MODES } from '@yaac/shared/types'
import { projectAdd } from '#commands/project-add'
import { projectList } from '#commands/project-list'
import { groupCreate, groupDelete, groupList, groupMove } from '#commands/group'
import { worktreeCreate } from '#commands/worktree-create'
import { worktreeList } from '#commands/worktree-list'
import { worktreeRename } from '#commands/worktree-rename'
import { worktreeStop } from '#commands/worktree-stop'
import { worktreeRestart } from '#commands/worktree-restart'
import { worktreeAttach } from '#commands/worktree-attach'
import { worktreeShell } from '#commands/worktree-shell'
import { worktreeMonitor } from '#commands/worktree-monitor'
import { worktreeAgents } from '#commands/worktree-agents'
import { authUpdate } from '#commands/auth-update'
import { authClear } from '#commands/auth-clear'
import { authList } from '#commands/auth-list'
import { toolGet } from '#commands/tool-get'
import { toolSet } from '#commands/tool-set'
/* eslint-disable no-restricted-syntax -- Every `import()` below is a deliberate
   deferral, not a hoisting oversight: the repo bans dynamic import to keep
   import graphs static and readable, but this file is the one place where the
   graph IS the cost. See the note below for what each deferral buys. */

// `#commands/cluster-*`, `@yaac/server/main/*` and the k8s substrate are
// deliberately absent from this import list: they are loaded inside the
// actions that need them. Reaching any of them pulls
// `@kubernetes/client-node` — 967 ESM files behind one barrel, ~2.2s to
// evaluate — and the CLI is an HTTP client that needs none of it to parse
// `--version`, reject a bad flag, or run any of the commands that just talk
// to a running server. Every static import here is on the critical path of
// *every* invocation, so keep the expensive ones dynamic.
import { configEditProject, configEditDockerfile, configEditUserDockerfile } from '#commands/config-edit'
import { authFake } from '#commands/auth-fake'
import { authTokenCreate, authTokenList, authTokenRevoke } from '#commands/auth-token'
import { remoteSet, remoteUnset, remoteOn, remoteOff, remoteStatus } from '#commands/remote'
import { runAuthDaemon, startAuthDaemon, stopAuthDaemon, statusAuthDaemon } from '@yaac/auth-daemon/run'
import { DEFAULT_SERVER_PORT } from '@yaac/shared/server-port'
import { env } from '@yaac/shared/env'
import { ensureRootfulPodmanHost } from '@yaac/server/drivers/k8s/container/runtime'
import { FAKE_AUTH_KINDS, type FakeAuthKind } from '@yaac/shared/types'
import { clusterArgError, type ClusterInstallArgs } from '@yaac/server/drivers/k8s/cluster/arg-guards'
import type { WorktreeMonitorOptions } from '#commands/worktree-monitor'

/**
 * Reject a `cluster install`/`delete` invocation the flags and environment
 * already condemn, printing the same message the command itself would.
 * Returns true when it did, and the action must return without loading the
 * command.
 *
 * This exists purely so a rejection stays cheap. The guards are the
 * command's own (arg-guards.ts, which imports nothing but `env`), and the
 * command re-runs them — but reaching the command means evaluating
 * `@kubernetes/client-node` and the cluster feature graph, ~3s to tell
 * someone they typed `--nodes three`.
 */
function rejectClusterArgs(command: 'install' | 'delete', options: ClusterInstallArgs = {}): boolean {
  const message = clusterArgError(command, options)
  if (message === null) return false
  console.error(`\n${message}`)
  process.exitCode = 1
  return true
}

const DRIVER_FLAG_HELP =
  'Which substrate to run worktrees on: "k8s" (default; one pod per worktree '
  + 'in a local cluster) or "containerless" (a tmux session per worktree on '
  + 'this host — no image, no proxy, and no sandbox around the agent)'

/**
 * Publish `--driver` as `YAAC_DRIVER` so the one reader of it — the server's
 * composition root — sees it, including in the detached child `server start`
 * spawns (which inherits this process's environment).
 */
function applyDriverFlag(driver: string | undefined): void {
  if (driver === undefined) return
  if (driver !== 'k8s' && driver !== 'containerless') {
    console.error(`\n--driver must be "k8s" or "containerless" (got "${driver}")`)
    process.exit(1)
  }
  // eslint-disable-next-line no-process-env -- publishing the flag for the server child to read back through env.driver is the whole point of the flag
  process.env.YAAC_DRIVER = driver
}

/**
 * Which substrate the RUNNING server uses, or undefined when none answers.
 *
 * Asked rather than assumed, because the CLI's own environment is not the
 * authority: a server started elsewhere with `--driver containerless` leaves
 * no trace in this shell, and a stray `YAAC_DRIVER` in this shell says
 * nothing about a server that is genuinely running k8s. `/health` is
 * auth-exempt, so this needs no credential; a server that does not answer
 * (none running, or one predating the field) falls back to the environment,
 * which is also the only answer available to `cluster install` — which
 * legitimately runs before any server exists.
 */
async function runningServerDriver(): Promise<string | undefined> {
  try {
    const { readLock } = await import('@yaac/shared/lock')
    const lock = await readLock()
    if (!lock) return undefined
    const res = await fetch(`http://127.0.0.1:${String(lock.port)}/health`, {
      signal: AbortSignal.timeout(2_000),
    })
    if (!res.ok) return undefined
    const body = await res.json() as { driver?: string | null }
    return body.driver ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Refuse a `yaac cluster …` command on an install that runs no cluster.
 * Returns true when it did, and the action must return without loading the
 * command — which also keeps the k8s cluster graph (and the kubernetes
 * client with it) out of a containerless install's CLI entirely.
 */
async function rejectClusterOnContainerless(): Promise<boolean> {
  // The running server first, then this shell's explicit choice, then what
  // the install last ran. Only the last of those is available to `cluster
  // setup`, which legitimately runs before any server exists.
  const { recordedDriver } = await import('@yaac/server/main/driver-choice')
  const running = await runningServerDriver()
  const kind = running ?? env.driverExplicit ?? await recordedDriver()
  if (kind !== 'containerless') return false
  const where = running !== undefined
    ? 'The running server uses the containerless driver'
    : 'This install runs the containerless driver'
  console.error(
    `\n${where}: worktrees run on this host and there is no cluster to manage.`
    + '\n    Run `yaac host check` to verify this machine instead.',
  )
  process.exitCode = 1
  return true
}

// On Linux, yaac drives the rootful podman engine (CONTAINER_HOST). Set it once
// here so every command — `cluster install` (kind inherits our env) and the
// image build/push paths — targets the same engine. No-op on macOS and nested,
// and skipped entirely on a containerless install, which has no engine to
// point at and no images to build.
if (env.driver === 'k8s') ensureRootfulPodmanHost()

/**
 * Show subcommand options nested under each subcommand in help output.
 */
function nestedHelp(cmd: Command, helper: Help): string {
  const termWidth = helper.padWidth(cmd, helper)
  const output: string[] = []

  output.push(`Usage: ${helper.commandUsage(cmd)}`, '')

  const desc = helper.commandDescription(cmd)
  if (desc) output.push(desc, '')

  const opts = helper.visibleOptions(cmd)
  if (opts.length) {
    output.push('Options:')
    for (const opt of opts)
      output.push(helper.formatItem(helper.optionTerm(opt), termWidth, helper.optionDescription(opt), helper))
    output.push('')
  }

  const cmds = helper.visibleCommands(cmd)
  if (cmds.length) {
    output.push('Commands:')
    for (const sub of cmds) {
      output.push(helper.formatItem(helper.subcommandTerm(sub), termWidth, helper.subcommandDescription(sub), helper))
      for (const opt of sub.options.filter((o) => !o.hidden))
        output.push(helper.formatItem('  ' + helper.optionTerm(opt), termWidth, helper.optionDescription(opt), helper))
    }
    output.push('')
  }

  return output.join('\n')
}

const program = new Command()
  .name('yaac')
  .description('Agent sandbox manager')
  .version(pkg.version)

const server = program
  .command('server')
  .description('Manage the yaac server (HTTP server the CLI talks to)')
  .configureHelp({ formatHelp: nestedHelp })

server
  .command('run')
  .description('Run the server in the foreground (used internally by `start`)')
  .option('-p, --port <port>', `Preferred port on 127.0.0.1 (default: ${DEFAULT_SERVER_PORT}; increments if in use)`, (v) => Number.parseInt(v, 10))
  .option('--driver <kind>', DRIVER_FLAG_HELP)
  .action(async (options: { port?: number; driver?: string }) => {
    applyDriverFlag(options.driver)
    const { runServer } = await import('@yaac/server/main/server-run')
    await runServer({ port: options.port })
  })

server
  .command('start')
  .description('Start the server in the background')
  .option('--driver <kind>', DRIVER_FLAG_HELP)
  .action(async (options: { driver?: string }) => {
    applyDriverFlag(options.driver)
    const { startServer } = await import('@yaac/server/main/lifecycle')
    await startServer()
  })

server
  .command('stop')
  .description('Stop the running server')
  .action(async () => {
    const { stopServer } = await import('@yaac/server/main/lifecycle')
    await stopServer()
  })

server
  .command('restart')
  .description('Restart the server (stop, then start)')
  // Restart is when a substrate is switched, so the flag belongs here too.
  // Omitted, it keeps whatever this install was already running — which is
  // the whole point of recording the choice.
  .option('--driver <kind>', DRIVER_FLAG_HELP)
  .action(async (options: { driver?: string }) => {
    applyDriverFlag(options.driver)
    const { restartServer } = await import('@yaac/server/main/lifecycle')
    await restartServer()
  })

server
  .command('logs')
  .description('Print the server log (~/.yaac/server.log)')
  .option('-f, --follow', 'Keep printing new lines as they are appended')
  .option('-n, --lines <n>', 'Print only the last N lines', (v) => Number.parseInt(v, 10))
  .action(async (options: { follow?: boolean; lines?: number }) => {
    const { serverLogs } = await import('@yaac/server/main/lifecycle')
    await serverLogs(options)
  })

program
  .command('open')
  .description('Open the webapp in your browser (starts the server if needed)')
  .option('--no-browser', 'Print the authenticated URL instead of launching a browser')
  .action(async (options: { browser?: boolean }) => {
    const { openWebapp } = await import('@yaac/server/main/webapp')
    await openWebapp({ noBrowser: options.browser === false })
  })

const cluster = program
  .command('cluster')
  .description('Manage the kubernetes cluster yaac runs worktrees on')
  .configureHelp({ formatHelp: nestedHelp })

cluster
  .command('check')
  .description('Verify cluster prerequisites (kubectl, registry, hostPath wiring)')
  .action(async () => {
    if (await rejectClusterOnContainerless()) return
    const { clusterCheck } = await import('#commands/cluster-check')
    await clusterCheck()
  })

cluster
  .command('install')
  .description('Converge this machine and its cluster to the installed yaac version: the kind cluster and CNI if there is none, the node fixups, every built-in image, and the in-cluster layers. Safe to re-run; never destructive.')
  .option('--nodes <count>', 'Number of kind nodes to create (default 1; worktrees run on the workers, so 3 is the smallest real multi-node rehearsal). Ignored when the cluster already exists')
  .option('--adopt-cni', 'Install into the cluster your kubeconfig points at, adopting the Calico it already runs instead of creating a cluster (verifies the dataplane and refuses what would fail silently)')
  .action(async (options: { nodes?: string; adoptCni?: boolean }) => {
    if (await rejectClusterOnContainerless()) return
    if (rejectClusterArgs('install', options)) return
    const { clusterInstall } = await import('#commands/cluster-install')
    await clusterInstall(options)
  })

cluster
  .command('delete')
  .description(
    'Delete the kind cluster, including the in-cluster registry and its '
    + 'images (keeps worktrees and their checkouts)',
  )
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(async (options: { yes?: boolean }) => {
    if (await rejectClusterOnContainerless()) return
    if (rejectClusterArgs('delete')) return
    const { clusterDelete } = await import('#commands/cluster-delete')
    await clusterDelete(options)
  })

const host = program
  .command('host')
  .description('Inspect the host yaac runs containerless worktrees on')
  .configureHelp({ formatHelp: nestedHelp })

host
  .command('check')
  .description('Verify this machine can run containerless worktrees (tmux, git, agent CLIs)')
  .action(async () => {
    const { hostCheck } = await import('#commands/host-check')
    await hostCheck()
  })

const project = program
  .command('project')
  .description('Manage projects')
  .configureHelp({ formatHelp: nestedHelp })

project
  .command('list')
  .description('List all projects')
  .action(projectList)

project
  .command('add')
  .description('Add a project from a git remote')
  .argument('<remote-url>', 'Git remote URL')
  .action(projectAdd)

const group = program
  .command('group')
  .description('Manage the named groups a project\'s worktrees are filed under in the sidebar')
  .configureHelp({ formatHelp: nestedHelp })

group
  .command('create')
  .description('Create an empty group (pinned, so it stays listed until it has worktrees)')
  .argument('<project>', 'Project slug')
  .argument('<name>', 'Group name')
  .action(groupCreate)

group
  .command('list')
  .description('List worktree groups and how many running worktrees each holds')
  .argument('[project]', 'Filter by project slug')
  .action(groupList)

group
  .command('move')
  .description('File a worktree under a group, creating the group if needed')
  .argument('<worktree-id>', 'Worktree ID (or its unique prefix)')
  // Optional rather than a `--none` sentinel: commander eats a bare `--` as
  // its end-of-options marker, so it could never reach the handler.
  .argument('[group]', 'Group name; omit it to return the worktree to the default list')
  .option('--project <slug>', 'Project the worktree belongs to (required for a stopped worktree)')
  .action(groupMove)

group
  .command('delete')
  .description('Delete a group; its worktrees return to the default list (nothing is stopped)')
  .argument('<project>', 'Project slug')
  .argument('<group>', 'Group name')
  .action(groupDelete)

const worktree = program
  .command('worktree')
  .description('Manage worktrees — a git worktree plus the container and agents running in it')
  .configureHelp({ formatHelp: nestedHelp })

worktree
  .command('create')
  .description('Create a new worktree for a project')
  .argument('<project>', 'Project slug')
  .option('-t, --tool <tool>', 'Agent tool to use (claude, codex, opencode, or pi)')
  .option('-b, --branch <branch>', 'Reference branch for the worktree (defaults to the project\'s referenceBranch config, else the remote default branch)')
  .option('-p, --prompt <text>', 'Initial prompt typed into the agent once the worktree is up')
  .option('-m, --model <model>', 'Model for the agent: an id or alias for claude/codex (e.g. opus), provider/model for opencode and pi')
  .addOption(new Option('--mode <mode>', 'How the agent is driven: tui runs its terminal UI, acp drives it over the Agent Client Protocol and renders a chat pane in the web app (claude only)').choices([...AGENT_MODES]))
  .addOption(new Option('--permission-mode <mode>', 'How much the agent may do before it asks: bypass acts freely, auto lets a reviewer model judge each action, accept-edits edits without asking but asks for the rest, plan explores read-only, manual asks for everything. Defaults to this project\'s last choice, else bypass in a container and accept-edits on the host. Not every tool has every mode (pi has only bypass)').choices([...PERMISSION_MODES]))
  .option('-g, --group <group>', 'File the worktree under this sidebar group (by name; created if it does not exist)')
  .option('--install-missing', 'Install the agent\'s CLI if the server\'s host hasn\'t got it, instead of refusing the create (containerless servers only; a server that runs agents in containers gets its tools from the image)')
  .action(async (project: string, options: Parameters<typeof worktreeCreate>[1]) => {
    await worktreeCreate(project, options)
  })

worktree
  .command('list')
  .description('List running worktrees')
  .argument('[project]', 'Filter by project slug')
  .option('-s, --stopped', 'List stopped worktrees (their checkouts are kept, and they can be restarted)')
  .option('-n, --num <n>', 'With -s, cap stopped results to N rows (default 25)', (v) => Number.parseInt(v, 10))
  .option('-a, --all', 'With -s, show all stopped rows without a cap')
  .action(worktreeList)

worktree
  .command('rename')
  .description('Set a worktree\'s title — the label the sidebar shows in place of its id')
  .argument('<worktree-id>', 'Worktree ID, container name, or container ID')
  .argument('<title>', 'New title (quote it if it has spaces)')
  .action(worktreeRename)

worktree
  .command('stop')
  .description('Stop a worktree: tear down its container, keep its checkout and diff')
  .argument('<worktree-id>', 'Worktree ID, container name, or container ID')
  .action(worktreeStop)

worktree
  .command('restart')
  .description('Restart a worktree: kill its container, reuse its checkout, resume the agents that were running')
  .argument('<worktree-id>', 'Worktree ID, container name, or container ID')
  .action(async (worktreeId: string) => {
    await worktreeRestart(worktreeId)
  })

worktree
  .command('agents')
  .description('List the agent sessions a worktree holds (open ones first)')
  .argument('<worktree-id>', 'Worktree ID, container name, or container ID')
  .action(worktreeAgents)

worktree
  .command('attach')
  .description('Attach to the worktree\'s tmux session')
  .argument('<container-id>', 'Worktree ID or container name')
  .addHelpText('after', '\nTmux shortcuts:\n  Ctrl-B C  Open a new shell\n  Ctrl-B N  Switch to the next window\n  Ctrl-B P  Switch to the previous window')
  .action(worktreeAttach)

worktree
  .command('shell')
  .description('Open an interactive zsh shell in the worktree container')
  .argument('<container-id>', 'Worktree ID or container name')
  .action(worktreeShell)

worktree
  .command('monitor')
  .description('Poll and display running worktrees in real-time')
  .argument('[project]', 'Filter by project slug')
  .option('-n, --interval <seconds>', 'Refresh interval in seconds', '5')
  .action(async (project: string | undefined, options: WorktreeMonitorOptions) => {
    await worktreeMonitor(project, options)
  })

const tool = program
  .command('tool')
  .description('Manage default agent tool')
  .configureHelp({ formatHelp: nestedHelp })

tool
  .command('get')
  .description('Show the current default agent tool')
  .action(toolGet)

tool
  .command('set')
  .description('Set the default agent tool')
  .argument('<tool>', 'Agent tool to use (claude, codex, opencode, or pi)')
  .action(toolSet)

const config = program
  .command('config')
  .description('Edit per-machine project configuration files')
  .configureHelp({ formatHelp: nestedHelp })

config
  .command('edit')
  .description("Open the project's yaac-config.json in $EDITOR")
  .argument('<project>', 'Project slug')
  .action(configEditProject)

config
  .command('edit-dockerfile')
  .description("Open the project's Dockerfile.yaac in $EDITOR")
  .argument('<project>', 'Project slug')
  .action(configEditDockerfile)

config
  .command('edit-user-dockerfile')
  .description('Open the global ~/.yaac/Dockerfile.user in $EDITOR')
  .action(configEditUserDockerfile)

const remote = program
  .command('remote')
  .description('Point this CLI at a remote yaac server')
  .configureHelp({ formatHelp: nestedHelp })

remote
  .command('set')
  .description('Configure and enable the remote server (verifies reachability and the token)')
  .argument('<url>', 'Server origin, e.g. https://srv.tailnet.ts.net')
  .requiredOption('--token <token>', 'Durable token minted on the server (yaac auth token create)')
  .action(remoteSet)

remote
  .command('unset')
  .description('Forget the remote (commands target the local server again)')
  .action(remoteUnset)

remote
  .command('on')
  .description('Re-enable the configured remote')
  .action(remoteOn)

remote
  .command('off')
  .description('Disable the remote without forgetting it')
  .action(remoteOff)

remote
  .command('status')
  .description('Show the configured remote (masked token) and whether it is enabled')
  .action(remoteStatus)

const auth = program
  .command('auth')
  .description('Manage credentials (GitHub tokens and tool API keys)')
  .configureHelp({ formatHelp: nestedHelp })

auth
  .command('list')
  .description('List configured credentials (masked)')
  .action(authList)

auth
  .command('update')
  .description('Add or update credentials (GitHub, Claude Code, Codex, OpenCode, or Pi)')
  .action(authUpdate)

auth
  .command('clear')
  .description('Remove stored credentials (interactive)')
  .action(authClear)

auth
  .command('fake')
  .description('Seed fake credentials so worktrees authenticate via a parent proxy (local/dev + yaac-in-yaac)')
  .addArgument(
    new Argument(
      '<kinds...>',
      'Credential kinds to seed (claude-oauth, opencode-openrouter, pi-openrouter, github); pass one or more',
    ).choices([...FAKE_AUTH_KINDS]),
  )
  .action(async (kinds: FakeAuthKind[]) => {
    await authFake(kinds)
  })

const authDaemon = auth
  .command('server')
  .description('Run the login broker that executes Claude/Codex sign-ins on this machine')
  .configureHelp({ formatHelp: nestedHelp })

authDaemon
  .command('run')
  .description('Run the auth server in the foreground')
  .action(runAuthDaemon)

authDaemon
  .command('start')
  .description('Start the auth server in the background')
  .action(startAuthDaemon)

authDaemon
  .command('stop')
  .description('Stop the background auth server')
  .action(stopAuthDaemon)

authDaemon
  .command('status')
  .description('Show whether the auth server is running and connected')
  .action(statusAuthDaemon)

const authToken = auth
  .command('token')
  .description('Manage durable access tokens for remote clients')
  .configureHelp({ formatHelp: nestedHelp })

authToken
  .command('create')
  .description('Mint a token (printed once) for a remote client to authenticate with')
  .argument('<name>', 'Device name for the token (e.g. laptop)')
  .action(authTokenCreate)

authToken
  .command('list')
  .description('List tokens (masked)')
  .action(authTokenList)

authToken
  .command('revoke')
  .description('Revoke a token by name')
  .argument('<name>', 'Device name of the token to revoke')
  .action(authTokenRevoke)

program.parseAsync().catch(exitOnApiError)
