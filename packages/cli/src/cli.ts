import { Command, Argument, Option, type Help } from 'commander'
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the repo-root package.json is the published @bsklaroff/yaac manifest and the single source of truth for the CLI version (inlined by tsup at build time).
import pkg from '../../../package.json' with { type: 'json' }
import { exitOnApiError } from '@yaac/shared/server-api'
import { AGENT_MODES, PERMISSION_MODES } from '@yaac/shared/types'
import { projectAdd } from '#commands/project-add'
import { userList, userRole } from '#commands/user'
import { projectList } from '#commands/project-list'
import { projectCreate } from '#commands/project-create'
import { projectClone } from '#commands/project-clone'
import { projectMove } from '#commands/project-move'
import { groupCreate, groupDelete, groupList, groupMove, groupSetLimit } from '#commands/group'
import { workspaceCreate } from '#commands/workspace-create'
import { scopeToUser } from '#commands/api'
import { workspaceList } from '#commands/workspace-list'
import { workspaceRename } from '#commands/workspace-rename'
import { workspaceStop } from '#commands/workspace-stop'
import { workspaceDelete } from '#commands/workspace-delete'
import { workspaceRerun, workspaceRestart } from '#commands/workspace-restart'
import { stepAdd, stepCancel, stepRerun, type StepAddOptions } from '#commands/workspace-steps'
import { workspaceLogs } from '#commands/workspace-logs'
import { volumeCreate, volumeDelete, volumeList, volumeResize } from '#commands/volume'
import { siteCreate, siteDelete, siteDeploy, siteEdit, siteList, siteShow, siteStart, siteStop } from '#commands/site'
import { workflowCreate, workflowDelete, workflowEdit, workflowList, workflowShow } from '#commands/workflow'
import { workspaceTimeout } from '#commands/workspace-timeout'
import { routineCreate, routineDelete, routineEdit, routineList, routinePause, routineResume, routineRun, type RoutineOptions } from '#commands/routine'
import { workspaceAttach } from '#commands/workspace-attach'
import { forward } from '#commands/forward'
import { workspaceConversations } from '#commands/workspace-conversations'
import { authUpdate } from '#commands/auth-update'
import { authClear } from '#commands/auth-clear'
import { authList } from '#commands/auth-list'
import { configDockerfile, configUserDockerfile } from '#commands/config-dockerfile'
import { configIcon } from '#commands/config-icon'
import { configCacheVolumes, configNestedContainers, configNpmCache, configPortForwards } from '#commands/config-launch-settings'
import { configShow } from '#commands/config-show'
import { configGitIdentity } from '#commands/config-git-identity'
import { feedback } from '#commands/feedback'
import { configWorkspaceAutoDelete } from '#commands/config-workspace-auto-delete'
import { configScratchDirs } from '#commands/config-scratch-dirs'
import { configInitSteps } from '#commands/config-init-steps'
import { configEnv } from '#commands/config-env'
import { configEgressAllowlist } from '#commands/config-egress-allowlist'
import { configKeptIgnoredPaths } from '#commands/config-kept-ignored-paths'
import { configDefaultBranch } from '#commands/config-default-branch'
import { configDefaultBranchGuard } from '#commands/config-default-branch-guard'
import { configGitCredential } from '#commands/config-git-credential'
import { configTimeZone } from '#commands/config-time-zone'
import { authFake } from '#commands/auth-fake'
import { authEndpointAdd, authEndpointEdit, authEndpointModels, authEndpointRefresh, authEndpointRemove } from '#commands/auth-endpoint'
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
const ADMIN_HELP = 'With --tailnet: make exactly these tailnet logins (repeat the flag for several) the install\'s admins, who alone publish sites and set roles. A fresh install needs at least one; switching a local install to tailnet takes exactly one, who gets its projects and settings. Asks before revoking anyone else\'s'

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
  .option('--admin <login>', ADMIN_HELP, collect, [])
  .option('-y, --yes', 'Revoke admin from logins --admin leaves out without asking')
  .action((options: ServerAccessOptions) => serverStart(options))

