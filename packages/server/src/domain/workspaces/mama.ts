/**
 * Runs in-workspace `yaac-mama` commands. Both transports (the k8s proxy
 * queue and the containerless route) end here, so `MAMA_COMMANDS` is
 * enforced for both.
 *
 * An agent may list the project's workspaces, create or queue one, edit what
 * it queued, retitle, group, and stop one (its own included). Stopping is
 * allowed because it is reversible: the checkout, row and conversations are
 * kept. Deleting, restarting and reconfiguring stay the user's.
 *
 * The caller's identity comes from the transport (pod IP under k8s, a
 * per-workspace token under containerless), never the request, and every
 * command is scoped to the caller's project.
 */
import { decideSpawn, type SpawnRequest } from './spawn-policy'
import { listActiveWorkspaces } from './list'
import { listWorkspaceGroups, resolveGroup } from './groups'
import {
  getProjectWorkspaceRows,
  getWorkspaceRow,
  listQueuedWorkspaceRows,
  setWorkspaceGroup,
  setWorkspaceTitle,
  type QueuedWorkspaceRow,
} from '#db'
import { resolveWorkspace } from './resolve'
import { stopWorkspace } from './stop'
import { queueWorkspace, updateQueuedWorkspace, type QueueRequest } from './queued-workspaces'
import { ServerError } from '@yaac/shared/errors'
import { loadToolAuthEntry } from '@yaac/shared/tool-auth'
import { MAX_TITLE_LENGTH, normalizeTitle } from '@yaac/shared/titles'
import {
  AGENT_MODES,
  AGENT_TOOLS,
  MAMA_COMMANDS,
  MODEL_RE,
  PERMISSION_MODES,
  type AgentMode,
  type AgentTool,
  type PermissionMode,
  type MamaCommand,
  type WorkspaceListEntry,
} from '@yaac/shared/types'
import { modelsForTool } from '#domain/auth'

/** Who is asking — resolved by the transport, never taken from the request. */
export interface MamaCaller {
  /** The calling workspace. */
  workspaceId: string
  /** Its project. Every command is scoped to this and nothing else. */
  projectSlug: string
  /** The tool it runs, if known; used in the spawned workspace's tool
   *  precedence. */
  tool?: AgentTool
}

/** One command as received, not yet validated. */
export interface MamaRequestInput {
  command: string
  args: Record<string, string>
  body: string
}

export type MamaOutcome =
  | { ok: true; output: string }
  | { ok: false; error: string }

/**
 * Longest group name, the store's cap. Longer names are refused rather than
 * truncated, which could merge two distinct names into one group.
 */
const MAX_GROUP_NAME_CHARS = MAX_TITLE_LENGTH

/** The options every command that makes a workspace takes. */
const CREATE_ARGS = ['tool', 'model', 'permission-mode', 'ui-mode', 'branch', 'group', 'title'] as const

/**
 * Options each command accepts. Others are refused rather than ignored, so a
 * request never silently does less than it said. Checked here so both
 * transports behave the same.
 */
const COMMAND_ARGS: Record<MamaCommand, readonly string[]> = {
  list: [],
  create: CREATE_ARGS,
  rename: ['workspace'],
  stop: ['workspace'],
  'group-create': [],
  'group-move': ['workspace'],
  models: [],
  queue: ['parent-workspace', ...CREATE_ARGS],
  'edit-queued': ['queued', 'parent-workspace', ...CREATE_ARGS],
}

/**
 * Legacy option names sent by an older `yaac-mama` still staged in a
 * running workspace, mapped to current ones (docs/legacy-compat-shims.md).
 * The k8s proxy renames them too; this covers the containerless route.
 */
const LEGACY_ARGS = new Map([['worktree', 'workspace'], ['parent-worktree', 'parent-workspace']])

function withLegacyArgsRenamed(args: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(args).map(([name, value]) => [LEGACY_ARGS.get(name) ?? name, value]))
}

