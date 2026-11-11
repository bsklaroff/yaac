import path from 'node:path'
import { stringify } from 'yaml'
import { ompDir } from '@yaac/shared/project-paths'
import type { AcpEvent } from '@yaac/shared/acp'
import type { AgentStatus, PermissionMode } from '@yaac/shared/types'
import type { ConfinedRoot } from '#lib/confined-fs'
import { asRecord, asString } from '#lib/narrow'
import { scanJsonlForward } from './jsonl'
import { piTranscriptAsAcp } from './pi-acp-replay'
import { openSandboxDir, type SandboxFile } from './sandbox-fs'

/**
 * Launch, settings, status and history for omp
 * (`@oh-my-pi/pi-coding-agent`), a fork of pi verified against 18.18.6.
 *
 * omp reads pi's `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`,
 * which a workspace sets to pi's dirs, so the workspace names omp's agent
 * dir `YAAC_OMP_AGENT_DIR`, and the installed `omp` is a wrapper that hands
 * it over under pi's name and drops pi's session dir
 * (dockerfiles/agent-patches/omp-homes.js says what bypasses it). omp then
 * keeps its logs in its agent dir's `sessions/`, where its acp server looks
 * for a conversation to load.
 *
 * Its session logs keep pi's naming (`<timestamp>_<sessionId>.jsonl`) and
 * message entries, so pi's first-message lookup and history translator read
 * them too. Line 1 is a fixed-size slot holding the conversation's title,
 * which omp generates and rewrites in place.
 */

/**
 * omp's `--approval-mode` for each posture: `write` auto-approves reads and
 * edits in the workspace and asks before shell commands, `always-ask`
 * auto-approves only reads. `plan` adds omp's read-only plan mode on top.
 * `auto` and `read-only` are unreachable (`launchablePermissionMode`).
 */
const APPROVAL_MODES: Record<PermissionMode, string> = {
  bypass: 'yolo',
  auto: 'write',
  'accept-edits': 'write',
  manual: 'always-ask',
  plan: 'always-ask',
  'read-only': 'always-ask',
}

/** The settings overlay yaac writes into omp's agent dir (`ensureOmpSettings`). */
const SETTINGS_FILE = 'yaac.yml'

/**
 * Settings every launch loads over the user's own `config.yml`: no setup
 * wizard (it would hold the first launch on a provider login), and no
 * update, marketplace or issue-report traffic. No auto-update either, which
 * would also relink `bin/omp` past yaac's wrapper.
 */
const SETTINGS = {
  startup: { setupWizard: false, checkUpdate: false },
  update: { auto: false },
  marketplace: { autoUpdate: 'off' },
  dev: { autoqa: false },
}

/**
 * omp's flags for a launch, in either mode (`omp` or `omp acp`): the
 * settings overlay, the posture's approval mode, and the model and thinking
 * level when given. Plan mode is not a flag: yaac's extension puts a `tui`
 * conversation in it (`OMP_PLAN_VAR`), and an `acp` one is sent it as a
 * session mode.
 */
export function ompLaunchArgs(mode: PermissionMode, model?: string, effort?: string): string[] {
  return [
    `--config "$YAAC_OMP_AGENT_DIR/${SETTINGS_FILE}"`,
    `--approval-mode ${APPROVAL_MODES[mode]}`,
    ...(model !== undefined && model !== '' ? [`--model ${model}`] : []),
    ...(effort !== undefined ? [`--thinking ${effort}`] : []),
  ]
}

/**
 * The variable a `tui` launch sets to `1` when its posture is `plan`, else
 * `0`. yaac's extension then enters or leaves omp's plan mode as each
 * conversation starts, a resumed one included, since omp restores the mode
 * a conversation last had. Unset (omp started by hand), it does nothing.
 */
export const OMP_PLAN_VAR = 'YAAC_OMP_PLAN'

/** Write the settings overlay into a project's omp home (opened with
 *  `openSandboxDir`). Idempotent; an unchanged file is not rewritten. */
export async function ensureOmpSettings(home: ConfinedRoot): Promise<void> {
  const content = `# Written by yaac and loaded by its omp launches (--config).\n${stringify(SETTINGS)}`
  const current = await home.readFile(`agent/${SETTINGS_FILE}`, { maxBytes: 64 * 1024 }).catch(() => null)
  if (current?.toString('utf8') !== content) await home.writeAtomic(`agent/${SETTINGS_FILE}`, content)
}

