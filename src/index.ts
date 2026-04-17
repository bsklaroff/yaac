import { Command, type Help } from 'commander'
import { projectAdd } from '@/commands/project-add'
import { projectList } from '@/commands/project-list'
import { sessionCreate } from '@/commands/session-create'
import { sessionList } from '@/commands/session-list'
import { sessionDelete } from '@/commands/session-delete'
import { sessionAttach } from '@/commands/session-attach'
import { sessionShell } from '@/commands/session-shell'
import { sessionStream } from '@/commands/session-stream'
import { sessionMonitor } from '@/commands/session-monitor'
import { authUpdate } from '@/commands/auth-update'
import { authClear } from '@/commands/auth-clear'
import { authList } from '@/commands/auth-list'
import { toolGet } from '@/commands/tool-get'
import { toolSet } from '@/commands/tool-set'
import { ensureGithubToken } from '@/lib/project/credentials'
import { ensureDefaultTool, getDefaultTool, isValidTool } from '@/lib/project/preferences'
import { ensureToolAuth } from '@/lib/project/tool-auth'
import type { AgentTool } from '@/types'
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
  .option('--no-prewarm', 'Disable automatic session prewarming')
  .option('--prewarm-tool <tool>', 'Agent tool for prewarmed sessions (claude or codex)')
  .action(async (project: string | undefined, options: SessionMonitorOptions) => {
    if (!options.prewarmTool) options.prewarmTool = await getDefaultTool() ?? 'claude'
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

// Ensure default tool and GitHub token exist before any command
// (except auth/tool subcommands which manage their own state).
// Tool auth is checked against the tool the command will actually use —
// honoring --tool / --prewarm-tool overrides — so an unconfigured tool
// triggers its login flow even when it isn't the configured default.
program.hook('preAction', async (thisCommand) => {
  const chain: string[] = []
  let cmd: Command | null = thisCommand
  while (cmd) {
    const name = cmd.name()
    if (name) chain.unshift(name)
    cmd = cmd.parent
  }
  if (chain.includes('auth') || chain.includes('tool')) return
  const defaultTool = await ensureDefaultTool()
  const opts = thisCommand.opts()
  // session monitor --no-prewarm won't launch a tool — skip the tool auth check.
  const skipToolAuth = chain.includes('monitor') && opts.prewarm === false
  if (!skipToolAuth) {
    const rawOverride: unknown = opts.tool ?? opts.prewarmTool
    let tool: AgentTool = defaultTool
    if (rawOverride !== undefined) {
      if (typeof rawOverride !== 'string' || !isValidTool(rawOverride)) {
        const asString = typeof rawOverride === 'string' ? rawOverride : JSON.stringify(rawOverride)
        console.error(`Invalid tool "${asString}". Must be one of: claude, codex`)
        process.exit(1)
      }
      tool = rawOverride
    }
    await ensureToolAuth(tool)
  }
  await ensureGithubToken()
})

program.parse()
