import { Command } from 'commander'
import { projectAdd } from '@/commands/project-add'
import { projectList } from '@/commands/project-list'
import { sessionCreate } from '@/commands/session-create'
import { sessionList } from '@/commands/session-list'
import { sessionDelete } from '@/commands/session-delete'
import { sessionShell } from '@/commands/session-shell'
import { sessionAttach } from '@/commands/session-attach'
import { sessionStream } from '@/commands/session-stream'

const program = new Command()
  .name('yaac')
  .description('Agent sandbox manager')
  .version('0.0.1')

const project = program
  .command('project')
  .description('Manage projects')

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
  .option('-p, --project <project>', 'Filter by project slug')
  .action(sessionStream)

program.parse()