/**
 * The posture an omp mode change amounts to, given the session's current
 * posture, as yaac's extension reports it (`plan` or `default`). Plan mode
 * changes only the mode; the approval mode comes from the launch. `plan`
 * and `manual` share `always-ask`, so entering and leaving plan mode moves
 * between them, and leaving it under any other posture is that posture.
 * Plan mode over a looser approval mode maps to nothing. Like
 * `opencodePermissionMode`, `current` stands in for the launch posture.
 */
export function ompPermissionMode(mode: string, current: PermissionMode): PermissionMode | undefined {
  const askToAct = current === 'plan' || current === 'manual'
  if (mode === 'default') return askToAct ? 'manual' : current
  if (mode === 'plan') return askToAct ? 'plan' : undefined
  return undefined
}

/**
 * The pane option yaac's extension sets to `pending` as omp loads it and to
 * `drawn` at omp's first message (`message_start`), which is when it draws
 * the opening one. Launched with an opening message, omp shows its busy
 * title from boot, seconds before that, and starts its run (`agent_start`)
 * most of a second before it. So only its idle title passes while this is
 * `pending` (`OMP_STATUS_FORMAT`); read sooner, the session would stop
 * showing as opening over a terminal still blank. omp shows that idle title
 * only once the opening message has been dispatched, including when omp
 * refuses it before drawing it (no model, no API key), so the session stops
 * showing as opening over that error too. An omp running an older extension
 * never sets the option, and its title passes as it is.
 */
export const OMP_FIRST_MESSAGE_OPTION = '@yaac-omp-first-message'

/** The tmux format omp's status watcher subscribes to: its title, or
 *  nothing (`waiting`) for any but its idle `π >` title while
 *  `OMP_FIRST_MESSAGE_OPTION` is `pending`. */
export const OMP_STATUS_FORMAT = `#{?#{&&:#{==:#{${OMP_FIRST_MESSAGE_OPTION}},pending},#{!=:#{=3:pane_title},π >}},,#{pane_title}}`

/**
 * Classify an omp pane title (`OMP_STATUS_FORMAT`). omp titles the pane
 * `π > <dir>` when idle and puts a braille spinner frame in place of the `>`
 * during a turn.
 */
export function classifyOmpTitle(title: string): AgentStatus {
  return /^π [⠀-⣿]/.test(title.trim()) ? 'running' : 'waiting'
}

/** Whether a status value is omp's own title rather than the format's
 *  empty hold or the pane's default title. */
export function ompTitleShown(title: string): boolean {
  return title.trim().startsWith('π ')
}

/** The title omp gave a conversation, from its log's first line, or
 *  undefined while it has none. */
export async function getOmpSessionTitle(file: SandboxFile): Promise<string | undefined> {
  const title = await scanJsonlForward(file, (entry) => {
    const e = asRecord(entry)
    return e?.type === 'title' ? asString(e.title) ?? '' : ''
  })
  return title?.trim() || undefined
}

/** A reference to an image omp stored apart from its log, as it appears there. */
const BLOB_REF = /"blob:sha256:([a-f0-9]{64})"/g

/**
 * A conversation's history from omp's session log, through pi's translator.
 * omp stores each image (a pasted one, or one a tool returned) in its agent
 * dir's `blobs/<sha256>` and leaves a `blob:sha256:<hash>` reference in the
 * log, so each is put back as base64 first, as pi's log holds images. The
 * images together may add as much as the log's own read cap (`maxBytes`);
 * past that, or for a blob that is gone, the reference stays and the image
 * is not shown.
 */
export async function ompTranscriptAsAcp(projectId: string, raw: string, maxBytes: number): Promise<AcpEvent[]> {
  const hashes = new Set([...raw.matchAll(BLOB_REF)].map((m) => m[1]))
  if (hashes.size === 0) return piTranscriptAsAcp(raw)
  const blobs = await openSandboxDir(projectId, path.join(ompDir(projectId), 'agent', 'blobs')).catch(() => null)
  const base64 = new Map<string, string>()
  let budget = maxBytes
  for (const hash of hashes) {
    const bytes = await blobs?.readFile(hash, { maxBytes: budget }).catch(() => null)
    if (bytes === null || bytes === undefined) continue
    budget -= bytes.length
    base64.set(hash, bytes.toString('base64'))
  }
  return piTranscriptAsAcp(raw.replace(BLOB_REF, (ref, hash: string) => {
    const data = base64.get(hash)
    return data === undefined ? ref : `"${data}"`
  }))
}
