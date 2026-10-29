import { Command, Argument, Option, type Help } from 'commander'
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the repo-root package.json is the published @bsklaroff/yaac manifest and the single source of truth for the CLI version (inlined by tsup at build time).
import pkg from '../../../package.json' with { type: 'json' }
import { exitOnApiError } from '@yaac/shared/server-api'
import { AGENT_MODES, PERMISSION_MODES } from '@yaac/shared/types'
import { projectAdd } from '#commands/project-add'
import { projectList } from '#commands/project-list'
import { projectCreate } from '#commands/project-create'
import { projectClone } from '#commands/project-clone'
import { groupCreate, groupDelete, groupList, groupMove, groupSetLimit } from '#commands/group'
import { workspaceCreate } from '#commands/workspace-create'
import { scopeToUser } from '#commands/api'
import { workspaceList } from '#commands/workspace-list'
import { workspaceRename } from '#commands/workspace-rename'
import { workspaceStop } from '#commands/workspace-stop'
import { workspaceDelete } from '#commands/workspace-delete'
import { workspaceRestart } from '#commands/workspace-restart'
import { workspaceTimeout } from '#commands/workspace-timeout'
import { routineCreate, routineDelete, routineEdit, routineList, routinePause, routineResume, routineRun, type RoutineOptions } from '#commands/routine'
import { workspaceAttach } from '#commands/workspace-attach'
import { forward } from '#commands/forward'
import { workspaceAgents } from '#commands/workspace-agents'
import { authUpdate } from '#commands/auth-update'
import { authClear } from '#commands/auth-clear'
import { authList } from '#commands/auth-list'
import { configEditProject, configEditDockerfile, configEditUserDockerfile } from '#commands/config-edit'
import { configGitIdentity } from '#commands/config-git-identity'
import { configWorkspaceAutoDelete } from '#commands/config-workspace-auto-delete'
import { authFake } from '#commands/auth-fake'
import { remoteAdd, remoteConnect, remoteDisconnect, remoteList, remoteRemove } from '#commands/remote'
import {
  clusterStatus,
  serverLogs,
  serverRestart,
  serverStart,
  serverStatus,
  serverStop,
  type ServerAccessOptions,
  type ServerLogsOptions,
} from '#commands/server-lifecycle'
import { DEFAULT_SERVER_PORT } from '@yaac/shared/server-port'
import { FAKE_AUTH_KINDS } from '@yaac/shared/types'
import { clusterDataDir } from '@yaac/shared/install-record'
import { useInstallDataDir } from '@yaac/shared/paths'
import type { ClusterInstallArgs } from '@yaac/server/drivers/k8s/install'
import { ensureRootfulPodmanHost } from '@yaac/server/drivers/k8s/install/podman'
/* eslint-disable no-restricted-syntax -- The repo bans dynamic import, but
   here every `import()` defers a costly module graph. See the note below. */

// `#commands/cluster`, `#commands/host-check` and `@yaac/server/main/*` are
// imported inside the actions that need them: each loads the server or
// `@kubernetes/client-node` (about 2s), which most commands never use.
// Every static import here slows down every invocation, so only type
// imports may name the server, and the import-free podman module.
// `scripts/check-cli-externals.ts` fails the build if one reaches the
// kubernetes client.

// On Linux, point every command at the rootful podman engine through
// CONTAINER_HOST. kind inherits it, and so do a host server's workspaces,
// whose hand-run podman and kind then use the engine the cluster runs on.
// No-op on macOS.
ensureRootfulPodmanHost()

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
  .option('--user <user>', 'Act on this user\'s projects (login, name or id) rather than your own: project names and id prefixes, and the project, workspace and group listings, then mean theirs')
  .hook('preAction', () => scopeToUser(program.opts<{ user?: string }>().user))

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
  .action((options: ServerAccessOptions) => serverStart(options))

server
  .command('stop')
  .description('Stop the running server')
  .action(() => serverStop())

server
  .command('restart')
  .description('Restart the server (stop, then start)')
  .option('--tailnet <host>', TAILNET_HELP)
  .option('--owner <login>', OWNER_HELP)
  .action((options: ServerAccessOptions) => serverRestart(options))

server
  .command('status')
  .description('Show whether the server is running, refused to start, or runs another build')
  .option('--json', 'Print the status as JSON (what the desktop app reads)')
  .action(serverStatus)

server
  .command('logs')
  .description('Print the server log (~/.yaac-server/server-local/server.log)')
  .option('-f, --follow', 'Keep printing new lines as they are appended')
  .option('-n, --lines <n>', 'Print only the last N lines', (v) => Number.parseInt(v, 10))
  .action((options: ServerLogsOptions) => serverLogs(options))

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
    const { clusterCheck } = await import('#commands/cluster')
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
    const { clusterInstall } = await import('#commands/cluster')
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
    const { clusterDelete } = await import('#commands/cluster')
    await clusterDelete(options)
  })

cluster
  .command('start')
  .description('Start the cluster\'s server (scale its Deployment back up) and select it')
  .action(async () => {
    const { clusterServerVerb } = await import('#commands/cluster')
    await clusterServerVerb('start')
  })

