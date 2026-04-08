import { Command } from 'commander'
import { projectAdd } from '@/commands/project-add'
import { projectList } from '@/commands/project-list'
import { sessionCreate } from '@/commands/session-create'
import { sessionList } from '@/commands/session-list'
import { sessionShell } from '@/commands/session-shell'
import { sessionAttach } from '@/commands/session-attach'

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
  .action(sessionList)

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

program.parse()
