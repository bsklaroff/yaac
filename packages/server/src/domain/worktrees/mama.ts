/**
 * What an in-worktree `yaac-mama` command means — the one place a request
 * from inside a worktree becomes an action.
 *
 * Every transport ends here. The k8s proxy queues opaque envelopes and knows
 * nothing about what any of them mean; the containerless route validates a
 * token and hands the envelope over. So `MAMA_COMMANDS` is the allowlist in
 * the only place it can be enforced for both: a command this switch does not
 * name cannot be run, whichever way it arrived.
 *
 * What a caller may NOT do is as deliberate as what it may. An agent can see
 * the project's worktrees, make another one, retitle one, file them into
 * named groups, and stop one — its own included. Stopping is in reach
 * because in yaac it is REVERSIBLE: `stopWorktree` ends the running unit and
 * keeps the checkout, the row, the title, the group and the conversation, so
 * a user can restart whatever an agent wound down. Deleting, restarting and
 * reconfiguring are not: those destroy work or reshape the install, and stay
 * the user's. An agent that wants one asks for it in prose.
 *
 * The caller is never trusted for its own identity: `MamaCaller` is resolved
 * by the transport (pod source IP under k8s, an opaque per-worktree token
 * under containerless) and every command is scoped to that caller's project.
 */
import { decideSpawn } from './spawn-policy'
import { listActiveWorktrees } from './list'
import { listWorktreeGroups, resolveGroup } from './groups'
import { getProjectWorktreeRows, getWorktreeRow, setWorktreeGroup, setWorktreeTitle } from '#db'
import { resolveWorktreeInProject } from './resolve'
import { stopWorktree } from './stop'
import { ServerError } from '@yaac/shared/errors'
import { loadToolAuthEntry } from '@yaac/shared/tool-auth'
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import {
  AGENT_TOOLS,
  MAMA_COMMANDS,
  type AgentTool,
  type MamaCommand,
  type WorktreeListEntry,
} from '@yaac/shared/types'
import { modelsForTool } from '#domain/auth'

/** Who is asking — resolved by the transport, never taken from the request. */
export interface MamaCaller {
  /** The calling worktree. */
  workspaceId: string
  /** Its project. Every command is scoped to this and nothing else. */
  projectSlug: string
  /** The tool it runs, when the substrate labelled it — the second step of
   *  the spawned worktree's tool precedence. */
  tool?: AgentTool
}

/** One command off the wire: still untyped, because that is how it arrived. */
export interface MamaRequestInput {
  command: string
  args: Record<string, string>
  body: string
}

export type MamaOutcome =
  | { ok: true; output: string }
  | { ok: false; error: string }

/**
 * Longest a group name may be — the store's own cap, which the group routes
 * bound themselves by too. Anything longer is refused rather than accepted
 * and truncated on the way to the table, where two distinct long names
 * sharing their first `MAX_TITLE_LENGTH` characters would resolve to one
 * group and file a worktree into a group nobody named.
 */
const MAX_GROUP_NAME_CHARS = MAX_TITLE_LENGTH

/**
 * Which options each command reads. An option a command does not take is
 * refused rather than ignored, because silently dropping one means the
 * caller's request did something other than what it said — `--group` on a
 * `rename` would look like it worked and file nothing.
 *
 * Here rather than only at the proxy so BOTH transports answer the same way:
 * the proxy shape-checks what it queues, but a containerless worktree posts
 * straight to the route and never passes through it.
 */
const COMMAND_ARGS: Record<MamaCommand, readonly string[]> = {
  list: [],
  create: ['tool', 'model', 'permission-mode', 'mode', 'branch', 'group'],
  rename: ['worktree'],
  stop: ['worktree'],
  'group-create': [],
  'group-move': ['worktree'],
  models: [],
}

/**
 * Run one `yaac-mama` command on behalf of a worktree, and render the answer
 * as the text its stdout gets.
 *
 * Text rather than JSON because the caller is a shell script with no parser
 * and its reader is an agent: a table is what both can use. Errors come back
 * as a value (never a throw) so a transport that is holding a caller's
 * request open always has something to answer with.
 */
