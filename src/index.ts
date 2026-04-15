import { Command, type Help } from 'commander'
import { projectAdd } from '@/commands/project-add'
import { projectList } from '@/commands/project-list'
import { sessionCreate } from '@/commands/session-create'
import { sessionList } from '@/commands/session-list'
import { sessionDelete } from '@/commands/session-delete'
import { sessionAttach } from '@/commands/session-attach'
import { sessionStream } from '@/commands/session-stream'
import { sessionMonitor } from '@/commands/session-monitor'
import { authUpdate } from '@/commands/auth-update'
import { authClear } from '@/commands/auth-clear'
import { authList } from '@/commands/auth-list'
import { ensureGithubToken } from '@/lib/project/credentials'

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
  .version('0.0.1')

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
  .option('-p, --prompt <prompt>', 'Initial prompt to pass to the agent')
  .option('-t, --tool <tool>', 'Agent tool to use (claude or codex)', 'claude')
  .option('--add-dir <path>', 'Mount a host directory as read-only (repeatable)', collect, [])
  .option('--add-dir-rw <path>', 'Mount a host directory as read-write (repeatable)', collect, [])
  .action(async (...args: Parameters<typeof sessionCreate>) => { await sessionCreate(...args) })

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
  .command('attach')
  .description('Attach to the Claude Code tmux session')
  .argument('<container-id>', 'Session ID or container name')
  .addHelpText('after', '\nTmux shortcuts:\n  Ctrl-B C  Open a new shell\n  Ctrl-B N  Switch to the next window\n  Ctrl-B P  Switch to the previous window')
  .action(sessionAttach)

session
  .command('stream')
  .description('Stream through waiting sessions, attaching to each in turn')
  .argument('[project]', 'Filter by project slug (auto-creates sessions if none waiting)')
  .action(sessionStream)

session
  .command('monitor')
  .description('Poll and display active sessions in real-time')
  .argument('[project]', 'Filter by project slug')
  .option('-n, --interval <seconds>', 'Refresh interval in seconds', '5')
  .option('--no-prewarm', 'Disable automatic session prewarming')
  .action(sessionMonitor)

const auth = program
  .command('auth')
  .description('Manage GitHub credentials')
  .configureHelp({ formatHelp: nestedHelp })

auth
  .command('list')
  .description('List configured GitHub tokens (masked)')
  .action(authList)

auth
  .command('update')
  .description('Add or replace a GitHub Personal Access Token (interactive)')
  .action(authUpdate)

auth
  .command('clear')
  .description('Remove stored GitHub credentials (interactive)')
  .action(authClear)

// Ensure GitHub token exists before any command (except auth commands)
program.hook('preAction', async (thisCommand) => {
  const chain: string[] = []
  let cmd: Command | null = thisCommand
  while (cmd) {
    const name = cmd.name()
    if (name) chain.unshift(name)
    cmd = cmd.parent
  }
  // Skip credential check for auth subcommands (they manage credentials themselves)
  if (chain.includes('auth')) return
  await ensureGithubToken()
})

program.parse()