server
  .command('stop')
  .description('Stop the running server')
  .action(() => serverStop())

server
  .command('restart')
  .description('Restart the server (stop, then start)')
  .option('--tailnet <host>', TAILNET_HELP)
  .option('--admin <login>', ADMIN_HELP, collect, [])
  .option('-y, --yes', 'Revoke admin from logins --admin leaves out without asking')
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
  .option('--admin <login>', 'With --tailnet (or --byo): make exactly these tailnet logins (repeat the flag for several) the install\'s admins, who alone publish sites and set roles. A fresh install needs at least one; switching a local install to tailnet takes exactly one, who gets its projects and settings. Asks before revoking anyone else\'s', collect, [])
  .option('-y, --yes', 'Revoke admin from logins --admin leaves out without asking')
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

const user = program
  .command('user')
  .description('See the install\'s users, and set their roles')

user
  .command('list')
  .description('List the install\'s users and their roles: an admin publishes sites and sets roles, a member does neither')
  .action(userList)

user
  .command('role')
  .description('Set a user\'s role (admins only). The install\'s last admin cannot be made a member')
  .argument('<user>', 'The user: a login, name or id (see `yaac user list`)')
  .addArgument(new Argument('<role>', 'The role').choices(['admin', 'member']))
  .action(userRole)

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

project
  .command('move')
  .description('Move a yaac-hosted project, and every share of it, to an empty git remote elsewhere: stop every workspace on it (other users\' too), push every branch and tag there, and use the remote from then on. yaac keeps its copy, read-only, until removed in Project settings. Asks for confirmation, so it needs a terminal')
  .argument('<project>', 'Project name or id')
  .argument('<remote-url>', 'Git remote URL to push to: an empty repository, e.g. a new GitHub one with no README')
  .argument('<credential>', 'Name of the git credential that can push there, assigned to the project (see `yaac auth list`)')
  .action(projectMove)

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
  .description('Manage workspaces — a git clone plus the container and the agent sessions running in it')