cluster
  .command('stop')
  .description('Stop the cluster\'s server (scale its Deployment to zero; workspaces keep running)')
  .action(async () => {
    const { clusterServerVerb } = await import('#commands/cluster')
    await clusterServerVerb('stop')
  })

cluster
  .command('restart')
  .description('Restart the cluster\'s server pod on the image it runs (`cluster install` updates it)')
  .action(async () => {
    const { clusterServerVerb } = await import('#commands/cluster')
    await clusterServerVerb('restart')
  })

cluster
  .command('status')
  .description('Show whether the cluster\'s server is running, refused to start, or runs another build')
  .option('--json', 'Print the status as JSON (what the desktop app reads)')
  .action(clusterStatus)

cluster
  .command('logs')
  .description('Print the cluster\'s server log (read through the cluster on a --byo install)')
  .option('-f, --follow', 'Keep printing new lines as they are appended')
  .option('-n, --lines <n>', 'Print only the last N lines', (v) => Number.parseInt(v, 10))
  .action(async (options: ServerLogsOptions) => {
    const { clusterServerVerb } = await import('#commands/cluster')
    await clusterServerVerb('logs', options)
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
  .description('List your projects (or --user\'s)')
  .action(projectList)

project
  .command('add')
  .description('Add a project from a git remote, cloned with — and assigned — the named git credential')
  .argument('<remote-url>', 'Git remote URL')
  .argument('<credential>', 'Name of the git credential to clone with and assign (see `yaac auth list`)')
  .action(projectAdd)

project
  .command('create')
  .description('Create an empty project whose git remote yaac hosts')
  .argument('<name>', 'Project name')
  .action(projectCreate)

project
  .command('clone')
  .description('Clone a yaac-hosted project\'s git remote to this machine')
  .argument('<project>', 'Project name or id')
  .argument('[dir]', 'Directory to clone into (default: the project name)')
  .action(projectClone)

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
  .description('List your projects\' (or --user\'s) workspace groups, how many running workspaces each holds, and its workspace limit')
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
  .command('set-limit')
  .description('Cap how many of a group\'s workspaces run or start at once; queued workspaces with no parent wait for room')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<group>', 'Group name')
  .argument('<limit>', 'A whole number of workspaces, or "none" to remove the cap')
  .action(groupSetLimit)

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
  .option('-p, --prompt <text>', 'Initial prompt typed into the agent once the workspace is up; - reads it from stdin')
  .option('--prompt-file <path>', 'Read the initial prompt from this file, in place of --prompt. The way to hand over a long brief: one argument holds at most 128 KiB, and a prompt can be up to 200,000 characters')
  .option('-m, --model <model>', 'Model for the agent: an id or alias for claude/codex (e.g. opus), provider/model for opencode and pi. Defaults to the model this project last used for the tool, else a per-tool default')
  .option('-e, --effort <level>', 'How hard the model thinks, in the agent\'s own levels (e.g. low, high, xhigh; opencode\'s default is no variant). The model must offer it. Defaults to this project\'s last choice for the tool where the model has it, else the model\'s default')
  .addOption(new Option('--mode <mode>', 'How the agent is driven: tui runs its terminal UI, acp drives it over the Agent Client Protocol and renders a chat pane in the web app. Every tool has an adapter; a tool\'s adapter may offer fewer permission modes than its terminal UI. Defaults to this project\'s last choice for the tool, else acp; an acp workspace is not attached, so open it in the web app').choices([...AGENT_MODES]))
  .addOption(new Option('--permission-mode <mode>', 'How much the agent may do before it asks: bypass acts freely, auto lets a reviewer model judge each action, accept-edits edits without asking but asks for the rest, manual asks for everything, plan explores and asks to act on a plan, read-only (codex\'s strictest, in place of plan) asks before any edit. Defaults to this project\'s last choice for the tool, else bypass in a container and accept-edits on the host. Not every tool has every mode (pi has only bypass)').choices([...PERMISSION_MODES]))
  .option('-g, --group <group>', 'File the workspace under this sidebar group (by name; created if it does not exist)')
  .option('--timeout <duration>', 'Stop the workspace this long after it starts, like 45m, 2h or 1h30m (whole minutes; the server checks every minute)')
  .option('--start-at <time>', 'Queue it to start at this time instead of now: HH:MM (its next occurrence), YYYY-MM-DD HH:MM, or ISO 8601, read in your yaac time zone. Needs --prompt')
  .option('--start-in <duration>', 'Queue it to start this long from now, like 30m or 2h. Needs --prompt')
  .action(workspaceCreate)

workspace
  .command('list')
  .description('List the running workspaces of your projects (or --user\'s)')
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
  .description('Stop a workspace: tear down its container, keep its checkout and diff (less its gitignored files)')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .action(workspaceStop)

workspace
  .command('delete')
  .description('Delete a stopped workspace: its checkout and local branches (anything pushed stays on the remote), unpushed commits, uncommitted changes and conversation history. Given a queued workspace\'s id (one scheduled for later, say), discards it')
  .argument('<workspace-id>', 'Workspace or queued workspace ID, or unique prefix')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(workspaceDelete)

workspace
  .command('restart')
  .description('Restart a workspace: kill its container, reuse its checkout, resume the agents that were running')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .option('--timeout <duration>', 'Stop it this long after the restart, like 2h; without one the restart clears any timeout it had')
  .action(workspaceRestart)

workspace
  .command('timeout')
  .description('Stop a running workspace this long from now, or never')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .argument('<duration>', 'Like 45m, 2h or 1h30m, or "none" to clear its timeout')
  .action(workspaceTimeout)

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

const routine = program
  .command('routine')
  .description('Manage routines: workspaces started on a cron schedule, each stopped by the next run unless given a timeout')

/** The options `routine create` and `routine edit` share. */
function routineOptions(cmd: Command): Command {
  return cmd
    .option('--name <name>', 'Its name: heads each run\'s title, and names the group runs are filed under by default')
    .option('--cron <expr>', 'When it runs: a 5-field cron expression (minute hour day month weekday, e.g. "0 9 * * 1-5") or a nickname like @daily')
    .option('-p, --prompt <text>', 'The prompt each run starts with; - reads it from stdin')
    .option('--prompt-file <path>', 'Read the prompt from this file instead, for one too long for an argument')
    .option('--tz <zone>', 'IANA time zone the cron is read in (default: your yaac time zone)')
    .option('--timeout <duration>', 'Stop each run this long after it starts, like 2h; "next" (the default) stops it when the next run starts')
    .option('-t, --tool <tool>', 'Agent tool (claude, codex, opencode, or pi); defaults as for workspace create')
    .option('-m, --model <model>', 'Model for the agent; defaults as for workspace create')
    .option('-e, --effort <level>', 'Effort level, which the model must offer')
    .addOption(new Option('--mode <mode>', 'How the agent is driven (tui or acp)').choices([...AGENT_MODES]))
    .addOption(new Option('--permission-mode <mode>', 'How much each run may do before it asks; a run that asks waits until it is stopped').choices([...PERMISSION_MODES]))
    .option('-b, --branch <branch>', 'Reference branch each run forks from')
    .option('-g, --group <group>', 'Sidebar group runs are filed under (by name or id; created if it does not exist). Defaults to a group named after the routine')
    .option('--no-group', 'File runs in the default list instead of a group')
}

routineOptions(routine
  .command('create')
  .description('Create a routine in a project')
  .argument('<project>', 'Project name, id, or id prefix'))
  .action((project: string, opts: RoutineOptions) => routineCreate(project, opts))

routine
  .command('list')
  .description('List your projects\' (or --user\'s) routines with their next runs')
  .argument('[project]', 'Filter by project name, id, or id prefix')
  .action(routineList)

routineOptions(routine
  .command('edit')
  .description('Change a routine; a new cron or zone takes effect from its next tick, and runs already started are unaffected')
  .argument('<routine-id>', 'Routine ID or unique prefix'))
  .action((id: string, opts: RoutineOptions) => routineEdit(id, opts))

routine
  .command('pause')
  .description('Stop a routine from starting runs until it is resumed')
  .argument('<routine-id>', 'Routine ID or unique prefix')
  .action(routinePause)

routine
  .command('resume')
  .description('Resume a paused routine from its next tick (missed ticks are not caught up)')
  .argument('<routine-id>', 'Routine ID or unique prefix')
  .action(routineResume)

routine
  .command('run')
  .description('Start a run now, outside the schedule; it stops at the next scheduled run unless the routine has a timeout')
  .argument('<routine-id>', 'Routine ID or unique prefix')
  .action(routineRun)

routine
  .command('delete')
  .description('Delete a routine; runs already started keep going until their stop time')
  .argument('<routine-id>', 'Routine ID or unique prefix')
  .action(routineDelete)

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

config
  .command('workspace-auto-delete')
  .description('Show after how many days a project\'s stopped workspaces are deleted, or set it: once stopped that long, the server deletes a workspace for good (checkout, unpushed commits, uncommitted changes, conversation history). Setting it asks for confirmation, so it needs a terminal')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('[days]', 'Days a workspace stays stopped before it is deleted, or off to keep stopped workspaces until deleted by hand')
  .action(configWorkspaceAutoDelete)

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
  .description('Choose which yaac server this machine\'s clients talk to')

remote
  .command('list')
  .description('List the saved servers, marking the selected one with *')
  .action(remoteList)

remote
  .command('add')
  .description('Save a server and select it (verifies it is reachable and identifies this device)')
  .argument('<url>', 'Server origin, e.g. https://srv.tailnet.ts.net')
  .action(remoteAdd)

remote
  .command('connect')
  .description('Select a saved server (verifies it is reachable and identifies this device)')
  .argument('<url>', 'A saved server origin, as `yaac remote list` prints it')
  .action(remoteConnect)

remote
  .command('disconnect')
  .description('Deselect the server, keeping it saved')
  .action(remoteDisconnect)

remote
  .command('remove')
  .description('Forget a saved server (the selected one is refused)')
  .argument('<url>', 'A saved server origin, as `yaac remote list` prints it')
  .action(remoteRemove)

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
