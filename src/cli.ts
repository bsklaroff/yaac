import { Command, type Help } from 'commander'
import { exitOnClientError } from '@/shared/daemon-client'
import { projectAdd } from '@/commands/project-add'
import { projectList } from '@/commands/project-list'
import { sessionCreate } from '@/commands/session-create'
import { sessionList } from '@/commands/session-list'
import { sessionDelete } from '@/commands/session-delete'
import { sessionRestart } from '@/commands/session-restart'
import { sessionAttach } from '@/commands/session-attach'
import { sessionShell } from '@/commands/session-shell'
import { sessionStream } from '@/commands/session-stream'
import { sessionMonitor } from '@/commands/session-monitor'
import { authUpdate } from '@/commands/auth-update'
import { authClear } from '@/commands/auth-clear'
import { authList } from '@/commands/auth-list'
import { toolGet } from '@/commands/tool-get'
import { toolSet } from '@/commands/tool-set'
import { runDaemon, startDaemon, stopDaemon, restartDaemon, daemonLogs } from '@/daemon/cli'
import { getDefaultTool } from '@/lib/project/preferences'
import type { AgentTool } from '@/shared/types'
import type { SessionMonitorOptions } from '@/commands/session-monitor'

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

const YAAC_VERSION = '0.0.1'

const program = new Command()
  .name('yaac')
  .description('Agent sandbox manager')
  .version(YAAC_VERSION)

const daemon = program
  .command('daemon')
  .description('Manage the yaac daemon (HTTP server the CLI talks to)')
  .configureHelp({ formatHelp: nestedHelp })

daemon
  .command('run')
  .description('Run the daemon in the foreground (used internally by `start`)')
  .option('-p, --port <port>', 'Port to bind on 127.0.0.1 (default: ephemeral)', (v) => Number.parseInt(v, 10))
  .action(async (options: { port?: number }) => {
    await runDaemon({ port: options.port })
  })

daemon
  .command('start')
  .description('Start the daemon in the background')
  .action(startDaemon)

daemon
  .command('stop')
  .description('Stop the running daemon')
  .action(stopDaemon)

daemon
  .command('restart')
  .description('Restart the daemon (stop, then start)')
  .action(restartDaemon)

daemon
  .command('logs')
  .description('Print the daemon log (~/.yaac/daemon.log)')
  .option('-f, --follow', 'Keep printing new lines as they are appended')
  .option('-n, --lines <n>', 'Print only the last N lines', (v) => Number.parseInt(v, 10))
  .action(async (options: { follow?: boolean; lines?: number }) => {
    await daemonLogs(options)
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

const session = program
  .command('session')
  .description('Manage sessions')
  .configureHelp({ formatHelp: nestedHelp })

function collect(val: string, arr: string[]): string[] {
  arr.push(val)
  return arr
}

session
  .command('create')
  .description('Create a new session for a project')
  .argument('<project>', 'Project slug')
  .option('-t, --tool <tool>', 'Agent tool to use (claude or codex)')
  .option('--add-dir <path>', 'Mount a host directory as read-only (repeatable)', collect, [])
  .option('--add-dir-rw <path>', 'Mount a host directory as read-write (repeatable)', collect, [])
  .action(async (project: string, options: Parameters<typeof sessionCreate>[1]) => {
    if (!options.tool) options.tool = await getDefaultTool() ?? 'claude'
    await sessionCreate(project, options)
  })

session
  .command('list')
  .description('List active sessions')
  .argument('[project]', 'Filter by project slug')
  .option('-d, --deleted', 'List deleted sessions from Claude Code history')
  .action(sessionList)

session
  .command('delete')
  .description('Delete a session and clean up its resources')
  .argument('<session-id>', 'Session ID, container name, or container ID')
  .action(sessionDelete)

session
  .command('restart')
  .description('Restart a session: kill its container, reuse its worktree, resume the agent')
  .argument('<session-id>', 'Session ID, container name, or container ID')
  .option('--add-dir <path>', 'Mount a host directory as read-only (repeatable)', collect, [])
  .option('--add-dir-rw <path>', 'Mount a host directory as read-write (repeatable)', collect, [])
  .action(async (sessionId: string, options: Parameters<typeof sessionRestart>[1]) => {
    await sessionRestart(sessionId, options)
  })

session
  .command('attach')
  .description('Attach to the Claude Code tmux session')
  .argument('<container-id>', 'Session ID or container name')
  .addHelpText('after', '\nTmux shortcuts:\n  Ctrl-B C  Open a new shell\n  Ctrl-B N  Switch to the next window\n  Ctrl-B P  Switch to the previous window')
  .action(sessionAttach)

session
  .command('shell')
  .description('Open an interactive zsh shell in the session container')
  .argument('<container-id>', 'Session ID or container name')
  .action(sessionShell)

session
  .command('stream')
  .description('Stream through waiting sessions, attaching to each in turn')
  .argument('[project]', 'Filter by project slug (auto-creates sessions if none waiting)')
  .option('-t, --tool <tool>', 'Agent tool for newly created sessions (claude or codex)')
  .action(async (project: string | undefined, options: { tool?: string }) => {
    const tool = options.tool ?? await getDefaultTool() ?? 'claude'
    await sessionStream(project, tool as AgentTool)
  })

session
  .command('monitor')
  .description('Poll and display active sessions in real-time')
  .argument('[project]', 'Filter by project slug')
  .option('-n, --interval <seconds>', 'Refresh interval in seconds', '5')
  .action(async (project: string | undefined, options: SessionMonitorOptions) => {
    await sessionMonitor(project, options)
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
  .argument('<tool>', 'Agent tool to use (claude or codex)')
  .action(toolSet)

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
  .description('Add or update credentials (GitHub, Claude Code, or Codex)')
  .action(authUpdate)

auth
  .command('clear')
  .description('Remove stored credentials (interactive)')
  .action(authClear)

program.parseAsync().catch(exitOnClientError)