workspace
  .command('create')
  .description('Create a new workspace for a project, with an agent session in it; or with --workspace, open another session in a running workspace')
  .argument('[project]', 'Project name, id, or id prefix (omit with --workspace)')
  .option('-w, --workspace <workspace-id>', 'Open the session in this running workspace (id or unique prefix) instead of a new one. Takes the agent options, but not --branch, --group, --timeout, --start-at or --start-in')
  .option('--resume <conversation>', 'With --workspace: open the session on one of that workspace\'s conversations (see `yaac workspace conversations`) instead of a new one')
  .option('--no-session', 'Create the workspace with no agent session; it takes no prompt or agent options')
  .option('-t, --tool <tool>', 'Agent tool to use (claude, codex, opencode, pi, or omp). Defaults to the agent this project was last created with, else claude')
  .option('-b, --branch <branch>', 'Reference branch for the workspace (defaults to the remote default branch)')
  .option('--commit <sha>', 'Start at this full commit (40 hex digits) instead of a branch\'s tip; the workspace then has no base branch. Not with --branch')
  .option('--steps <file>', 'A JSON file of the steps to start with, in place of the project\'s init steps (docs/workspace-steps.md)')
  .option('--no-steps', 'Start with no steps at all, not even the project\'s init steps')
  .option('--workflow <name>', 'Start with this named workflow, in place of --steps (docs/workflows.md). Non-interactive, it gets the run secrets the workflow names, and this launch approves its commit for them')
  .option('--non-interactive', 'Run --steps untouched, with no session, and stop when they finish: a CI run. Nothing can change it while it runs; it can only be stopped, and is rerun rather than restarted')
  .option('--wait', 'With --non-interactive: wait for its steps to finish, exiting non-zero unless they all succeeded')
  .option('-p, --prompt <text>', 'Initial prompt typed into the agent once the workspace is up; - reads it from stdin')
  .option('--prompt-file <path>', 'Read the initial prompt from this file, in place of --prompt. The way to hand over a long brief: one argument holds at most 128 KiB, and a prompt can be up to 200,000 characters')
  .option('-m, --model <model>', 'Model for the agent: an id or alias for claude/codex (e.g. opus), provider/model for opencode, pi and omp. Defaults to the model this project last used for the tool, else a per-tool default')
  .option('-e, --effort <level>', 'How hard the model thinks, in the agent\'s own levels (e.g. low, high, xhigh; opencode\'s default is no variant). The model must offer it. Defaults to this project\'s last choice for the tool where the model has it, else the model\'s default')
  .addOption(new Option('--mode <mode>', 'How the agent is driven: tui runs its terminal UI, acp drives it over the Agent Client Protocol and renders a chat pane in the web app. Every tool has an adapter; a tool\'s adapter may offer fewer permission modes than its terminal UI. Defaults to this project\'s last choice for the tool, else acp; an acp workspace is not attached, so open it in the web app').choices([...AGENT_MODES]))
  .addOption(new Option('--permission-mode <mode>', 'How much the agent may do before it asks: bypass acts freely, auto lets a reviewer model judge each action, accept-edits edits without asking but asks for the rest, manual asks for everything, plan explores and asks to act on a plan, read-only (codex\'s strictest, in place of plan) asks before any edit. Defaults to this project\'s last choice for the tool, else bypass in a container and accept-edits on the host. Not every tool has every mode (pi has only bypass)').choices([...PERMISSION_MODES]))
  .option('-g, --group <group>', 'File the workspace under this sidebar group (by name; created if it does not exist)')
  .option('--timeout <duration>', 'Stop the workspace this long after it starts, like 45m, 2h or 1h30m (whole minutes; the server checks every minute)')
  .option('--start-at <time>', 'Queue it to start at this time instead of now: HH:MM (its next occurrence), YYYY-MM-DD HH:MM, or ISO 8601, read in your yaac time zone. Needs --prompt')
  .option('--start-in <duration>', 'Queue it to start this long from now, like 30m or 2h. Needs --prompt')
  .option('--volume <name>', 'Mount this project\'s volume at $YAAC_VOLUME_DIR (see `yaac volume`); refused while another running workspace has it')
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
  .description('Stop a workspace: tear down its container, keep its checkout and diff (less its gitignored files). With --session, close one session instead; the workspace keeps running')
  .argument('<id>', 'Workspace ID or unique prefix; with --session, a session ID or unique prefix')
  .option('--session', 'Close the session <id> names: stop its agent and keep its conversations, leaving the workspace running')
  .action(workspaceStop)

workspace
  .command('delete')
  .description('Delete a stopped workspace: its checkout and local branches (anything pushed stays on the remote), unpushed commits, uncommitted changes and conversation history. Given a queued workspace\'s id (one scheduled for later, say), discards it')
  .argument('<workspace-id>', 'Workspace or queued workspace ID, or unique prefix')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(workspaceDelete)

workspace
  .command('restart')
  .description('Restart a workspace: kill its container, reuse its checkout, resume the sessions it had open')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .option('--timeout <duration>', 'Stop it this long after the restart, like 2h; without one the restart clears any timeout it had')
  .option('--volume <name>', 'Attach this volume instead of the one it last held')
  .option('--no-volume', 'Restart without the volume it last held, and forget it')
  .action(workspaceRestart)

workspace
  .command('rerun')
  .description('Start a new non-interactive workspace running a non-interactive one\'s steps again, at the commit it ran at; a non-interactive workspace is rerun, never restarted')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .option('--interactive', 'Start an interactive workspace there instead, with those steps as its start steps, to reproduce a failure in')
  .option('--wait', 'Wait for its steps to finish, exiting non-zero unless they all succeeded')
  .action(workspaceRerun)

