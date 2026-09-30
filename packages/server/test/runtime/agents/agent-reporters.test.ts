import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { ensureAgentReporters } from '#runtime/agents/agent-reporters'
import { seedClaudeSettings } from '#domain/workspaces/seed'
import { openRoot } from '#lib/confined-fs'

describe('ensureAgentReporters', () => {
  let dir: string
  let homes: { claudeDir: string; codexDir: string; piAgentDir: string; opencodeConfigDir: string }
  /** The homes as a sandboxing runtime opens them. */
  const roots = async () => {
    const dirs = { claude: homes.claudeDir, codex: homes.codexDir, pi: path.dirname(homes.piAgentDir), opencodeConfig: homes.opencodeConfigDir }
    for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true })
    return {
      claude: await openRoot(dirs.claude, 'no-links'),
      codex: await openRoot(dirs.codex, 'no-links'),
      pi: await openRoot(dirs.pi, 'no-links'),
      opencodeConfig: await openRoot(dirs.opencodeConfig, 'no-links'),
    }
  }
  let calls: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-reporters-'))
    homes = {
      claudeDir: path.join(dir, 'claude'),
      codexDir: path.join(dir, 'codex'),
      piAgentDir: path.join(dir, 'pi', 'agent'),
      opencodeConfigDir: path.join(dir, 'opencode'),
    }
    // The reporters are the process boundary: stubs on PATH log each call.
    calls = path.join(dir, 'calls')
    await fs.mkdir(path.join(dir, 'bin'))
    for (const name of ['yaac-agent-links', 'yaac-agent-report']) {
      await fs.writeFile(path.join(dir, 'bin', name),
        `#!/bin/sh\nprintf '%s %s|%s|%s|%s\\n' ${name} "$1" "$2" "$3" "$4" >> ${calls}\n`, { mode: 0o755 })
    }
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  interface HookMatcher { matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }
  const hooksIn = async (file: string): Promise<Record<string, string[]>> => {
    const { hooks = {} } = JSON.parse(await fs.readFile(file, 'utf8')) as { hooks?: Record<string, HookMatcher[]> }
    return Object.fromEntries(Object.entries(hooks)
      .map(([event, matchers]) => [event, matchers.flatMap((m) => m.hooks?.map((h) => h.command ?? '') ?? [])]))
  }

  /** Run a reporter as its tool would load it, in a child node. */
  const runModule = async (source: string, script: string[]): Promise<string[]> => {
    const file = path.join(dir, 'module.mjs')
    await fs.copyFile(source, file)
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', [
        `const { default: reporter } = await import(${JSON.stringify(file)})`,
        ...script,
      ].join('\n')], { env: { ...process.env, HOME: '/h', PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}` } },
      (err) => (err ? reject(new Error(err.message)) : resolve()))
    })
    return (await fs.readFile(calls, 'utf8')).trim().split('\n')
  }

  it('puts each reporter where its tool loads it from, beside what is already there', async () => {
    const claudeSettings = path.join(homes.claudeDir, 'settings.json')
    await seedClaudeSettings((await roots()).claude)
    const settings = JSON.parse(await fs.readFile(claudeSettings, 'utf8')) as Record<string, unknown>
    await fs.writeFile(claudeSettings, JSON.stringify({
      ...settings,
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'mine.sh' }] }] },
    }))
    // A malformed file is replaced: the tool would ignore it anyway.
    await fs.mkdir(homes.codexDir, { recursive: true })
    await fs.writeFile(path.join(homes.codexDir, 'hooks.json'), '{ not json')

    await ensureAgentReporters(await roots())

    // Bare names and `$HOME`-relative homes, because these files are shared
    // by a whole project and read by workspaces of either substrate. The model
    // reporter is guarded: claude hot-reloads the file, and a workspace whose
    // staged bin predates the script must not surface a hook error.
    const session = 'yaac-agent-links "$HOME/.claude" claude'
    const report = 'command -v yaac-agent-report >/dev/null && exec yaac-agent-report || true'
    expect(await hooksIn(claudeSettings)).toEqual({
      SessionStart: ['mine.sh', session, report],
      SessionEnd: [session],
      PostModelSwitch: [report],
      UserPromptSubmit: [report],
      Stop: [report],
    })
    expect(JSON.parse(await fs.readFile(claudeSettings, 'utf8'))).toMatchObject(settings)
    const codexSession = 'yaac-agent-links "$CODEX_HOME" codex'
    expect(await hooksIn(path.join(homes.codexDir, 'hooks.json')))
      .toEqual({ SessionStart: [codexSession], SessionEnd: [codexSession] })

    // A second create finds every byte in place and rewrites nothing — the
    // files are read at startup by every workspace of the project.
    const files = [
      claudeSettings,
      path.join(homes.codexDir, 'hooks.json'),
      path.join(homes.piAgentDir, 'extensions', 'yaac-report.ts'),
      path.join(homes.opencodeConfigDir, 'plugins', 'yaac-report', 'index.ts'),
    ]
    const before = await Promise.all(files.map((f) => fs.stat(f).then((s) => s.mtimeMs)))
    await new Promise((r) => setTimeout(r, 20))
    await ensureAgentReporters(await roots())
    expect(await Promise.all(files.map((f) => fs.stat(f).then((s) => s.mtimeMs)))).toEqual(before)
    expect(await fs.readdir(path.join(homes.opencodeConfigDir, 'plugins', 'yaac-report'))).toEqual(['index.ts'])
  })

  // The rename is what keeps a concurrent reader from a torn file; one that
  // fails must not leave its temp file behind in a home every workspace reads.
  it('leaves no temp file behind when a write cannot land', async () => {
    await fs.mkdir(path.join(homes.claudeDir, 'settings.json', 'occupied'), { recursive: true })
    await expect(ensureAgentReporters(await roots())).rejects.toThrow()
    expect(await fs.readdir(homes.claudeDir)).toEqual(['settings.json'])
  })

  it('replaces a hooks file planted as a link, never writing through it', async () => {
    const target = path.join(dir, 'not-a-hooks-file')
    await fs.writeFile(target, 'keep')
    await fs.mkdir(homes.codexDir)
    await fs.symlink(target, path.join(homes.codexDir, 'hooks.json'))
    await ensureAgentReporters(await roots())
    expect(await fs.readFile(target, 'utf8')).toBe('keep')
    expect((await fs.lstat(path.join(homes.codexDir, 'hooks.json'))).isFile()).toBe(true)
  })

  // The extension as written, against the API pi 0.84.4 hands it.
  it("reports pi's conversation and model, and ends each conversation as pi does", async () => {
    await ensureAgentReporters(await roots())
    expect(await runModule(path.join(homes.piAgentDir, 'extensions', 'yaac-report.ts'), [
      "const { execFile } = await import('node:child_process')",
      'const on = {}',
      'reporter({',
      '  on: (event, handler) => { on[event] = handler },',
      '  exec: (cmd, args) => new Promise((done, fail) => execFile(cmd, args, (e) => (e ? fail(e) : done()))),',
      '})',
      "on.session_start({ reason: 'startup' }, {",
      "  model: { provider: 'openrouter', id: 'z-ai/glm-5' },",
      "  sessionManager: { getSessionId: () => 'pi-1', getSessionFile: () => '/h/.pi/agent/sessions/t_pi-1.jsonl' },",
      '})',
      "on.model_select({ model: { provider: 'openrouter', id: 'moonshot/kimi-k3' } })",
      "on.session_shutdown({ reason: 'new' })",
      "await on.session_shutdown({ reason: 'quit' })",
    ])).toEqual([
      'yaac-agent-links /h/.pi|pi|pi-1|/h/.pi/agent/sessions/t_pi-1.jsonl',
      'yaac-agent-report openrouter/z-ai/glm-5|||',
      'yaac-agent-report openrouter/moonshot/kimi-k3|||',
      // A `/new` ends it as much as a quit does; another starts right after.
      'yaac-agent-links |pi|pi-1|--end',
      'yaac-agent-links |pi|pi-1|--end',
    ])
  })

  // The plugin as written, against the event shapes opencode 2.0.12 emits:
  // the agent is half a posture, and a Tab between agents reaches the server
  // only with the next prompt, as `session.agent.selected`; a session is
  // named as opencode creates it, and a subagent's (`parentID`) is not the
  // pane's.
  it("reports opencode's conversation, model and agent, and ends the conversation on dispose", async () => {
    await ensureAgentReporters(await roots())
    const model = { providerID: 'opencode', id: 'big-pickle' }
    const events = [
      { type: 'session.created', data: { sessionID: 'ses_1', model, agent: 'build' } },
      { type: 'session.agent.selected', data: { sessionID: 'ses_1', agent: 'plan' } },
      { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_1', model, agent: 'explore' } },
      { type: 'session.step.started', data: { sessionID: 'ses_1', agent: 'plan', model } },
      { type: 'session.agent.selected', data: { sessionID: 'ses_1', agent: 'build', previous: 'plan' } },
      // A `/new`, which announces no end for the session it replaces.
      { type: 'session.created', data: { sessionID: 'ses_2', model, agent: 'build' } },
    ]
    // Reports go out one at a time, and the child exits only once the last
    // has — so the file is complete, and in order, by then.
    expect(await runModule(path.join(homes.opencodeConfigDir, 'plugins', 'yaac-report', 'index.ts'), [
      `const events = ${JSON.stringify(events)}`,
      'const dispose = reporter.setup({ event: { subscribe: async function* () { yield* events } } })',
      // Disposed once every report has gone out: opencode disposes a plugin
      // as its server exits, long after a turn's reports.
      "const { readFileSync } = await import('node:fs')",
      `while ((readFileSync(${JSON.stringify(calls)}, { encoding: 'utf8', flag: 'a+' }).match(/\\n/g) ?? []).length < 6) {`,
      '  await new Promise((r) => setTimeout(r, 10))',
      '}',
      'dispose()',
    ])).toEqual([
      'yaac-agent-links |opencode|ses_1|',
      'yaac-agent-report opencode/big-pickle|||',
      'yaac-agent-report opencode/big-pickle|plan||',
      'yaac-agent-report opencode/big-pickle|build||',
      'yaac-agent-links |opencode|ses_1|--end',
      'yaac-agent-links |opencode|ses_2|',
      'yaac-agent-links |opencode|ses_2|--end',
    ])
  })

  // A plain `opencode` joins a background service shared by every TUI that
  // did not ask for its own: it keeps the env of whichever pane started it
  // and outlives each TUI, so no pane is its to report on.
  it("reports nothing from opencode's shared background service", async () => {
    await ensureAgentReporters(await roots())
    await runModule(path.join(homes.opencodeConfigDir, 'plugins', 'yaac-report', 'index.ts'), [
      "process.argv.push('serve', '--service')",
      `const events = ${JSON.stringify([{ type: 'session.created', data: { sessionID: 'ses_1' } }])}`,
      'const dispose = reporter.setup({ event: { subscribe: async function* () { yield* events } } })',
      'await new Promise((r) => setTimeout(r, 100))',
      'dispose()',
    ]).catch(() => [])
    await expect(fs.readFile(calls, 'utf8')).rejects.toThrow()
  })
})
