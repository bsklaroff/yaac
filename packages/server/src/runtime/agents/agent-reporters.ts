import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The in-tool halves of agent reporting: what each tool is made to run so it
 * puts what it says about itself on its tmux pane, where the status watcher is
 * subscribed — the conversation it holds (`worktree-bin/yaac-agent-links`),
 * the model it is running and the permission mode it is in
 * (`worktree-bin/yaac-agent-report`). claude and codex run hooks; pi and
 * opencode load code of their own. codex reports no model or mode: its model
 * is read from its title and its posture from its rollout.
 *
 * Written into the project's tool homes at create rather than staged per
 * worktree or passed on a launch command: every worktree of the project
 * mounts those homes, the bytes are the same for all of them, and a tool the
 * user starts by hand in a shell reads them too — which is how a conversation
 * begun there is recorded like any other. The reporters themselves are
 * staged per worktree onto its PATH and named bare, so one form serves both
 * substrates.
 *
 * Each report is best-effort — an absent script (a stripped build) is a
 * failed report, never a failed agent — and pi's and opencode's run one at a
 * time, in order: the pane options are last-write-wins, so two reports in
 * flight at once can land out of order and leave the pane on the older value.
 *
 * Verified against the pinned binaries (claude 2.1.282, codex-cli 0.156.1,
 * pi 0.84.4, @opencode/cli 2.0.12).
 */

/**
 * claude's and codex's session hook. `SessionStart` fires on `startup`,
 * `resume`, `clear` and `compact` — exactly the events that change which
 * conversation a pane is in — and `SessionEnd` ends it, which matters in a
 * shell the pane outlives and when an agent runs another inside its own pane
 * (see the script). Hooks run through
 * `/bin/sh -c` with the agent's environment, which is what resolves the home.
 */
const sessionHook = (home: string, tool: string): string => `yaac-agent-links "${home}" ${tool}`

/**
 * claude's model and mode reporter, run on the events whose payload can name
 * either. The model: `PostModelSwitch` (its `to_model`), fired the moment
 * `/model` lands, and `SessionStart` (its `model`) — on an interactive
 * startup, NOT on a CLI `--resume` or a `/clear`, so a restarted claude pane
 * keeps its row's model until its first `/model` (claude 2.1.282). The mode:
 * `UserPromptSubmit` and `Stop` (their `permission_mode`). No event fires on a
 * mode change itself — Shift+Tab runs nothing — so the mode is reported when
 * it takes hold: a mode picked between turns is in force by the next prompt,
 * and one the agent moved to mid-turn (EnterPlanMode, a plan-exit answer) as
 * the turn ends. Its stdout must stay empty: claude hands a hook's stdout to
 * the model on these events.
 *
 * Guarded, because claude hot-reloads this project-shared file: a worktree
 * whose staged bin predates the script would otherwise show a hook error on
 * every prompt and `/model`. `exec` keeps the payload on stdin.
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
 * codex's, from `$CODEX_HOME/hooks.json`. codex fires `SessionStart` at a
 * conversation's first turn, not at startup, and a resumed one's at its next
 * turn — which is why a resume launch names its conversation itself
 * (`buildAgentCmd`). yaac's launch passes `--dangerously-bypass-hook-trust`,
 * so these run unreviewed there; a codex started by hand asks once whether to
 * trust them, and remembers the answer in the project's `config.toml`.
 */
const CODEX_HOOKS: Hooks = [
  ['SessionStart', sessionHook('$CODEX_HOME', 'codex')],
  ['SessionEnd', sessionHook('$CODEX_HOME', 'codex')],
]

