import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The in-tool halves of model reporting for pi and opencode: code each tool
 * loads into itself that hands the model it is running to
 * `worktree-bin/yaac-agent-model` (which puts it on the pane as `@yaac-model`,
 * where the status watcher is subscribed). claude needs no code, only hooks
 * (`ensureClaudeHooks`), and codex runs nothing on a switch at all — it is read
 * from its title instead.
 *
 * Written into the project's tool homes at create, the way claude's hooks are,
 * rather than staged per worktree: both tools find their extensions under a
 * home that every worktree of the project already mounts, and the files are
 * the same bytes for all of them. Each carries its own guard — an absent
 * `yaac-agent-model` (a stripped build) is a failed report, never a failed
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
const PI_EXTENSION = `// Written by yaac: reports the model to the pane (see yaac-agent-model).
export default function (pi) {
  const report = (model) => {
    if (model === undefined) return
    pi.exec('yaac-agent-model', [model.provider + '/' + model.id]).catch(() => {})
  }
  pi.on('session_start', (_event, ctx) => report(ctx.model))
  pi.on('model_select', (event) => report(event.model))
}
`

/**
 * opencode: a server plugin, loaded from the directory named in the launch
 * config's `plugins` (`OPENCODE_MODEL_PLUGIN`). The directory, not a file — a
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
 */
const OPENCODE_PLUGIN = `// Written by yaac: reports the model to the pane (see yaac-agent-model).
import { execFile } from 'node:child_process'

const EVENTS = new Set(['session.model.selected', 'session.created', 'session.step.started'])

export default {
  id: 'yaac-model',
  setup(api) {
    const abort = new AbortController()
    let reported
    void (async () => {
      for await (const event of api.event.subscribe({ signal: abort.signal })) {
        const model = EVENTS.has(event.type) ? event.data?.model : undefined
        if (!model) continue
        const id = model.providerID + '/' + model.id
        if (id === reported) continue
        reported = id
        execFile('yaac-agent-model', [id], () => {})
      }
    })().catch(() => {})
    return () => abort.abort()
  },
}
`

const OPENCODE_PLUGIN_NAME = 'yaac-model'

/** Where the launch config points opencode's `plugins`: the plugin's dir in
 *  the opencode config home, which every workspace reaches `$HOME`-relative
 *  (and the launch command's shell expands). */
export const OPENCODE_MODEL_PLUGIN = `$HOME/.config/opencode/${OPENCODE_PLUGIN_NAME}`

/**
 * Write both reporters into a project's tool homes: pi's agent dir (what
 * `PI_CODING_AGENT_DIR` names) and opencode's config dir. Idempotent, and
 * leaves a file that already holds these bytes untouched.
 */
export async function ensureModelReporters(homes: {
  piAgentDir: string
  opencodeConfigDir: string
}): Promise<void> {
  await install(path.join(homes.piAgentDir, 'extensions', 'yaac-model.ts'), PI_EXTENSION)
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