export async function runMamaCommand(
  caller: MamaCaller,
  request: MamaRequestInput,
): Promise<MamaOutcome> {
  if (!(MAMA_COMMANDS as readonly string[]).includes(request.command)) {
    return {
      ok: false,
      error: `unknown command '${request.command}' (expected one of: ${MAMA_COMMANDS.join(', ')})`,
    }
  }
  const command = request.command as MamaCommand
  const accepted = COMMAND_ARGS[command]
  // hasOwn-free because these are the caller's own keys against a fixed
  // list, but the same reasoning as the proxy's: a name off a wire must not
  // be able to reach anything it did not send.
  for (const name of Object.keys(request.args)) {
    if (!accepted.includes(name)) {
      return {
        ok: false,
        error: accepted.length === 0
          ? `${command} takes no options (got '--${name}')`
          : `${command} does not take '--${name}' (expected: ${accepted.map((a) => `--${a}`).join(', ')})`,
      }
    }
  }
  try {
    switch (command) {
      case 'list': return await runList(caller)
      case 'create': return await runCreate(caller, request)
      case 'rename': return await runRename(caller, request)
      case 'stop': return await runStop(caller, request)
      case 'group-create': return await runGroupCreate(caller, request)
      case 'group-move': return await runGroupMove(caller, request)
      case 'models': return await runModels(caller)
    }
  } catch (err) {
    // Anything a command threw (a bad group name, an unreachable substrate)
    // is the caller's answer, not the drain's problem.
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** The caller's project, as it would look in the sidebar. */
async function runList(caller: MamaCaller): Promise<MamaOutcome> {
  const [{ worktrees }, groups] = await Promise.all([
    listActiveWorktrees(caller.projectSlug),
    listWorktreeGroups(caller.projectSlug),
  ])
  const names = new Map(groups.map((g) => [g.groupId, g.name]))

  const lines: string[] = []
  if (worktrees.length === 0) {
    lines.push(`No running worktrees in ${caller.projectSlug}.`)
  } else {
    lines.push(`Running worktrees in ${caller.projectSlug}:`, '')
    lines.push(...renderWorktrees(worktrees, names, caller.workspaceId))
  }
  lines.push('')
  lines.push(groups.length === 0
    ? 'No groups yet. Make one with: yaac-mama group create "<name>"'
    : `Groups: ${groups.map((g) => g.name).join(', ')}`)
  return { ok: true, output: lines.join('\n') }
}

function renderWorktrees(
  worktrees: WorktreeListEntry[],
  groupNames: Map<string, string>,
  callerId: string,
): string[] {
  const rows = [...worktrees]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((w) => ({
      // The caller marks its own row: an agent reading this list is usually
      // deciding what to do about the OTHER worktrees.
      id: `${w.worktreeId.slice(0, 8)}${w.worktreeId === callerId ? ' (you)' : ''}`,
      tool: w.tool,
      status: w.status,
      group: w.groupId !== undefined ? groupNames.get(w.groupId) ?? '' : '',
      title: flatten(w.title ?? '', 40),
      prompt: flatten(w.prompt ?? '', 60),
    }))

  const width = (header: string, pick: (r: typeof rows[number]) => string): number =>
    Math.max(header.length, ...rows.map((r) => pick(r).length))
  const idW = width('WORKTREE', (r) => r.id)
  const toolW = width('TOOL', (r) => r.tool)
  const statusW = width('STATUS', (r) => r.status)
  const groupW = width('GROUP', (r) => r.group)
  // `rename` is one of the six commands, so its result has to be readable
  // here — otherwise an agent can retitle a worktree and never see it. Shown
  // only once something has a title, like the CLI's own listings.
  const hasTitles = rows.some((r) => r.title !== '')
  const titleW = hasTitles ? width('TITLE', (r) => r.title) : 0
  const titleCell = (v: string): string => hasTitles ? `${v.padEnd(titleW)}  ` : ''

  return [
    `${'WORKTREE'.padEnd(idW)}  ${'TOOL'.padEnd(toolW)}  ${'STATUS'.padEnd(statusW)}  ${'GROUP'.padEnd(groupW)}  ${titleCell('TITLE')}PROMPT`,
    ...rows.map((r) =>
      `${r.id.padEnd(idW)}  ${r.tool.padEnd(toolW)}  ${r.status.padEnd(statusW)}  ${r.group.padEnd(groupW)}  ${titleCell(r.title)}${r.prompt}`),
  ]
}

function flatten(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

/**
 * Start a sibling worktree in the caller's project. The decision — tool
 * precedence, the posture ceiling, the fan-out cap, the id it gets and the
 * row it provisions under — is `decideSpawn`'s; this resolves the two things
 * it needs from the store: the group name, since a group has to exist before
 * the create can carry it, and the caller's own posture, off its row.
 */
async function runCreate(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const callerRow = await getWorktreeRow(caller.projectSlug, caller.workspaceId)
  // Every running worktree has a row (create writes it before provisioning),
  // so a caller without one has no posture to cap a spawn at — refuse rather
  // than guess one.
  if (!callerRow) return { ok: false, error: 'this worktree has no recorded permission mode' }
  const { args } = request
  const group = args.group
  const groupId = group === undefined
    ? undefined
    : (await resolveGroup(caller.projectSlug, group, { create: true })).groupId

  const decision = await decideSpawn({
    requestId: `mama:${caller.workspaceId}`,
    callerWorkspaceId: caller.workspaceId,
    callerProjectSlug: caller.projectSlug,
    ...(caller.tool !== undefined ? { callerTool: caller.tool } : {}),
    callerPermissionMode: callerRow.permissionMode,
    prompt: request.body,
    ...(args.tool !== undefined ? { tool: args.tool } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args['permission-mode'] !== undefined ? { permissionMode: args['permission-mode'] } : {}),
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
    ...(args.branch !== undefined ? { branch: args.branch } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
  })
  return decision.ok
    // The id alone, so `id=$(yaac-mama create "…")` works — the one output
    // here that a script is likely to capture rather than read.
    ? { ok: true, output: decision.workspaceId }
    : { ok: false, error: decision.error }
}

/**
 * Retitle a worktree — the label the sidebar shows in place of its id.
 *
 * The one command whose most useful target is the CALLER: an agent that has
 * worked out what it is actually doing can say so, and the user reads it
 * without opening the worktree. Naming a sibling works too, and is scoped the
 * same way everything here is.
 */
async function runRename(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const target = await resolveTargetWorktree(caller, request.args.worktree)
  if (!target.ok) return target
  const worktreeId = target.worktreeId

  const title = request.body.trim()
  if (title === '') return { ok: false, error: 'rename needs a title' }
  await setWorktreeTitle(caller.projectSlug, worktreeId, title)
  // Read back rather than echoing the request: the store trims, collapses
  // whitespace and caps the length, so this is what the sidebar will show.
  const stored = (await getProjectWorktreeRows(caller.projectSlug)).get(worktreeId)?.title
  return { ok: true, output: `Renamed ${worktreeId.slice(0, 8)} to "${stored ?? title}".` }
}

/**
 * Which worktree a command that names one is aimed at.
 *
 * Shared by the two commands that take a `--worktree`, so both say "me" the
 * same way: omitted means the caller, which saves an agent looking up an id
 * it would only be using to name itself. Resolution is
 * `resolveWorktreeInProject`'s, so an id from another project simply is not
 * here, and an ambiguous prefix resolves to nothing rather than to whichever
 * row came back first.
 */
async function resolveTargetWorktree(
  caller: MamaCaller,
  worktree: string | undefined,
): Promise<{ ok: true; worktreeId: string } | { ok: false; error: string }> {
  const target = worktree === undefined || worktree.trim() === ''
    ? caller.workspaceId
    : worktree.trim()
  const resolved = await resolveWorktreeInProject(caller.projectSlug, target)
  return resolved.ok
    ? resolved
    : { ok: false, error: worktreeError(caller.projectSlug, target, resolved.reason) }
}

/**
 * What to tell a caller whose worktree argument resolved to nothing.
 *
 * The two failures need different next moves, and behind a destructive verb
 * that difference is the whole message: an unknown id means look again, an
 * ambiguous prefix means the caller already holds the right id and simply
 * did not type enough of it. Answering both with "no worktree" sends an agent
 * back to `list` when it needed one more character.
 */
function worktreeError(
  projectSlug: string,
  target: string,
  reason: 'not-found' | 'ambiguous',
): string {
  return reason === 'ambiguous'
    ? `'${target}' matches more than one worktree in ${projectSlug} — use a longer prefix`
    : `no worktree '${target}' in ${projectSlug}`
}

/**
 * Stop a worktree: the running unit goes, everything that makes it
 * restartable stays.
 *
 * Omitting the worktree stops the CALLER, and that is the case this exists
 * for — a fanned-out worktree that has finished its work winding itself down.
 * The cost is that a self-stop's confirmation is best-effort: the caller is
 * tearing down the very transport its reply rides (its pod under k8s, the
 * tmux server hosting the command under containerless). `stopWorktree`
 * schedules the teardown detached, so this returns and the reply is written
 * before it proceeds — but whether that reaches a worktree being torn down is
 * not something this can promise, which is why the script and the skill both
 * say the worktree ending IS the confirmation.
 */
async function runStop(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const target = await resolveTargetWorktree(caller, request.args.worktree)
  if (!target.ok) return target

  try {
    await stopWorktree(target.worktreeId)
  } catch (err) {
    // `stopWorktree`'s own NOT_FOUND sends the caller to `yaac worktree
    // list`, which an agent does not have. It also means something narrower
    // here than it does at the CLI: the id already resolved against this
    // project's rows, so the worktree exists — it just has no running unit.
    if (err instanceof ServerError && err.code === 'NOT_FOUND') {
      return { ok: false, error: `worktree ${target.worktreeId.slice(0, 8)} is not running` }
    }
    throw err
  }
  return {
    ok: true,
    output: `Stopped ${target.worktreeId.slice(0, 8)}. Its checkout is kept — `
      + 'the user can restart it from the yaac webapp.',
  }
}

async function runGroupCreate(
  caller: MamaCaller,
  request: MamaRequestInput,
): Promise<MamaOutcome> {
  const name = request.body.trim()
  if (name === '') return { ok: false, error: 'group name must not be empty' }
  if (name.length > MAX_GROUP_NAME_CHARS) {
    return { ok: false, error: `group name exceeds ${MAX_GROUP_NAME_CHARS} characters` }
  }
  // Idempotent by construction: naming a group that exists resolves to it
  // rather than making a second one with the same name.
  const group = await resolveGroup(caller.projectSlug, name, { create: true })
  // The resolved name, not the typed one — the group it landed on may have
  // been named slightly differently (case, spacing), and an agent reading
  // this back should see the label the sidebar will show.
  return { ok: true, output: `Group "${group.name}" is ready (${group.groupId}).` }
}

async function runGroupMove(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const worktree = request.args.worktree
  if (worktree === undefined || worktree.trim() === '') {
    return { ok: false, error: 'group move needs a worktree id' }
  }
  // Resolved against the caller's OWN project's rows, which is what scopes
  // the move: a worktree id from another project simply is not here, so there
  // is no cross-project move to refuse separately.
  const found = await resolveWorktreeInProject(caller.projectSlug, worktree.trim())
  if (!found.ok) {
    return { ok: false, error: worktreeError(caller.projectSlug, worktree.trim(), found.reason) }
  }
  const worktreeId = found.worktreeId

  const target = request.body.trim()
  // No group named means the default list, which is how both surfaces say
  // it — `yaac group move` cannot use a bare `--` (its parser eats it as
  // end-of-options), so omitting the argument is the shared idiom. `--` is
  // still honored for anyone who reaches for it.
  const resolved = target === '--' || target === ''
    ? null
    : await resolveGroup(caller.projectSlug, target, { create: true })
  await setWorktreeGroup(caller.projectSlug, worktreeId, resolved?.groupId ?? null)
  return {
    ok: true,
    // The resolved NAME, like the CLI's own line: the ambiguity error tells a
    // caller to pass the group id, and an agent is the caller most likely to
    // take it up — echoing that uuid back is not an answer.
    output: resolved === null
      ? `Moved ${worktreeId.slice(0, 8)} out of its group.`
      : `Moved ${worktreeId.slice(0, 8)} into "${resolved.name}".`,
  }
}

/**
 * Which agent tools this host can actually authenticate, and the model ids
 * each accepts.
 *
 * Answered from the host's own credentials because the server is the host —
 * the one question a worktree genuinely cannot answer for itself, since it
 * holds sentinels (or, containerless, holds the real thing but not the
 * knowledge of what else is configured).
 */
async function runModels(caller: MamaCaller): Promise<MamaOutcome> {
  const entries = await Promise.all(AGENT_TOOLS.map(async (tool) => ({
    tool,
    auth: await loadToolAuthEntry(tool),
  })))

  const lines = [`Agent tools on this host (this worktree runs: ${caller.tool ?? 'unknown'})`, '']
  for (const { tool, auth } of entries) {
    if (!auth) {
      lines.push(`${tool.padEnd(9)} not configured — its agent cannot authenticate`)
      continue
    }
    const provider = 'opencodeProvider' in auth ? auth.opencodeProvider
      : 'piProvider' in auth ? auth.piProvider
      : undefined
    const models = modelsForTool(tool, provider)
      .map((m) => m.name !== undefined ? `${m.id} (${m.name})` : m.id)
    lines.push(`${tool.padEnd(9)} ${auth.kind}${provider ? ` (${provider})` : ''}`)
    if (models.length > 0) lines.push(`          models: ${models.join(', ')}`)
  }
  lines.push('', 'Pass one with: yaac-mama create --tool <tool> --model <model> "<prompt>"')
  return { ok: true, output: lines.join('\n') }
}