const step = workspace
  .command('step')
  .description('Manage a running workspace\'s steps: named commands run in tmux windows of their own (docs/workspace-steps.md)')

step
  .command('add')
  .description('Add a step to a running workspace; it starts once the steps it needs have succeeded. Prints its name')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .option('--run <command>', 'A command to run (repeatable: they run in order in one shell, stopping at the first that fails)', collect, [])
  .option('--name <name>', 'Its name (default: run-<8 hex>)')
  .option('--needs <steps>', 'Comma-separated steps of the workspace that must succeed (a service: be ready) first')
  .option('--service', 'It keeps running: its last command is the process, and it never finishes')
  .option('--ready <command>', 'With --service: a check run every two seconds; steps that need it start once it passes')
  .option('--workflow <name>', 'Add a named workflow\'s steps instead, as they are (docs/workflows.md)')
  .action((workspaceId: string, opts: StepAddOptions) => stepAdd(workspaceId, opts))

step
  .command('rerun')
  .description('Run a finished step again, with the steps it caused to be skipped')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .argument('<name>', 'Step name')
  .action(stepRerun)

step
  .command('cancel')
  .description('Stop a step that has not finished; the steps that need it are skipped')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .argument('<name>', 'Step name')
  .action(stepCancel)

workspace
  .command('logs')
  .description('Print a workspace\'s terminal logs, kept for each of its lives until it is deleted, running or stopped')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .argument('[window]', 'A step\'s name, or any logged window\'s (shell, …); omit it to list the life\'s logs')
  .option('--life <n>', 'Which life: 1 (the default) is the newest, 2 the one before; or a life\'s name as the listing prints it')
  .option('--raw', 'Print the log as written, terminal escape codes and all')
  .action((workspaceId: string, window: string | undefined, opts: { life?: string; raw?: boolean }) => workspaceLogs(workspaceId, window, opts))

workspace
  .command('timeout')
  .description('Stop a running workspace this long from now, or never')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .argument('<duration>', 'Like 45m, 2h or 1h30m, or "none" to clear its timeout')
  .action(workspaceTimeout)

workspace
  .command('conversations')
  .description('List the agent conversations a workspace has held (live ones first)')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .action(workspaceConversations)

workspace
  .command('attach')
  .description('Attach to the workspace\'s tmux session, on a session\'s window (its first, unless --session names one)')
  .argument('<workspace-id>', 'Workspace ID or unique prefix')
  .option('-s, --session <session-id>', 'Open on this session\'s window (id or unique prefix)')
  .addHelpText('after', '\nTmux shortcuts:\n  Ctrl-B C  Open a new shell\n  Ctrl-B N  Switch to the next window\n  Ctrl-B P  Switch to the previous window')
  .action((workspaceId: string, opts: { session?: string }) => workspaceAttach(workspaceId, 'native', opts))

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
    .option('-t, --tool <tool>', 'Agent tool (claude, codex, opencode, pi, or omp); defaults as for workspace create')
    .option('-m, --model <model>', 'Model for the agent; defaults as for workspace create')
    .option('-e, --effort <level>', 'Effort level, which the model must offer')
    .addOption(new Option('--mode <mode>', 'How the agent is driven (tui or acp)').choices([...AGENT_MODES]))
    .addOption(new Option('--permission-mode <mode>', 'How much each run may do before it asks; a run that asks waits until it is stopped').choices([...PERMISSION_MODES]))
    .option('-b, --branch <branch>', 'Reference branch each run forks from')
    .option('--commit <sha>', 'A full commit every run starts at instead of a branch\'s tip. Not with --branch')
    .option('--workflow <name>', 'Each run starts with this named workflow, in place of the project\'s init steps (docs/workflows.md); saving approves the commit or branch it runs on for the workflow\'s run secrets, which on a branch means whatever anyone pushes there')
    .option('--non-interactive', 'Each run runs its --workflow untouched, with no prompt or session, and stops when it finishes')
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