/**
 * Run one `yaac-mama` command for a workspace and return the text for its
 * stdout (plain text, since the reader is an agent via a shell script).
 * Errors are returned, never thrown, so the transport always has an answer.
 */
export async function runMamaCommand(
  caller: MamaCaller,
  sent: MamaRequestInput,
): Promise<MamaOutcome> {
  const request = { ...sent, args: withLegacyArgsRenamed(sent.args) }
  if (!(MAMA_COMMANDS as readonly string[]).includes(request.command)) {
    return {
      ok: false,
      error: `unknown command '${request.command}' (expected one of: ${MAMA_COMMANDS.join(', ')})`,
    }
  }
  const command = request.command as MamaCommand
  const accepted = COMMAND_ARGS[command]
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
      case 'queue': return await runQueue(caller, request)
      case 'edit-queued': return await runEditQueued(caller, request)
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** The caller's project, as it would look in the sidebar. */
async function runList(caller: MamaCaller): Promise<MamaOutcome> {
  const [{ workspaces }, groups, queued] = await Promise.all([
    listActiveWorkspaces(caller.projectSlug),
    listWorkspaceGroups(caller.projectSlug),
    listQueuedWorkspaceRows(caller.projectSlug),
  ])
  const names = new Map(groups.map((g) => [g.groupId, g.name]))

  const lines: string[] = []
  if (workspaces.length === 0) {
    lines.push(`No running workspaces in ${caller.projectSlug}.`)
  } else {
    lines.push(`Running workspaces in ${caller.projectSlug}:`, '')
    lines.push(...renderWorkspaces(workspaces, names, caller.workspaceId))
  }
  if (queued.length > 0) {
    lines.push('', 'Queued workspaces (each starts when what it is under is stopped):', '')
    lines.push(...renderQueued(queued, caller.workspaceId))
  }
  lines.push('')
  lines.push(groups.length === 0
    ? 'No groups yet. Make one with: yaac-mama group create "<name>"'
    : `Groups: ${groups.map((g) => g.name).join(', ')}`)
  return { ok: true, output: lines.join('\n') }
}

function renderWorkspaces(
  workspaces: WorkspaceListEntry[],
  groupNames: Map<string, string>,
  callerId: string,
): string[] {
  const rows = [...workspaces]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((w) => ({
      id: `${w.workspaceId.slice(0, 8)}${w.workspaceId === callerId ? ' (you)' : ''}`,
      tool: w.tool,
      status: w.status,
      group: w.groupId !== undefined ? groupNames.get(w.groupId) ?? '' : '',
      title: flatten(w.title ?? '', 40),
      prompt: flatten(w.prompt ?? '', 60),
    }))

  const width = (header: string, pick: (r: typeof rows[number]) => string): number =>
    Math.max(header.length, ...rows.map((r) => pick(r).length))
  const idW = width('WORKSPACE', (r) => r.id)
  const toolW = width('TOOL', (r) => r.tool)
  const statusW = width('STATUS', (r) => r.status)
  const groupW = width('GROUP', (r) => r.group)
  // Titles let an agent see its `rename` results; the column is shown only
  // when some workspace has one.
  const hasTitles = rows.some((r) => r.title !== '')
  const titleW = hasTitles ? width('TITLE', (r) => r.title) : 0
  const titleCell = (v: string): string => hasTitles ? `${v.padEnd(titleW)}  ` : ''

  return [
    `${'WORKSPACE'.padEnd(idW)}  ${'TOOL'.padEnd(toolW)}  ${'STATUS'.padEnd(statusW)}  ${'GROUP'.padEnd(groupW)}  ${titleCell('TITLE')}PROMPT`,
    ...rows.map((r) =>
      `${r.id.padEnd(idW)}  ${r.tool.padEnd(toolW)}  ${r.status.padEnd(statusW)}  ${r.group.padEnd(groupW)}  ${titleCell(r.title)}${r.prompt}`),
  ]
}

/** Queued entries as a tree under the workspace each waits on. */
function renderQueued(rows: QueuedWorkspaceRow[], callerId: string): string[] {
  const children = new Map<string, QueuedWorkspaceRow[]>()
  for (const r of rows) {
    const parent = r.parentQueuedId ?? r.parentWorkspaceId ?? ''
    children.set(parent, [...(children.get(parent) ?? []), r])
  }
  const ids = new Set(rows.map((r) => r.id))
  const lines: string[] = []
  const walk = (parent: string, depth: number): void => {
    for (const r of children.get(parent) ?? []) {
      const status = r.launchWorkspaceId !== undefined ? `launching as ${r.launchWorkspaceId.slice(0, 8)}`
        : r.launchError !== undefined ? `failed: ${flatten(r.launchError, 60)}`
        : 'queued'
      lines.push(`${'  '.repeat(depth + 1)}${r.id.slice(0, 8)}  ${r.tool}  ${status}  ${flatten(r.prompt, 60)}`)
      walk(r.id, depth + 1)
    }
  }
  for (const parent of children.keys()) {
    if (ids.has(parent)) continue
    lines.push(`after ${parent.slice(0, 8)}${parent === callerId ? ' (you)' : ''}:`)
    walk(parent, 0)
  }
  return lines
}

function flatten(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

/**
 * Start a sibling workspace in the caller's project. `decideSpawn` makes the
 * decisions; this supplies the caller's permission mode from its row.
 */
async function runCreate(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const callerRow = await getWorkspaceRow(caller.projectSlug, caller.workspaceId)
  // Without a row there is no permission mode to cap the spawn at.
  if (!callerRow) return { ok: false, error: 'this workspace has no recorded permission mode' }
  const settings = createSettings(request.args)
  if (!settings.ok) return settings

  const decision = await decideSpawn({
    requestId: `mama:${caller.workspaceId}`,
    callerWorkspaceId: caller.workspaceId,
    callerProjectSlug: caller.projectSlug,
    ...(caller.tool !== undefined ? { callerTool: caller.tool } : {}),
    callerPermissionMode: callerRow.permissionMode,
    prompt: request.body,
    ...settings.settings,
  })
  return decision.ok
    // The id alone, so `id=$(yaac-mama create "…")` works.
    ? { ok: true, output: decision.workspaceId }
    : { ok: false, error: decision.error }
}

/**
 * Queue a workspace to start when its parent (a workspace in this project,
 * often the caller itself, or another queued entry) stops. Settings default
 * from the parent; the permission mode is capped at the caller's own.
 */
async function runQueue(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const callerRow = await getWorkspaceRow(caller.projectSlug, caller.workspaceId)
  if (!callerRow) return { ok: false, error: 'this workspace has no recorded permission mode' }
  const parent = request.args['parent-workspace']?.trim() ?? ''
  if (parent === '') return { ok: false, error: 'queue needs --parent-workspace' }
  const settings = createSettings(request.args)
  if (!settings.ok) return settings
  const entry = await queueWorkspace(caller.projectSlug, {
    parent,
    prompt: request.body,
    ...queueFields(settings.settings),
  }, { ceiling: callerRow.permissionMode })
  // The id alone, so `a=$(yaac-mama queue …)` can chain the next one after it.
  return { ok: true, output: entry.id }
}

/**
 * Edit a queued workspace in the caller's project: prompt (an empty body
 * keeps it), settings or parent. The permission mode is capped at the
 * caller's own, as in `queue`, so an agent cannot reuse a higher grant the
 * user gave an entry.
 */
async function runEditQueued(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const callerRow = await getWorkspaceRow(caller.projectSlug, caller.workspaceId)
  if (!callerRow) return { ok: false, error: 'this workspace has no recorded permission mode' }
  const target = request.args.queued?.trim() ?? ''
  if (target === '') return { ok: false, error: 'edit-queued needs a queued workspace id' }
  const rows = await listQueuedWorkspaceRows(caller.projectSlug)
  const exact = rows.find((r) => r.id === target)
  const matches = exact !== undefined ? [exact] : rows.filter((r) => r.id.startsWith(target))
  if (matches.length !== 1) {
    return {
      ok: false,
      error: matches.length === 0
        ? `no queued workspace '${target}' in ${caller.projectSlug}`
        : `'${target}' matches more than one queued workspace in ${caller.projectSlug} — use a longer prefix`,
    }
  }
  const settings = createSettings(request.args)
  if (!settings.ok) return settings
  const parent = request.args['parent-workspace']?.trim()
  const patch: Partial<QueueRequest> = {
    ...(request.body !== '' ? { prompt: request.body } : {}),
    ...(parent !== undefined && parent !== '' ? { parent } : {}),
    ...queueFields(settings.settings),
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'edit-queued needs a new prompt or an option to change' }
  }
  const entry = await updateQueuedWorkspace(matches[0].id, patch, { ceiling: callerRow.permissionMode })
  return {
    ok: true,
    output: `Updated queued workspace ${entry.id.slice(0, 8)}: ${entry.tool} ${entry.model}, `
      + `${entry.permissionMode} — ${flatten(entry.prompt, 60)}`,
  }
}

/** Settings shared by `create`, `queue` and `edit-queued`. */
type CreateSettings = Pick<SpawnRequest, 'tool' | 'model' | 'permissionMode' | 'uiMode' | 'branch' | 'group' | 'title'>

/**
 * Validate the shared create options. The group stays a name, resolved
 * (and created) only after the command's own checks pass, so a refused
 * request creates no group.
 */
function createSettings(
  args: Record<string, string>,
): { ok: true; settings: CreateSettings } | { ok: false; error: string } {
  const { tool, model, branch, group } = args
  const permissionMode = args['permission-mode']
  const uiMode = args['ui-mode']
  if (tool !== undefined && !(AGENT_TOOLS as readonly string[]).includes(tool)) {
    return { ok: false, error: `invalid tool '${tool}' (expected one of: ${AGENT_TOOLS.join(', ')})` }
  }
  if (model !== undefined && !MODEL_RE.test(model)) {
    return { ok: false, error: `invalid model '${model}'` }
  }
  if (permissionMode !== undefined && !(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    return {
      ok: false,
      error: `invalid permission mode '${permissionMode}' (expected one of: ${PERMISSION_MODES.join(', ')})`,
    }
  }
  if (uiMode !== undefined && !(AGENT_MODES as readonly string[]).includes(uiMode)) {
    return { ok: false, error: `invalid ui mode '${uiMode}' (expected one of: ${AGENT_MODES.join(', ')})` }
  }
  if (branch !== undefined && branch.trim() === '') return { ok: false, error: 'branch must not be empty' }
  const title = args.title !== undefined ? normalizeTitle(args.title) : undefined
  if (title === '') return { ok: false, error: 'title must not be empty' }
  return {
    ok: true,
    settings: {
      ...(tool !== undefined ? { tool: tool as AgentTool } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(permissionMode !== undefined ? { permissionMode: permissionMode as PermissionMode } : {}),
      ...(uiMode !== undefined ? { uiMode: uiMode as AgentMode } : {}),
      ...(branch !== undefined ? { branch: branch.trim() } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(title !== undefined ? { title } : {}),
    },
  }
}

/** The same settings in the shape a queue write takes. */
function queueFields({ uiMode, ...rest }: CreateSettings): Partial<QueueRequest> {
  return { ...rest, ...(uiMode !== undefined ? { mode: uiMode } : {}) }
}

/** Retitle a workspace, by default the caller itself. */
async function runRename(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const target = await resolveTargetWorkspace(caller, request.args.workspace)
  if (!target.ok) return target
  const workspaceId = target.workspaceId

  const title = request.body.trim()
  if (title === '') return { ok: false, error: 'rename needs a title' }
  await setWorkspaceTitle(caller.projectSlug, workspaceId, title)
  // Read back the stored (normalized) title.
  const stored = (await getProjectWorkspaceRows(caller.projectSlug)).get(workspaceId)?.title
  return { ok: true, output: `Renamed ${workspaceId.slice(0, 8)} to "${stored ?? title}".` }
}

/**
 * Resolve a `--workspace` argument within the caller's project; omitted
 * means the caller. An ambiguous prefix fails.
 */
async function resolveTargetWorkspace(
  caller: MamaCaller,
  workspace: string | undefined,
): Promise<{ ok: true; workspaceId: string } | { ok: false; error: string }> {
  const target = workspace === undefined || workspace.trim() === ''
    ? caller.workspaceId
    : workspace.trim()
  const resolved = await resolveWorkspace(target, { projectSlug: caller.projectSlug })
  return resolved.ok
    ? resolved
    : { ok: false, error: workspaceError(caller.projectSlug, target, resolved.reason) }
}

/** Distinct messages for an unknown id and an ambiguous prefix, since
 *  they need different fixes. */
function workspaceError(
  projectSlug: string,
  target: string,
  reason: 'not-found' | 'ambiguous',
): string {
  return reason === 'ambiguous'
    ? `'${target}' matches more than one workspace in ${projectSlug} — use a longer prefix`
    : `no workspace '${target}' in ${projectSlug}`
}

/**
 * Stop a workspace, by default the caller (an agent winding itself down
 * after its work). The checkout is kept for restart. A self-stop's reply is
 * best-effort, since the teardown removes the transport it travels on.
 */
async function runStop(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const target = await resolveTargetWorkspace(caller, request.args.workspace)
  if (!target.ok) return target

  try {
    await stopWorkspace(target.workspaceId)
  } catch (err) {
    // The id resolved against rows, so NOT_FOUND here means not running.
    if (err instanceof ServerError && err.code === 'NOT_FOUND') {
      return { ok: false, error: `workspace ${target.workspaceId.slice(0, 8)} is not running` }
    }
    throw err
  }
  return {
    ok: true,
    output: `Stopped ${target.workspaceId.slice(0, 8)}. Its checkout is kept — `
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
  // Idempotent: an existing group of that name is reused.
  const group = await resolveGroup(caller.projectSlug, name, { create: true })
  return { ok: true, output: `Group "${group.name}" is ready (${group.groupId}).` }
}

async function runGroupMove(caller: MamaCaller, request: MamaRequestInput): Promise<MamaOutcome> {
  const workspace = request.args.workspace
  if (workspace === undefined || workspace.trim() === '') {
    return { ok: false, error: 'group move needs a workspace id' }
  }
  const found = await resolveWorkspace(workspace, { projectSlug: caller.projectSlug })
  if (!found.ok) {
    return { ok: false, error: workspaceError(caller.projectSlug, workspace.trim(), found.reason) }
  }
  const workspaceId = found.workspaceId

  const target = request.body.trim()
  // No group (or `--`) means ungrouped.
  const resolved = target === '--' || target === ''
    ? null
    : await resolveGroup(caller.projectSlug, target, { create: true })
  await setWorkspaceGroup(caller.projectSlug, workspaceId, resolved?.groupId ?? null)
  return {
    ok: true,
    output: resolved === null
      ? `Moved ${workspaceId.slice(0, 8)} out of its group.`
      : `Moved ${workspaceId.slice(0, 8)} into "${resolved.name}".`,
  }
}

/**
 * Which agent tools the server has credentials for, and each one's models.
 * A workspace cannot tell this itself.
 */
async function runModels(caller: MamaCaller): Promise<MamaOutcome> {
  const entries = await Promise.all(AGENT_TOOLS.map(async (tool) => ({
    tool,
    auth: await loadToolAuthEntry(tool),
  })))

  const lines = [`Agent tools on this host (this workspace runs: ${caller.tool ?? 'unknown'})`, '']
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
