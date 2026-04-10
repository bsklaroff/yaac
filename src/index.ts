import { Command, type Help } from 'commander'
import { projectAdd } from '@/commands/project-add'
import { projectList } from '@/commands/project-list'
import { sessionCreate } from '@/commands/session-create'
import { sessionList } from '@/commands/session-list'
import { sessionDelete } from '@/commands/session-delete'
import { sessionShell } from '@/commands/session-shell'
import { sessionAttach } from '@/commands/session-attach'
import { sessionStream } from '@/commands/session-stream'

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

session
  .command('create')
  .description('Create a new session for a project')
  .argument('<project>', 'Project slug')
  .option('-p, --prompt <prompt>', 'Initial prompt to pass to Claude Code')
  .action(sessionCreate)

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
  .command('shell')
  .description('Open a bash shell in a session container')
  .argument('<container-id>', 'Session ID or container name')
  .action(sessionShell)

session
  .command('attach')
  .description('Attach to the Claude Code session')
  .argument('<container-id>', 'Session ID or container name')
  .action(sessionAttach)

session
  .command('stream')
  .description('Stream through waiting sessions, attaching to each in turn')
  .argument('[project]', 'Filter by project slug (auto-creates sessions if none waiting)')
  .action(sessionStream)

program.parse()
