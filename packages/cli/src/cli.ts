import { Command, Argument, Option, type Help } from 'commander'
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the repo-root package.json is the published @bsklaroff/yaac manifest and the single source of truth for the CLI version (inlined by tsup at build time).
import pkg from '../../../package.json' with { type: 'json' }
import { exitOnApiError } from '@yaac/shared/server-api'
import { AGENT_MODES, PERMISSION_MODES } from '@yaac/shared/types'
import type { ServerAccessOptions } from '@yaac/server/main/lifecycle'
import { projectAdd } from '#commands/project-add'
import { projectList } from '#commands/project-list'
import { groupCreate, groupDelete, groupList, groupMove } from '#commands/group'
import { workspaceCreate } from '#commands/workspace-create'
import { workspaceList } from '#commands/workspace-list'
import { workspaceRename } from '#commands/workspace-rename'
import { workspaceStop } from '#commands/workspace-stop'
import { workspaceRestart } from '#commands/workspace-restart'
import { workspaceAttach } from '#commands/workspace-attach'
import { workspaceMonitor } from '#commands/workspace-monitor'
import { forward } from '#commands/forward'
import { workspaceAgents } from '#commands/workspace-agents'
import { authUpdate } from '#commands/auth-update'
import { authClear } from '#commands/auth-clear'
import { authList } from '#commands/auth-list'
/* eslint-disable no-restricted-syntax -- The repo bans dynamic import, but
   here every `import()` defers a costly module graph. See the note below. */

// `#commands/cluster-*`, `@yaac/server/main/*` and the k8s substrate are
// imported inside the actions that need them. Each pulls in
// `@kubernetes/client-node` (about 2s to load), which most commands never
// use. Every static import here slows down every invocation.
import { configEditProject, configEditDockerfile, configEditUserDockerfile } from '#commands/config-edit'
import { configGitIdentity } from '#commands/config-git-identity'
import { authFake } from '#commands/auth-fake'
import { remoteSet, remoteUnset, remoteOn, remoteOff, remoteStatus } from '#commands/remote'
import { DEFAULT_SERVER_PORT } from '@yaac/shared/server-port'
import { env } from '@yaac/shared/env'
import { ensureRootfulPodmanHost } from '@yaac/server/drivers/k8s/container/runtime'
import { FAKE_AUTH_KINDS } from '@yaac/shared/types'
import { clusterArgError, type ClusterInstallArgs } from '@yaac/server/drivers/k8s/install'
import { clusterDataDir, readInstallRecord, recordedDriver } from '@yaac/shared/install-record'
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- names the data dir in refusals; builds no path
import { clientDataDir, getDataDir, useInstallDataDir } from '@yaac/shared/paths'
import { registerServer } from '@yaac/shared/server-config'
import type { LocalServerStatus } from '@yaac/shared/types'

/**
 * Throw a `cluster install` invocation's flag error, if it has one. Runs
 * the guards (arg-guards.ts) early so a typo doesn't cost loading the
 * kubernetes client first.
 */
function assertClusterInstallArgs(options: ClusterInstallArgs): void {
  const message = clusterArgError(options)
  if (message !== null) throw new Error(message)
}

/**
 * Which substrate this machine's running server uses, from its auth-exempt
 * `/health`, or undefined when none answers. A `YAAC_DRIVER` in this shell
 * says nothing about the running server. The origin comes from `server.json`
 * like every other command, not from the lock's port, which for an
 * in-cluster server is the port inside its pod. A selected server at a
 * non-loopback origin is another machine's, so it is not asked.
 */
