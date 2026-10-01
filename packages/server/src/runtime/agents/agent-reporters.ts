import type { ConfinedRoot } from '#lib/confined-fs'

/**
 * The in-tool half of agent reporting: what each tool runs so it writes its
 * conversation (`workspace-bin/yaac-agent-links`) and its model and
 * permission mode (`workspace-bin/yaac-agent-report`) onto its tmux pane,
 * where the status watcher reads them. claude and codex use hooks; pi and
 * opencode load a small extension/plugin. codex reports no model or mode
 * (they come from its title and rollout).
 *
 * Installed into the project's tool homes at create, since every workspace
 * mounts them and a tool started by hand in a shell then reports too. The
 * reporter scripts are on each workspace's PATH, so one form works on both
 * drivers.
 *
 * Reports are best-effort (a missing script never fails the agent). pi's and
 * opencode's run one at a time, in order, since pane options are
 * last-write-wins.
 *
 * Verified against claude 2.1.286, codex-cli 0.159.3, pi 0.99.2 and
 * @opencode/cli 2.0.21.
 */

/**
 * claude's and codex's session hook. `SessionStart` fires on `startup`,
 * `resume`, `clear` and `compact` (every change of conversation);
 * `SessionEnd` ends it. Hooks run via `/bin/sh -c` with the agent's env,
 * which resolves the home.
 */
const sessionHook = (home: string, tool: string): string => `yaac-agent-links "${home}" ${tool}`

/**
 * claude's model and mode reporter. Model: `PostModelSwitch` (`to_model`)
 * and `SessionStart` (`model`), which fires on interactive startup but not
 * on `--resume` or `/clear`, so a restarted pane keeps its row's model until
 * the next `/model`. Mode: `UserPromptSubmit` and `Stop`
 * (`permission_mode`); no event fires on Shift+Tab, so a mode change is
 * reported at the next prompt or turn end. Stdout must stay empty, because
 * claude passes it to the model on these events.
 *
 * Guarded because claude hot-reloads this shared file, and a workspace
 * whose staged bin lacks the script would show a hook error on every
 * prompt. `exec` keeps the payload on stdin.
 */
const CLAUDE_REPORT_HOOK = 'command -v yaac-agent-report >/dev/null && exec yaac-agent-report || true'

type Hooks = ReadonlyArray<readonly [event: string, command: string]>

const CLAUDE_HOOKS: Hooks = [
  ['SessionStart', sessionHook('$HOME/.claude', 'claude')],
  ['SessionEnd', sessionHook('$HOME/.claude', 'claude')],
  ['SessionStart', CLAUDE_REPORT_HOOK],
  ['PostModelSwitch', CLAUDE_REPORT_HOOK],
  ['UserPromptSubmit', CLAUDE_REPORT_HOOK],
  ['Stop', CLAUDE_REPORT_HOOK],
]

/**
 * codex's hooks (`$CODEX_HOME/hooks.json`). codex fires `SessionStart` at a
 * conversation's first turn, not at startup, so a resume launch names its
 * conversation itself (`buildAgentCmd`). yaac launches with
 * `--dangerously-bypass-hook-trust`; a hand-started codex asks once whether
 * to trust them.
 */
const CODEX_HOOKS: Hooks = [
  ['SessionStart', sessionHook('$CODEX_HOME', 'codex')],
  ['SessionEnd', sessionHook('$CODEX_HOME', 'codex')],
]

/**
 * pi's extension, auto-discovered from `$PI_CODING_AGENT_DIR/extensions`.
 * `session_start` (startup, resume, `/new`) gives the session id, log and
 * model; `model_select` fires on any model change; `session_shutdown` fires
 * as a session ends.
 */
const PI_EXTENSION = `// Written by yaac: reports the conversation and model to the pane
// (see yaac-agent-links and yaac-agent-report).
export default function (pi) {
  let reported = Promise.resolve()
  const run = (cmd, args) => {
    reported = reported.then(() => pi.exec(cmd, args)).catch(() => {})
    return reported
  }
  const report = (model) => {
    if (model !== undefined) run('yaac-agent-report', [model.provider + '/' + model.id])
  }
  let session = ''
  pi.on('session_start', (_event, ctx) => {
    session = ctx.sessionManager.getSessionId()
    run('yaac-agent-links', [process.env.HOME + '/.pi', 'pi', session, ctx.sessionManager.getSessionFile() ?? ''])
    report(ctx.model)
  })
  pi.on('model_select', (event) => report(event.model))
  pi.on('session_shutdown', () => run('yaac-agent-links', ['', 'pi', session, '--end']))
}
`

/**
 * opencode's server plugin, auto-discovered from `plugins/<name>/index.ts`
 * in its config dir. It runs in the per-TUI server `--standalone` starts,
 * which inherits the pane's env. A plain `opencode` joins a shared
 * background service that belongs to no pane, so the plugin reports nothing
 * there; only a hand-run `opencode --standalone` is recorded.
 *
 * Conversation: opencode creates a session lazily at the first prompt
 * (`session.created`; a `parentID` marks a subagent's). `/new` implicitly
 * ends the previous one. A resumed session emits no event, so yaac's resume
 * launch names it (`buildAgentCmd`). The plugin ends its session on dispose.
 *
 * Model and agent: the TUI tells the server about a `/models` pick or a Tab
 * between `build` and `plan` only when the next prompt is sent
 * (`session.model.selected`, `session.agent.selected`). `session.created`
 * and each `session.step.started` also name them, which covers resumed
 * conversations and a first prompt sent before the plugin loaded. Both are
 * reported together whenever either changes.
 */