/**
 * pi: an extension, auto-discovered from `$PI_CODING_AGENT_DIR/extensions`.
 * `session_start` fires on startup, resume and `/new`, with the session's id,
 * its log and its current model; `model_select` the moment the model changes
 * (`/model`, Ctrl+P, a restore); `session_shutdown` as a session ends, for a
 * `/new` or a resume as well as a quit.
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
 * opencode: a server plugin, auto-discovered from `plugins/<name>/index.ts`
 * in its config dir — so a hand-run opencode loads it too. It runs in the
 * server child `--standalone` gives each TUI, which inherits the pane's env.
 * A plain `opencode` instead joins a background service (`serve --service`)
 * shared by every TUI that did not ask for its own, which keeps the env of
 * whichever pane started it and outlives each TUI: no pane is its own, so it
 * reports nothing there — a conversation is recorded from a hand-run
 * `opencode --standalone`, not a plain `opencode` (opencode 2.0.12).
 *
 * The conversation: opencode creates a session lazily, at its first prompt,
 * and says so in `session.created` — whose `parentID` marks a subagent's,
 * which is not the pane's. A new one (`/new`) ends the one it replaces, which
 * opencode announces no end for. A resumed session emits no such event at
 * all, and none that tells its turns from a subagent's, so yaac's resume
 * launch names it itself (`buildAgentCmd`). The plugin ends the one it named
 * as it is disposed.
 *
 * The model: opencode's TUI keeps a model picked with `/models` to itself
 * until the next prompt is submitted, and only then tells the server
 * (`session.model.selected`), so that is the earliest anything can hear a
 * switch. `session.created` names the model a new session starts on, and
 * `session.step.started` the one each step of a turn runs on — which covers a
 * resumed conversation, which creates no session, and a first prompt that
 * lands before the plugin has loaded (plugins load in the background after the
 * server starts serving).
 *
 * The agent is heard the same way and at the same moment: a Tab between
 * `build` and `plan` changes only the TUI's draft until a prompt is sent, when
 * the server emits `session.agent.selected`, and every step names its agent
 * too. Both halves go out in one report whenever either moves.
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
 * Install every tool's reporter into a project's tool homes: claude's hooks
 * into its `settings.json`, codex's into `hooks.json` in its home, pi's
 * extension into its agent dir (what `PI_CODING_AGENT_DIR` names) and
 * opencode's plugin into its config dir. Idempotent, and leaves a file that
 * already holds these bytes untouched.
 */
export async function ensureAgentReporters(homes: {
  claudeDir: string
  codexDir: string
  piAgentDir: string
  opencodeConfigDir: string
}): Promise<void> {
  await mergeHooks(path.join(homes.claudeDir, 'settings.json'), CLAUDE_HOOKS)
  await mergeHooks(path.join(homes.codexDir, 'hooks.json'), CODEX_HOOKS)
  await install(path.join(homes.piAgentDir, 'extensions', 'yaac-report.ts'), PI_EXTENSION)
  await install(path.join(homes.opencodeConfigDir, 'plugins', 'yaac-report', 'index.ts'), OPENCODE_PLUGIN)
}

interface HookMatcher {
  matcher?: string
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>
}

/**
 * Merge `wanted` into a settings file's `hooks`, in the shape claude's
 * `settings.json` and codex's `hooks.json` share.
 *
 * Additive: unrelated keys (the bypass-prompt flag `seedClaudeSettings`
 * writes, whatever theme claude wrote itself) and any user-registered hooks
 * survive, and a file that already carries every entry is left byte-identical.
 * A malformed file is replaced rather than propagated — the tool would ignore
 * it anyway, and what yaac cares about is re-seeded on every create.
 */
async function mergeHooks(file: string, wanted: Hooks): Promise<void> {
  let settings: { hooks?: Record<string, HookMatcher[] | undefined>; [key: string]: unknown } = {}
  try {
    settings = JSON.parse(await fs.readFile(file, 'utf8')) as typeof settings
  } catch {
    // missing or invalid — start fresh
  }
  const hooks = { ...settings.hooks }
  const missing = wanted.filter(([event, command]) =>
    !(hooks[event]?.some((m) => m.hooks?.some((h) => h.command === command)) ?? false))
  if (missing.length === 0) return
  for (const [event, command] of missing) {
    // 3s: codex clamps a SessionEnd hook to it, with a warning on every launch.
    hooks[event] = [...hooks[event] ?? [], { matcher: '*', hooks: [{ type: 'command', command, timeout: 3 }] }]
  }
  await install(file, JSON.stringify({ ...settings, hooks }, null, 2) + '\n')
}

/** Distinguishes the temp files of concurrent writes within one process. */
let tmpSeq = 0

/**
 * Written through a temp file in the same directory and renamed: each of
 * these has other readers and writers — a tool starting in another worktree
 * of the project, the user editing it, claude rewriting its settings when a
 * theme changes — and a plain write truncates first, so a reader landing in
 * that window sees an empty or invalid file. Our own answer to invalid JSON is
 * "start fresh", so a torn read would compound into discarding the user's
 * settings on the next create. The name is unique per call: two creates in
 * the same project run concurrently.
 */
async function install(file: string, content: string): Promise<void> {
  if (await fs.readFile(file, 'utf8').then((c) => c === content, () => false)) return
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${String(process.pid)}.${String(tmpSeq++)}.tmp`
  await fs.writeFile(tmp, content)
  try {
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}