const volume = program
  .command('volume')
  .description('Manage a project\'s volumes: named storage that one running workspace at a time mounts, kept across its stops and restarts (cluster servers only)')

volume
  .command('create')
  .description('Create a volume in a project')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Volume name: 1-40 of a-z, 0-9 and -')
  .option('--size <size>', 'Size, like 10Gi (the default) or 500Mi; enforced where the cluster gives each volume its own disk')
  .action(volumeCreate)

volume
  .command('list')
  .description('List a project\'s volumes, and the workspace each is attached to')
  .argument('<project>', 'Project name, id, or id prefix')
  .action(volumeList)

volume
  .command('resize')
  .description('Grow a volume; a volume never shrinks')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Volume name')
  .argument('<size>', 'New size, like 20Gi')
  .action(volumeResize)

volume
  .command('delete')
  .description('Delete a volume and its data; refused while a running workspace has it')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Volume name')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(volumeDelete)

const site = program
  .command('site')
  .description('Manage a project\'s public sites: an app served on the internet at a hostname by a locked workspace, its release, through the install\'s Cloudflare tunnel (cluster servers only)')

/** The options `site create` and `site edit` share. */
function siteOptions(cmd: Command, required: boolean): Command {
  const option = (flags: string, description: string): Command =>
    required ? cmd.requiredOption(flags, description) : cmd.option(flags, description)
  option('--hostname <host>', 'The public hostname it serves, which the install\'s Cloudflare tunnel must route')
  option('--port <n>', 'The port its releases serve on')
  option('--workflow <name>', 'The named workflow each release runs, one of its steps a service (docs/workflows.md); a deploy approves its commit, and following a branch the branch, for its run secrets')
  return cmd
    .option('--admin-port <n>', 'A port of each release that only you can reach, by `yaac forward` or a preview, never the internet')
    .option('--volume <name>', 'A project volume each release mounts at $YAAC_VOLUME_DIR (see `yaac volume`)')
    .option('--follow <branch>', 'Deploy each new tip of this branch on origin while the site serves, so whoever can push it, the project\'s agents included, publishes unless the remote\'s branch protection stops them; a tip that fails to deploy leaves the last good release serving')
}