const OPENCODE_PLUGIN = `// Written by yaac: reports the conversation, model and agent to the pane
// (see yaac-agent-links and yaac-agent-report).
import { execFile, execFileSync } from 'node:child_process'

const MODEL_EVENTS = new Set(['session.model.selected', 'session.created', 'session.step.started'])
const AGENT_EVENTS = new Set(['session.agent.selected', 'session.step.started'])

export default {
  id: 'yaac-report',
  setup(api) {
    if (process.argv.includes('--service')) return () => {}
    const abort = new AbortController()
    let model = ''
    let agent = ''
    let session = ''
    let reported = Promise.resolve()
    const run = (cmd, args) => {
      reported = reported.then(() => new Promise((done) => execFile(cmd, args, () => done())))
    }
    void (async () => {
      for await (const event of api.event.subscribe({ signal: abort.signal })) {
        if (event.type === 'session.created' && !event.data?.parentID && event.data?.sessionID) {
          if (session) run('yaac-agent-links', ['', 'opencode', session, '--end'])
          session = event.data.sessionID
          run('yaac-agent-links', ['', 'opencode', session])
        }
        const m = MODEL_EVENTS.has(event.type) ? event.data?.model : undefined
        const a = AGENT_EVENTS.has(event.type) ? event.data?.agent : undefined
        const nextModel = m ? m.providerID + '/' + m.id : model
        const nextAgent = typeof a === 'string' ? a : agent
        if (nextModel === model && nextAgent === agent) continue
        model = nextModel
        agent = nextAgent
        run('yaac-agent-report', [model, agent])
      }
    })().catch(() => {})
    return () => {
      abort.abort()
      if (!session) return
      try {
        execFileSync('yaac-agent-links', ['', 'opencode', session, '--end'], { stdio: 'ignore' })
      } catch {}
    }
  },
}
`

/**
 * Install every tool's reporter into a project's tool homes (opened with
 * `openSandboxDir`): claude's hooks into `settings.json`, codex's into
 * `hooks.json`, pi's extension into its agent dir and opencode's plugin into
 * its config dir. Idempotent; unchanged files are not rewritten.
 */
export async function ensureAgentReporters(homes: {
  claude: ConfinedRoot
  codex: ConfinedRoot
  pi: ConfinedRoot
  opencodeConfig: ConfinedRoot
}): Promise<void> {
  await mergeHooks(homes.claude, 'settings.json', CLAUDE_HOOKS)
  await mergeHooks(homes.codex, 'hooks.json', CODEX_HOOKS)
  await install(homes.pi, 'agent/extensions/yaac-report.ts', PI_EXTENSION)
  await install(homes.opencodeConfig, 'plugins/yaac-report/index.ts', OPENCODE_PLUGIN)
}

interface HookMatcher {
  matcher?: string
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>
}

/** Larger than any hand-written settings file; a bigger file is replaced
 *  rather than read. */
const MAX_SETTINGS_BYTES = 1024 * 1024

/**
 * Merge `wanted` into a settings file's `hooks` (claude's `settings.json`
 * and codex's `hooks.json` share the shape). Other keys and user hooks are
 * kept, and a file already containing every entry is left untouched. A
 * malformed file, or anything that is not a regular file (e.g. a planted
 * link), is replaced; yaac re-seeds its entries on every create. Holds the
 * file's lock, since `seedClaudeSettings` updates the same file.
 */
async function mergeHooks(home: ConfinedRoot, rel: string, wanted: Hooks): Promise<void> {
  await home.locked(rel, async () => {
    let settings: { hooks?: Record<string, HookMatcher[] | undefined>; [key: string]: unknown } = {}
    try {
      const raw = await home.readFile(rel, { maxBytes: MAX_SETTINGS_BYTES })
      if (raw !== null) settings = JSON.parse(raw.toString('utf8')) as typeof settings
    } catch {
      // Invalid or oversized: start fresh.
    }
    const hooks = { ...settings.hooks }
    const missing = wanted.filter(([event, command]) =>
      !(hooks[event]?.some((m) => m.hooks?.some((h) => h.command === command)) ?? false))
    if (missing.length === 0) return
    for (const [event, command] of missing) {
      // 3s: codex clamps SessionEnd hooks to this and warns otherwise.
      hooks[event] = [...hooks[event] ?? [], { matcher: '*', hooks: [{ type: 'command', command, timeout: 3 }] }]
    }
    await install(home, rel, JSON.stringify({ ...settings, hooks }, null, 2) + '\n')
  })
}

/**
 * Write atomically: these files have other readers and writers (tools in
 * other workspaces, the user, claude itself), and a torn read of invalid
 * JSON would make the next create discard the user's settings.
 */
async function install(home: ConfinedRoot, rel: string, content: string): Promise<void> {
  const current = await home.readFile(rel, { maxBytes: MAX_SETTINGS_BYTES }).catch(() => null)
  if (current?.toString('utf8') === content) return
  await home.writeAtomic(rel, content)
}