async function runningServerDriver(): Promise<string | undefined> {
  try {
    const { resolveServerTarget, isLoopbackOrigin } = await import('@yaac/shared/server-api')
    const target = await resolveServerTarget()
    if (!isLoopbackOrigin(target.baseUrl)) return undefined
    const res = await fetch(`${target.baseUrl}/api/health`, {
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
 * Refuse a host `yaac server <verb>` on a data dir that is a cluster
 * install: its server is a Deployment, which `yaac cluster <verb>` manages.
 */
async function refuseHostVerbOnCluster(verb: string): Promise<void> {
  if (await recordedDriver() !== 'k8s') return
  throw new Error(
    `The data dir ${getDataDir()} is a cluster install, whose server runs in the cluster: `
    + `use \`yaac cluster ${verb}\`.`,
  )
}

/**
 * Run `yaac cluster start|stop|restart|logs` against this install's server
 * Deployment (docs/server-in-cluster.md). A kind install's log is a file in
 * its data dir; a byo install's is on a volume this machine cannot see, so
 * it is read through the cluster. A start selects the server, as a host
 * `yaac server start` does; a restart leaves a selection of another server
 * alone.
 */
async function runClusterServerVerb(
  verb: 'start' | 'stop' | 'restart' | 'logs',
  opts: { follow?: boolean; lines?: number } = {},
): Promise<void> {
  const record = await readInstallRecord()
  if (record?.driver !== 'k8s') {
    throw new Error(`There is no cluster install at ${getDataDir()}. Create one with \`yaac cluster install\`.`)
  }
  if (verb === 'logs' && !record.byo) {
    const { serverLogs } = await import('@yaac/server/main/lifecycle')
    await serverLogs(opts)
    return
  }
  const install = await import('@yaac/server/drivers/k8s/install')
  // Checked first, or another cluster would answer "no Deployment".
  const refusal = await install.foreignClusterRefusal()
  if (refusal) throw new Error(refusal)
  if (!await install.serverDeploymentExists()) {
    throw new Error('This install has no server Deployment yet. Deploy it with `yaac cluster install`.')
  }
  if (verb === 'logs') {
    await install.clusterServerLogs(opts)
    return
  }
  if (verb === 'stop') {
    await install.stopClusterServer()
    console.error('[yaac] server stopped (Deployment scaled to 0)')
    return
  }
  const origin = verb === 'start'
    ? await install.startClusterServer()
    : await install.restartClusterServer()
  await registerServer(origin, 'k8s', { keepSelection: verb === 'restart' })
  console.error(`[yaac] server ${verb === 'start' ? 'started' : 'restarted'} at ${origin}`)
}

/** `yaac server status` and `yaac cluster status`, as text or JSON. */
function printServerStatus(status: LocalServerStatus, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(status))
  } else if (status.running === null) {
    console.log('unknown: a --byo install keeps its server lock on the cluster')
  } else if (!status.running) {
    console.log('not running')
  } else if (status.serverBuildId === status.cliBuildId) {
    console.log('running')
  } else {
    const update = status.driver === 'k8s' ? 'yaac cluster install' : 'yaac server restart'
    console.log(`running a different build than this CLI; update it with: ${update}`)
  }
}

/**
 * Refuse a `yaac cluster …` command on a containerless install. The recorded
 * driver decides: it is this install's, whatever server is selected, and a
 * loopback origin can still be a tunnel to another machine. Only with
 * nothing recorded on a data dir clients share (a bare `yaac server run`
 * registers nothing) is a local running server asked.
 */
async function refuseClusterOnContainerless(): Promise<void> {
  const recorded = await recordedDriver()
  const running = recorded === undefined && getDataDir() === clientDataDir()
    ? await runningServerDriver()
    : undefined
  if ((recorded ?? running) !== 'containerless') return
  const where = running !== undefined
    ? 'The running server uses the containerless driver'
    : 'This install runs the containerless driver'
  throw new Error(
    `${where}: workspaces run on this host and there is no cluster to manage.`
    + '\n    Run `yaac host check` to verify this machine instead.',
  )
}

// On Linux, point every command (and kind, which inherits our env) at the
// rootful podman engine via CONTAINER_HOST. No-op on macOS and nested.
if (env.driver === 'k8s') ensureRootfulPodmanHost()

/** commander's accumulator for a repeatable option. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

/**
 * Help output with each subcommand's options nested under it. Set on the
 * root program, so every command inherits it.
 */
function nestedHelp(cmd: Command, helper: Help): string {
  const termWidth = helper.padWidth(cmd, helper)
  const output: string[] = []

  output.push(`Usage: ${helper.commandUsage(cmd)}`, '')

  const desc = helper.commandDescription(cmd)
  if (desc) output.push(desc, '')

  const args = helper.visibleArguments(cmd)
  if (args.length) {
    output.push('Arguments:')
    for (const arg of args)
      output.push(helper.formatItem(helper.argumentTerm(arg), termWidth, helper.argumentDescription(arg), helper))
    output.push('')
  }

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
  .configureHelp({ formatHelp: nestedHelp })

const TAILNET_HELP = 'Serve tailnet users through `tailscale serve` at this MagicDNS name (e.g. srv.<tailnet>.ts.net) instead of only this machine. The install records the mode, and every later start must name it again'
const OWNER_HELP = 'With --tailnet: switch a local install to tailnet mode, giving its projects and settings to this tailnet login. One-way; not needed for a fresh install'

const server = program
  .command('server')
  .description('Manage the host yaac server, which runs workspaces as processes on this machine (a cluster\'s server is `yaac cluster`\'s)')

server
  .command('run')
  .description('Run the server in the foreground (used internally by `start`)')
  .option('-p, --port <port>', `Preferred port on 127.0.0.1 (default: ${DEFAULT_SERVER_PORT}; increments if in use)`, (v) => Number.parseInt(v, 10))
  .action(async (options: { port?: number }) => {
    const { runServer } = await import('@yaac/server/main/server-run')
    await runServer({ port: options.port })
  })

server
  .command('start')
  .description('Start the server in the background')
  .option('--tailnet <host>', TAILNET_HELP)
  .option('--owner <login>', OWNER_HELP)
  .action(async (options: ServerAccessOptions) => {
    await refuseHostVerbOnCluster('start')
    const { startServer } = await import('@yaac/server/main/lifecycle')
    await startServer(options)
  })

server
  .command('stop')
  .description('Stop the running server')
  .action(async () => {
    await refuseHostVerbOnCluster('stop')
    const { stopServer } = await import('@yaac/server/main/lifecycle')
    await stopServer()
  })

server
  .command('restart')
  .description('Restart the server (stop, then start)')
  .option('--tailnet <host>', TAILNET_HELP)
  .option('--owner <login>', OWNER_HELP)
  .action(async (options: ServerAccessOptions) => {
    await refuseHostVerbOnCluster('restart')
    const { restartServer } = await import('@yaac/server/main/lifecycle')
    await restartServer(options)
  })

server
  .command('status')
  .description('Show whether the server is running, and whether it runs the installed build')
  .option('--json', 'Print the status as JSON (what the desktop app reads)')
  .action(async (options: { json?: boolean }) => {
    const { serverStatus } = await import('@yaac/server/main/lifecycle')
    const status = await serverStatus()
    // JSON still answers, so the desktop app can tell this data dir is a cluster's.
    if (status.driver === 'k8s' && !options.json) {
      console.log('this data dir is a cluster install; see `yaac cluster status`')
      return
    }
    printServerStatus(status, options.json)
  })

server
  .command('logs')
  .description('Print the server log (~/.yaac/server-local/server.log)')
  .option('-f, --follow', 'Keep printing new lines as they are appended')
  .option('-n, --lines <n>', 'Print only the last N lines', (v) => Number.parseInt(v, 10))
  .action(async (options: { follow?: boolean; lines?: number }) => {
    await refuseHostVerbOnCluster('logs')
    const { serverLogs } = await import('@yaac/server/main/lifecycle')
    await serverLogs(options)
  })

// Every `yaac cluster` command acts on the cluster install's data dir
// (`clusterDataDir`), while clients keep the shared `server.json`.
const cluster = program
  .command('cluster')
  .description('Manage the kubernetes cluster yaac runs workspaces on, and its server (data dir ~/.yaac-cluster)')
  .hook('preAction', async () => {
    useInstallDataDir(await clusterDataDir())
  })

cluster
  .command('check')
  .description('Verify cluster prerequisites (kubectl, registry, hostPath wiring)')
  .action(async () => {
    await refuseClusterOnContainerless()
    // Refuse a kubeconfig context other than the cluster this install was
    // recorded in, or every call would go there (see cluster-identity.ts).
    // `install` checks for itself, after a kind install has had the chance
    // to create its cluster.
    const { foreignClusterRefusal } = await import('@yaac/server/drivers/k8s/install')
    const refusal = await foreignClusterRefusal()
    if (refusal !== null) throw new Error(refusal)
    const { clusterCheck } = await import('#commands/cluster-check')
    await clusterCheck()
  })

cluster
  .command('install')
  .description('Converge this machine and its cluster to the installed yaac version: the kind cluster and CNI if there is none, the kind node fixups, every built-in image, and the in-cluster layers. Safe to re-run; never destructive.')
  .option('--nodes <count>', 'Number of kind nodes to create (default 1; workspaces run on the workers, so 3 is the smallest real multi-node rehearsal). Ignored when the cluster already exists')
  .option('--byo', 'Bring your own cluster: install into the cluster your kubeconfig points at instead of creating one — gated on its nodes, its Calico, the Tailscale operator and its storage classes; the server is published on the tailnet')
  .option('--rwx-storage-class <name>', 'With --byo (required): the NFS-family StorageClass the shared yaac-global claim is provisioned from')
  .option('--rwo-storage-class <name>', 'With --byo: the StorageClass the server\'s own yaac-server-local claim is provisioned from (default: the cluster\'s default class)')
  .option('--tailnet [host]', 'Publish the server on your Tailscale tailnet instead of at 127.0.0.1, at an https origin whose callers are identified by their tailnet user. With <host> (this machine\'s MagicDNS name), through this machine\'s own `tailscale serve`; without, through the Tailscale Kubernetes operator, which install sets up from TS_OAUTH_CLIENT_ID / TS_OAUTH_CLIENT_SECRET when the cluster lacks it')
  .option('--owner <login>', 'With --tailnet (or --byo): switch a local install to tailnet mode, giving its projects and settings to this tailnet login. One-way; not needed for a fresh install')
  // `--nodes` stays a string so the install reports what the user typed
  // rather than `NaN`. A failed finishing check exits 1.
  .action(async (options: ClusterInstallArgs) => {
    await refuseClusterOnContainerless()
    assertClusterInstallArgs(options)
    const { clusterInstall } = await import('#commands/cluster-install')
    await clusterInstall(options)
  })

cluster
  .command('delete')
  .description(
    'Delete the kind cluster, including the in-cluster registry and its '
    + 'images (keeps workspaces and their checkouts)',
  )
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(async (options: { yes?: boolean }) => {
    await refuseClusterOnContainerless()
    // No foreign-cluster guard: kind deletes its cluster by name, not via
    // the current context, and byo refuses delete outright.
    const { runClusterDelete } = await import('@yaac/server/drivers/k8s/install')
    await runClusterDelete(options)
  })

cluster
  .command('start')
  .description('Start the cluster\'s server (scale its Deployment back up) and select it')
  .action(async () => {
    await runClusterServerVerb('start')
  })

cluster
  .command('stop')
  .description('Stop the cluster\'s server (scale its Deployment to zero; workspaces keep running)')
  .action(async () => {
    await runClusterServerVerb('stop')
  })

cluster
  .command('restart')
  .description('Restart the cluster\'s server pod on the image it runs (`cluster install` updates it)')
  .action(async () => {
    await runClusterServerVerb('restart')
  })

cluster
  .command('status')
  .description('Show whether the cluster\'s server is running, and whether it runs the installed build')
  .option('--json', 'Print the status as JSON (what the desktop app reads)')
  .action(async (options: { json?: boolean }) => {
    const { serverStatus } = await import('@yaac/server/main/lifecycle')
    const status = await serverStatus()
    if (status.driver === 'k8s') {
      printServerStatus(status, options.json)
    } else if (options.json) {
      console.log(JSON.stringify({ ...status, driver: null, running: false, serverBuildId: null, origin: null }))
    } else {
      console.log('no cluster install; create one with `yaac cluster install`')
    }
  })

cluster
  .command('logs')
  .description('Print the cluster\'s server log (read through the cluster on a --byo install)')
  .option('-f, --follow', 'Keep printing new lines as they are appended')
  .option('-n, --lines <n>', 'Print only the last N lines', (v) => Number.parseInt(v, 10))
  .action(async (options: { follow?: boolean; lines?: number }) => {
    await runClusterServerVerb('logs', options)
  })

const host = program
  .command('host')
  .description('Inspect the host yaac runs containerless workspaces on')

host
  .command('check')
  .description('Verify this machine can run containerless workspaces (tmux, git, and the npm that installs its pinned agents)')
  .action(async () => {
    const { hostCheck } = await import('#commands/host-check')
    await hostCheck()
  })

const project = program
  .command('project')
  .description('Manage projects')

project
  .command('list')
  .description('List all projects')
  .action(projectList)

project
  .command('add')
  .description('Add a project from a git remote, cloned with — and assigned — the named git credential')
  .argument('<remote-url>', 'Git remote URL')
  .argument('<credential>', 'Name of the git credential to clone with and assign (see `yaac auth list`)')
  .action(projectAdd)

const group = program
  .command('group')
  .description('Manage the named groups a project\'s workspaces are filed under in the sidebar')

group
  .command('create')
  .description('Create an empty group (pinned, so it stays listed until it has workspaces)')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Group name')
  .action(groupCreate)

group
  .command('list')
  .description('List workspace groups and how many running workspaces each holds')
  .argument('[project]', 'Filter by project name, id, or id prefix')
  .action(groupList)

group
  .command('move')
  .description('File a workspace under a group, creating the group if needed')
  .argument('<workspace-id>', 'Workspace ID (or its unique prefix)')
  // Optional rather than a `--none` sentinel: commander eats a bare `--` as
  // its end-of-options marker, so it could never reach the handler.
  .argument('[group]', 'Group name; omit it to return the workspace to the default list')
  .option('--project <project>', 'Project (name, id, or id prefix) the workspace belongs to (required for a stopped workspace)')
  .action(groupMove)

group
  .command('delete')
  .description('Delete a group; its workspaces return to the default list (nothing is stopped)')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<group>', 'Group name')
  .action(groupDelete)

const workspace = program
  .command('workspace')
  .description('Manage workspaces — a git clone plus the container and agents running in it')

workspace
  .command('create')
  .description('Create a new workspace for a project')
  .argument('<project>', 'Project name, id, or id prefix')
  .option('-t, --tool <tool>', 'Agent tool to use (claude, codex, opencode, or pi). Defaults to the agent this project was last created with, else claude')
  .option('-b, --branch <branch>', 'Reference branch for the workspace (defaults to the remote default branch)')
  .option('-p, --prompt <text>', 'Initial prompt typed into the agent once the workspace is up')
  .option('-m, --model <model>', 'Model for the agent: an id or alias for claude/codex (e.g. opus), provider/model for opencode and pi. Defaults to the model this project last used for the tool, else a per-tool default')
  .option('-e, --effort <level>', 'How hard the model thinks, in the agent\'s own levels (e.g. low, high, xhigh; opencode\'s default is no variant). The model must offer it. Defaults to this project\'s last choice for the tool where the model has it, else the model\'s default')
  .addOption(new Option('--mode <mode>', 'How the agent is driven: tui runs its terminal UI, acp drives it over the Agent Client Protocol and renders a chat pane in the web app. Every tool has an adapter; a tool\'s adapter may offer fewer permission modes than its terminal UI. Defaults to this project\'s last choice for the tool, else acp; an acp workspace is not attached, so open it in the web app').choices([...AGENT_MODES]))
  .addOption(new Option('--permission-mode <mode>', 'How much the agent may do before it asks: bypass acts freely, auto lets a reviewer model judge each action, accept-edits edits without asking but asks for the rest, manual asks for everything, plan explores and asks to act on a plan, read-only (codex\'s strictest, in place of plan) asks before any edit. Defaults to this project\'s last choice for the tool, else bypass in a container and accept-edits on the host. Not every tool has every mode (pi has only bypass)').choices([...PERMISSION_MODES]))
  .option('-g, --group <group>', 'File the workspace under this sidebar group (by name; created if it does not exist)')
  .action(workspaceCreate)

workspace
  .command('list')
  .description('List running workspaces')
  .argument('[project]', 'Filter by project name, id, or id prefix')
  .option('-s, --stopped', 'List stopped workspaces (their checkouts are kept, and they can be restarted)')
  .option('-n, --num <n>', 'With -s, cap stopped results to N rows (default 25)', (v) => Number.parseInt(v, 10))
  .option('-a, --all', 'With -s, show all stopped rows without a cap')
  .action(workspaceList)

workspace
  .command('rename')
  .description('Set a workspace\'s title — the label the sidebar shows in place of its id')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .argument('<title>', 'New title (quote it if it has spaces)')
  .action(workspaceRename)

workspace
  .command('stop')
  .description('Stop a workspace: tear down its container, keep its checkout and diff')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .action(workspaceStop)

workspace
  .command('restart')
  .description('Restart a workspace: kill its container, reuse its checkout, resume the agents that were running')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .action(workspaceRestart)

workspace
  .command('agents')
  .description('List the agent sessions a workspace holds (open ones first)')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .action(workspaceAgents)

workspace
  .command('attach')
  .description('Attach to the workspace\'s tmux session')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .addHelpText('after', '\nTmux shortcuts:\n  Ctrl-B C  Open a new shell\n  Ctrl-B N  Switch to the next window\n  Ctrl-B P  Switch to the previous window')
  .action((workspaceId: string) => workspaceAttach(workspaceId, 'native'))

workspace
  .command('shell')
  .description('Open an interactive zsh shell in the workspace container')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .action((workspaceId: string) => workspaceAttach(workspaceId, 'shell'))

workspace
  .command('monitor')
  .description('Poll and display running workspaces in real-time')
  .argument('[project]', 'Filter by project name, id, or id prefix')
  .option('-n, --interval <seconds>', 'Refresh interval in seconds', '5')
  .action(workspaceMonitor)

const config = program
  .command('config')
  .description('Edit project configuration files and server settings')

config
  .command('edit')
  .description("Open the project's yaac-config.json in $EDITOR")
  .argument('<project>', 'Project name, id, or id prefix')
  .action(configEditProject)

config
  .command('edit-dockerfile')
  .description("Open the project's Dockerfile.yaac in $EDITOR")
  .argument('<project>', 'Project name, id, or id prefix')
  .action(configEditDockerfile)

config
  .command('edit-user-dockerfile')
  .description('Open your Dockerfile.user, layered on every project you own, in $EDITOR')
  .action(configEditUserDockerfile)

config
  .command('git-identity')
  .description('Show the git identity workspaces commit under, or set it with --name and --email')
  .option('--name <name>', 'Git user.name to set')
  .option('--email <email>', 'Git user.email to set')
  .action(configGitIdentity)

// Top-level, not under `workspace`: with no workspace named it forwards all
// running ones, as the desktop app does from its tray.
program
  .command('forward')
  .description('Bind the ports a workspace offers on this machine, tunnelling each connection to the server')
  .argument('[workspace-id]', 'Workspace ID, ID prefix, or name — omit to forward every running workspace')
  .option('-p, --port <container[:host]>', 'Forward this port instead of what the server offers (repeatable)', collect, [])
  .option('-b, --bind <address>', 'Address to bind (default 127.0.0.1)')
  .addHelpText('after', '\nThe server cannot bind ports on your machine — under the k8s driver it runs\nas a pod, and under containerless they are bound on the server\'s own machine —\nso this holds the listener and tunnels each connection to it. Against a\ncontainerless server on this machine there is nothing to tunnel and it refuses;\nan explicit --bind is taken as "I know what I am binding" and proceeds.\nRuns until interrupted.')
  .action(forward)

const remote = program
  .command('remote')
  .description('Point this CLI at a remote yaac server')

remote
  .command('set')
  .description('Configure and enable the remote server (verifies it is reachable and identifies this device)')
  .argument('<url>', 'Server origin, e.g. https://srv.tailnet.ts.net')
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
  .description('Manage credentials (git credentials and tool sign-ins)')

auth
  .command('list')
  .description('List configured credentials (masked), git credentials by name')
  .action(authList)

auth
  .command('update')
  .description('Add a git credential (HTTPS token or generated SSH key), or sign in a tool (Claude Code, Codex, OpenCode, or Pi)')
  .action(authUpdate)

auth
  .command('clear')
  .description('Remove stored tool credentials (interactive)')
  .action(authClear)

auth
  .command('fake')
  .description('Seed fake credentials so workspaces authenticate via a parent proxy (local/dev + yaac-in-yaac); refused for a kind already holding a real credential')
  .addArgument(
    new Argument(
      '<kinds...>',
      'Credential kinds to seed (claude-oauth, opencode-openrouter, pi-openrouter, github); pass one or more',
    ).choices([...FAKE_AUTH_KINDS]),
  )
  .action(authFake)

program.parseAsync().catch(exitOnApiError)
