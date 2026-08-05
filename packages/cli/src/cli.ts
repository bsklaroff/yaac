import { Command, Argument, type Help } from 'commander'
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the repo-root package.json is the published @bsklaroff/yaac manifest and the single source of truth for the CLI version (inlined by tsup at build time).
import pkg from '../../../package.json' with { type: 'json' }
import { exitOnApiError } from '@yaac/shared/server-api'
import { projectAdd } from '#commands/project-add'
import { projectList } from '#commands/project-list'
import { projectRebuild } from '#commands/project-rebuild'
import { worktreeCreate } from '#commands/worktree-create'
import { worktreeList } from '#commands/worktree-list'
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

// `#commands/cluster-*`, `@yaac/server/main/*` and the k8s platform layer are
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
import { ensureRootfulPodmanHost } from '@yaac/server/platform/container/runtime'
import { FAKE_AUTH_KINDS, type FakeAuthKind } from '@yaac/shared/types'
import type { WorktreeMonitorOptions } from '#commands/worktree-monitor'

// On Linux, yaac drives the rootful podman engine (CONTAINER_HOST). Set it once
// here so every command — `cluster setup` (kind inherits our env) and the
// image build/push paths — targets the same engine. No-op on macOS and nested.
ensureRootfulPodmanHost()

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
  .action(async (options: { port?: number }) => {
    const { runServer } = await import('@yaac/server/main/server-run')
    await runServer({ port: options.port })
  })

server
  .command('start')
  .description('Start the server in the background')
  .action(async () => {
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
  .action(async () => {
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
    const { clusterCheck } = await import('#commands/cluster-check')
    await clusterCheck()
  })

cluster
  .command('setup')
  .description('Create the kind cluster, registry, and CNI wiring yaac needs (destructive: recreates the cluster)')
  .option('--repair', 'Re-apply the node fixups that vanish on node/VM restart, without recreating the cluster')
  .action(async (options: { repair?: boolean }) => {
    const { clusterSetup } = await import('#commands/cluster-setup')
    await clusterSetup(options)
  })

cluster
  .command('delete')
  .description('Delete the kind cluster and local registry (keeps worktrees and their checkouts)')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(async (options: { yes?: boolean }) => {
    const { clusterDelete } = await import('#commands/cluster-delete')
    await clusterDelete(options)
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

project
  .command('rebuild')
  .description("Rebuild the project's tools layer (claude/codex/opencode/pi) with --no-cache")
  .argument('<project>', 'Project slug')
  .action(projectRebuild)

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
  .description('Seed fake credentials so sessions authenticate via a parent proxy (local/dev + yaac-in-yaac)')
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