siteOptions(site
  .command('create')
  .description('Create a site, and print what to add to the Cloudflare tunnel; `site deploy` publishes it')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Site name, unique in the project'), true)
  .action(siteCreate)

siteOptions(site
  .command('edit')
  .description('Change a site; the next deploy uses the new settings')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Site name'), false)
  .option('--no-admin-port', 'Offer no admin port')
  .option('--no-volume', 'Mount no volume')
  .option('--no-follow', 'Follow no branch, deploying only when asked; allowed mid-deploy, to whoever may stop the site')
  .action(siteEdit)

site
  .command('list')
  .description('List a project\'s sites, with each one\'s live release and deploy')
  .argument('<project>', 'Project name, id, or id prefix')
  .action(siteList)

site
  .command('show')
  .description('Show a site and its recent releases')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Site name')
  .action(siteShow)

site
  .command('deploy')
  .description('Start a release at a commit; once it is ready the hostname moves to it and the old release stops')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Site name')
  .option('--ref <ref>', 'A branch or commit to deploy (default: the branch the site follows, else the project\'s default branch)')
  .option('--timeout <duration>', 'Fail the deploy if its release is not ready this long after it starts, like 30m (default 15m)')
  .option('--wait', 'Wait for the deploy to finish, exiting non-zero unless it succeeded')
  .action(siteDeploy)

site
  .command('stop')
  .description('Stop the live release; the hostname answers 503 until a start or deploy')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Site name')
  .action(siteStop)

site
  .command('start')
  .description('Start a replacement of the last release, at its commit')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Site name')
  .action(siteStart)

site
  .command('delete')
  .description('Delete a site, stopping its release; its releases keep their logs')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Site name')
  .action(siteDelete)

const workflow = program
  .command('workflow')
  .description('Manage a project\'s named workflows: step graphs that routines, sites, creates and queued workspaces run by name, and the run secrets each gets (docs/workflows.md)')

workflow
  .command('create')
  .description('Create a workflow from a JSON file of steps')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Workflow name, unique in the project')
  .requiredOption('--file <path>', 'A JSON file of its steps')
  .option('--secret <name>', 'A run secret its runs get (repeatable; see `yaac config env --run-secret`)', collect, [])
  .action(workflowCreate)

workflow
  .command('edit')
  .description('Change a workflow\'s steps or run secrets; workspaces already started keep what they started with')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Workflow name')
  .option('--file <path>', 'A JSON file of its new steps; needed to give it run secrets, so they reach the steps you gave')
  .option('--secret <name>', 'A run secret its runs get, replacing those it had (repeatable)', collect, [])
  .option('--no-secrets', 'Give its runs no run secrets')
  .action(workflowEdit)

workflow
  .command('list')
  .description('List a project\'s workflows with their steps and run secrets')
  .argument('<project>', 'Project name, id, or id prefix')
  .action(workflowList)

workflow
  .command('show')
  .description('Show a workflow\'s steps, run secrets and approvals')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Workflow name')
  .action(workflowShow)

workflow
  .command('delete')
  .description('Delete a workflow nothing follows: no routine, site, queued workspace or project init steps')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('<name>', 'Workflow name')
  .action(workflowDelete)

const config = program
  .command('config')
  .description('Show or change project settings and your own; each setting prints given no value')

config
  .command('show')
  .description('Print every setting of a project, each under the name of the command that changes it')
  .argument('<project>', 'Project name, id, or id prefix')
  .action(configShow)

config
  .command('port-forwards')
  .description('Show the ports forwarded from every workspace of a project, or replace them; each workspace gets YAAC_PORT_<port>, the port its dev server should bind')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('[ports...]', 'Container ports, each optionally with the host port to offer it at (or the first one free above it), e.g. 3000 5173:8080')
  .option('--none', 'Forward no ports')
  .action(configPortForwards)

config
  .command('cache-volumes')
  .description('Show a project\'s cache volumes, directories that persist across its workspaces, or replace them (k8s only)')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('[volumes...]', 'Volumes as <name>=<absolute path in the workspace>, e.g. pip=/home/yaac/.cache/pip')
  .option('--none', 'Keep no cache volumes')
  .action(configCacheVolumes)

config
  .command('nested-containers')
  .description('Show whether a project\'s workspaces run a container engine of their own, so docker build, run and compose work, or turn it on or off (k8s only)')
  .argument('<project>', 'Project name, id, or id prefix')
  .addArgument(new Argument('[on|off]').choices(['on', 'off']))
  .action(configNestedContainers)

config
  .command('npm-cache')
  .description('Show whether a project\'s workspaces use the install\'s npm cache, or turn it on or off; off, they fetch from npmjs through the egress proxy (k8s only)')
  .argument('<project>', 'Project name, id, or id prefix')
  .addArgument(new Argument('[on|off]').choices(['on', 'off']))
  .action(configNpmCache)

config
  .command('dockerfile')
  .description('Print a project\'s Dockerfile.yaac, which builds its workspace image, or replace it (k8s only)')
  .argument('<project>', 'Project name, id, or id prefix')
  .option('--file <path>', 'Replace it with this file, or - to read it from stdin')
  .option('--none', 'Remove it, so workspaces run the default image')
  .action(configDockerfile)

config
  .command('user-dockerfile')
  .description('Print your Dockerfile.user, layered on every project you own, or replace it (k8s only)')
  .option('--file <path>', 'Replace it with this file, or - to read it from stdin')
  .option('--none', 'Remove it')
  .action(configUserDockerfile)

config
  .command('icon')
  .description('Show whether a project has an icon, the picture its chip shows in the sidebar in place of its initial, or replace it with an image file')
  .argument('<project>', 'Project name, id, or id prefix')
  .option('--file <path>', 'Replace it with this PNG, JPEG, GIF or WebP file (at most 512 KB, ideally square), or - to read it from stdin')
  .option('--none', 'Remove it, so the chip shows the project\'s initial')
  .action(configIcon)

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

config
  .command('scratch-dirs')
  .description('Show a project\'s scratch directories, which each workspace keeps off its checkout and empties when it stops (installed packages, build output), or replace them')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('[dirs...]', 'Directories relative to the checkout, each optionally with its cap in GiB, e.g. node_modules target:32; one without a cap gets the default, 16')
  .option('--none', 'Keep every directory in the checkout')
  .action(configScratchDirs)

config
  .command('init-steps')
  .description('Print a project\'s init steps as JSON, the steps every workspace runs at start unless its create brings its own; or replace them')
  .argument('<project>', 'Project name, id, or id prefix')
  .option('--file <path>', 'Replace them with the steps in this JSON file (docs/workspace-steps.md)')
  .option('--workflow <name>', 'Follow this named workflow, so workspaces start its current steps (docs/workflows.md)')
  .option('--none', 'Remove them all')
  .action(configInitSteps)

config
  .command('env')
  .description('List a project\'s environment variables and secrets (secrets masked, with where the egress proxy injects them), set them, or remove one. Applies to workspaces created afterwards')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('[vars...]', 'Plain variables to set, each NAME=value; with --secret or --run-secret, the one secret\'s NAME')
  .option('--secret', 'Set the secret NAME, reading its value from stdin (asked for without echo on a terminal; blank keeps the stored value to change only its rule). Under k8s the workspace gets a placeholder the proxy swaps for the value on matching requests; under containerless it gets the value itself')
  .option('--host <host>', 'A host the secret is injected on, exact or a wildcard like *.example.com (repeatable; at least one)', collect, [])
  .option('--path <glob>', 'Only on request paths matching this glob (default /*)')
  .option('--header <name>', 'Inject it into this header (default authorization)')
  .option('--prefix <prefix>', 'Put this before the value in the header (default "Bearer " with the default header, none with --header)')
  .option('--body-param <name>', 'Inject it into this form or JSON body field instead of a header')
  .option('--run-secret', 'Set the run secret NAME, reading its value from stdin as for --secret: a real value, under k8s too, that only the workflows naming it get (yaac workflow edit --secret)')
  .option('--unset <name>', 'Remove this variable, secret or run secret')
  .action(configEnv)

config
  .command('egress-allowlist')
  .description('Show the hosts a project\'s workspaces may reach through the egress proxy, or replace the project\'s own and turn the defaults on or off (k8s servers only). Applies to workspaces created afterwards')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('[hosts...]', 'Hosts to allow besides the defaults: exact names, or wildcards like *.example.com; * allows everything')
  .option('--none', 'Allow none besides the defaults')
  .addOption(new Option('--defaults <on|off>', 'Whether the install\'s default hosts (agent APIs, GitHub, package registries) are allowed too').choices(['on', 'off']))
  .action(configEgressAllowlist)

config
  .command('kept-ignored-paths')
  .description('Show or replace the gitignored paths a project\'s workspaces keep when they stop, which deletes every other file .gitignore matches. Applies from the next stop')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('[paths...]', 'Paths relative to the repository root, each a file or a folder and everything in it, e.g. .env data/dev.db')
  .option('--none', 'Keep no ignored files')
  .action(configKeptIgnoredPaths)

config
  .command('default-branch')
  .description('Show a project\'s default branch, or set a project yaac hosts to another existing branch')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('[branch]', 'The branch clones check out and new workspaces fork from')
  .action(configDefaultBranch)

config
  .command('default-branch-guard')
  .description('Show or set whether a project yaac hosts refuses pushes that delete its default branch or rewrite its history')
  .argument('<project>', 'Project name, id, or id prefix')
  .addArgument(new Argument('[on|off]', 'on refuses such pushes, off accepts them').choices(['on', 'off']))
  .action(configDefaultBranchGuard)

config
  .command('git-credential')
  .description('Show which git credential a project uses, or assign it one')
  .argument('<project>', 'Project name, id, or id prefix')
  .argument('[credential]', 'Git credential name, as `yaac auth list` prints it')
  .action(configGitCredential)

config
  .command('time-zone')
  .description('Show the time zone new workspaces launch in and chats show times in, or pin it; unpinned, it follows whichever device last connected')
  .argument('[zone]', 'IANA time zone to pin, e.g. Europe/Berlin')
  .option('--follow-device', 'Unpin it, starting from this machine\'s zone')
  .action(configTimeZone)

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

program
  .command('feedback')
  .description('Send feedback through the selected server to its feedback endpoint (yaac.dev unless the server sets YAAC_FEEDBACK_URL), with your name and email, the server\'s version and driver, and this CLI\'s version, Node version and OS')
  .argument('<message>', 'What to tell them')
  .option('--image <file>', 'Attach a screenshot: PNG, JPEG, GIF or WebP, 5 MB in all (repeatable)', collect, [])
  .action(feedback)

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
  .description('Add a git credential (HTTPS token or generated SSH key), or sign in a tool (Claude Code, Codex, OpenCode, Pi, or Oh My Pi)')
  .action(authUpdate)

auth
  .command('clear')
  .description('Remove stored tool credentials (interactive)')
  .action(authClear)

const endpoint = auth
  .command('endpoint')
  .description('Manage custom endpoints: self-hosted OpenAI-compatible servers opencode, pi and omp can sign in with')

endpoint
  .command('add')
  .description('Add a custom endpoint, listing its models from its /models unless --models-file names them')
  .argument('<name>', 'Name for the endpoint')
  .argument('<url>', 'Its OpenAI-compatible base URL, e.g. http://my-box:8080/v1')
  .option('--key-stdin', 'Read its api key from stdin')
  .option('--models-file <path>', 'Its models as JSON (see `yaac auth endpoint models`), or - for stdin')
  .action(authEndpointAdd)

endpoint
  .command('edit')
  .description('Edit a custom endpoint: with no option, its models in $VISUAL/$EDITOR')
  .argument('<name>', 'The endpoint, as `yaac auth list` names it')
  .option('--models-file <path>', 'Replace its models with this JSON, or - for stdin')
  .option('--rename <name>', 'Rename it')
  .option('--url <url>', 'Change its base URL')
  .option('--key-stdin', 'Replace its api key with one read from stdin')
  .option('--clear-key', 'Remove its api key')
  .action(authEndpointEdit)

endpoint
  .command('models')
  .description('Print a custom endpoint\'s models as JSON, the form --models-file reads')
  .argument('<name>', 'The endpoint, as `yaac auth list` names it')
  .action(authEndpointModels)

endpoint
  .command('refresh')
  .description('Show how the models an endpoint lists now differ from its saved ones, and apply some or all')
  .argument('<name>', 'The endpoint, as `yaac auth list` names it')
  .option('--apply <parts>', 'Apply all, or a comma list of new, changed, gone')
  .option('--edit', 'Review the result in $VISUAL/$EDITOR before saving (new and changed applied unless --apply says)')
  .action(authEndpointRefresh)

endpoint
  .command('remove')
  .description('Delete a custom endpoint, signing out the tools that use it')
  .argument('<name>', 'The endpoint, as `yaac auth list` names it')
  .action(authEndpointRemove)

auth
  .command('fake')
  .description('Seed fake credentials so workspaces authenticate via a parent proxy (local/dev + yaac-in-yaac); refused for a kind already holding a real credential')
  .addArgument(
    new Argument(
      '<kinds...>',
      'Credential kinds to seed (claude-oauth, opencode-openrouter, pi-openrouter, omp-openrouter, github); pass one or more',
    ).choices([...FAKE_AUTH_KINDS]),
  )
  .action(authFake)

program.parseAsync().catch(exitOnApiError)
