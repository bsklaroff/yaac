import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The in-tool halves of agent reporting for pi and opencode: code each tool
 * loads into itself that hands what it says about itself to
 * `worktree-bin/yaac-agent-report` (which puts it on the pane, where the status
 * watcher is subscribed) — the model it is running, and for opencode the agent
 * it runs as, which is its half of a permission posture. claude needs no code,
 * only hooks (`ensureClaudeHooks`), and codex runs nothing on a switch at all —
 * its model is read from its title and its posture from its rollout.
 *
 * Written into the project's tool homes at create, the way claude's hooks are,
 * rather than staged per worktree: both tools find their extensions under a
 * home that every worktree of the project already mounts, and the files are
 * the same bytes for all of them. Each carries its own guard — an absent
 * `yaac-agent-report` (a stripped build) is a failed report, never a failed
 * agent.
 *
 * Verified against the pinned binaries (pi 0.84.4, @opencode/cli 2.0.12).
 */

/**
 * pi: an extension, auto-discovered from `$PI_CODING_AGENT_DIR/extensions`.
 * `model_select` fires the moment the model changes (`/model`, Ctrl+P, a
 * restore), and `session_start` covers what it does not — startup, resume,
 * `/new` — with the session's current model.
 */
const PI_EXTENSION = `// Written by yaac: reports the model to the pane (see yaac-agent-report).
export default function (pi) {
  const report = (model) => {
    if (model === undefined) return
    pi.exec('yaac-agent-report', [model.provider + '/' + model.id]).catch(() => {})
  }
  pi.on('session_start', (_event, ctx) => report(ctx.model))
  pi.on('model_select', (event) => report(event.model))
}
`

/**
 * opencode: a server plugin, loaded from the directory named in the launch
 * config's `plugins` (`OPENCODE_REPORT_PLUGIN`). The directory, not a file — a
 * file path is refused — and opencode finds the server entry by its NAME
 * (`index` or `server`), which is why the file is `index.ts`.
 *
 * opencode's TUI keeps a model picked with `/models` to itself until the next
 * prompt is submitted, and only then tells the server
 * (`session.model.selected`), so that is the earliest anything can hear a
 * switch. `session.created` names the model a new session starts on, and
 * `session.step.started` the one each step of a turn runs on — which is what
 * covers the two cases the others miss: a restart's `--continue`, which creates
 * no session, and a first prompt that lands before the plugin has loaded
 * (plugins load in the background after the server starts serving). So a
 * resumed or early conversation reports at its first turn.
 *
 * The agent is heard the same way and at the same moment: a Tab between
 * `build` and `plan` changes only the TUI's draft until a prompt is sent, when
 * the server emits `session.agent.selected`, and every step names its agent
 * too. Both halves go out in one report whenever either moves.
 */
const OPENCODE_PLUGIN = `// Written by yaac: reports the model and agent to the pane (see yaac-agent-report).
import { execFile } from 'node:child_process'

const MODEL_EVENTS = new Set(['session.model.selected', 'session.created', 'session.step.started'])
const AGENT_EVENTS = new Set(['session.agent.selected', 'session.step.started'])

export default {
  id: 'yaac-report',
  setup(api) {
    const abort = new AbortController()
    let model = ''
    let agent = ''
    void (async () => {
      for await (const event of api.event.subscribe({ signal: abort.signal })) {
        const m = MODEL_EVENTS.has(event.type) ? event.data?.model : undefined
        const a = AGENT_EVENTS.has(event.type) ? event.data?.agent : undefined
        const nextModel = m ? m.providerID + '/' + m.id : model
        const nextAgent = typeof a === 'string' ? a : agent
        if (nextModel === model && nextAgent === agent) continue
        model = nextModel
        agent = nextAgent
        execFile('yaac-agent-report', [model, agent], () => {})
      }
    })().catch(() => {})
    return () => abort.abort()
  },
}
`

const OPENCODE_PLUGIN_NAME = 'yaac-report'

/** Where the launch config points opencode's `plugins`: the plugin's dir in
 *  the opencode config home, which every workspace reaches `$HOME`-relative
 *  (and the launch command's shell expands). */
export const OPENCODE_REPORT_PLUGIN = `$HOME/.config/opencode/${OPENCODE_PLUGIN_NAME}`

/**
 * Write both reporters into a project's tool homes: pi's agent dir (what
 * `PI_CODING_AGENT_DIR` names) and opencode's config dir. Idempotent, and
 * leaves a file that already holds these bytes untouched.
 */
export async function ensureAgentReporters(homes: {
  piAgentDir: string
  opencodeConfigDir: string
}): Promise<void> {
  await install(path.join(homes.piAgentDir, 'extensions', 'yaac-report.ts'), PI_EXTENSION)
  await install(path.join(homes.opencodeConfigDir, OPENCODE_PLUGIN_NAME, 'index.ts'), OPENCODE_PLUGIN)
}

/**
 * Written through a temp file and renamed: a tool starting in another worktree
 * of the project reads these at startup, and a plain write truncates first.
 */
async function install(file: string, content: string): Promise<void> {
  if (await fs.readFile(file, 'utf8').then((c) => c === content, () => false)) return
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`
  await fs.writeFile(tmp, content)
  await fs.rename(tmp, file)
}
