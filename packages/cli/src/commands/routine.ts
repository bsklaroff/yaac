import { api, projectScope, resolveProjectId } from '#commands/api'
import { printTable } from '#commands/table'
import { durationOption, promptSource, readPrompt } from '#commands/workspace-create'
import { formatDuration, formatInZone } from '@yaac/shared/schedule'
import { reportDeviceTimeZone } from '@yaac/shared/time-zone-report'
import type { AgentMode, AgentTool, PermissionMode, RoutineEntry, RoutineSettings } from '@yaac/shared/types'

/**
 * `yaac routine …`: workspaces started on a cron schedule (docs/routines.md).
 * Routines are addressed by id or unique id prefix, as workspaces are.
 */

export interface RoutineOptions {
  name?: string
  cron?: string
  /** Each run's prompt; `-` reads it from stdin. */
  prompt?: string
  /** A file to read the prompt from, in place of `prompt`. */
  promptFile?: string
  tz?: string
  /** A duration, or `next` to stop each run at the next tick. */
  timeout?: string
  tool?: AgentTool
  model?: string
  effort?: string
  mode?: AgentMode
  permissionMode?: PermissionMode
  branch?: string
  /** A group name or id; false (`--no-group`) is the default list. */
  group?: string | false
}

export async function routineCreate(project: string, opts: RoutineOptions): Promise<void> {
  const prompt = await promptOf(opts)
  if (opts.name === undefined || opts.cron === undefined || prompt === undefined) {
    throw new Error('A routine needs --name, --cron and --prompt (or --prompt-file).')
  }
  // So a routine that names no zone takes this device's (unless the user
  // pinned one).
  await reportDeviceTimeZone().catch(() => {})
  const routine = await api.routine.create.$post({
    json: { project: await resolveProjectId(project), ...settingsOf(opts), name: opts.name, cron: opts.cron, prompt },
  })
  console.log(`Created routine ${routine.id} ("${routine.name}").`)
  printNextRuns(routine)
}

/** One project's routines, or those of every project in scope. */
export async function routineList(project?: string): Promise<void> {
  const scope = await projectScope()
  const ids = new Set(project ? [await resolveProjectId(project, scope)] : scope.projects.map((p) => p.id))
  const names = new Map(scope.all.map((p) => [p.id, p.name]))
  const routines = (await api.routine.list.$get()).filter((r) => ids.has(r.projectId))
  if (routines.length === 0) {
    console.log(`No routines${project ? ` in project "${project}"` : ''}. Create one with: yaac routine create <project> --name <name> --cron "<expr>" --prompt "<text>"`)
    return
  }
  printTable(
    [
      { header: 'ROUTINE' }, { header: 'PROJECT' }, { header: 'NAME' }, { header: 'CRON' }, { header: 'ZONE' },
      { header: 'NEXT RUN' }, { header: 'LAST RUN', optional: true }, { header: 'STOPS' },
      { header: 'ERROR', optional: true },
    ],
    routines.map((r) => [
      r.id.slice(0, 8),
      names.get(r.projectId) ?? r.projectId,
      r.name,
      r.cron,
      r.timeZone,
      r.paused ? 'paused' : r.nextRuns[0] !== undefined ? formatInZone(new Date(r.nextRuns[0]), r.timeZone) : 'never',
      r.lastRunAt !== undefined ? formatInZone(new Date(r.lastRunAt), r.timeZone) : '',
      r.timeoutMinutes !== undefined ? `after ${formatDuration(r.timeoutMinutes)}` : 'at next run',
      r.lastError ?? '',
    ]),
  )
}

export async function routineEdit(id: string, opts: RoutineOptions): Promise<void> {
  const routine = await findRoutine(id)
  if (opts.tz === undefined) await reportDeviceTimeZone().catch(() => {})
  const prompt = await promptOf(opts)
  const patch = {
    ...settingsOf(opts),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.cron !== undefined ? { cron: opts.cron } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
  }
  if (Object.keys(patch).length === 0) throw new Error('Nothing to change: give an option to edit.')
  const updated = await api.routine.update.$post({ json: { id: routine.id, ...patch } })
  console.log(`Updated routine ${updated.id.slice(0, 8)} ("${updated.name}").`)
  printNextRuns(updated)
}

export async function routinePause(id: string): Promise<void> {
  const routine = await api.routine.pause.$post({ json: { id: (await findRoutine(id)).id } })
  console.log(`Paused routine ${routine.id.slice(0, 8)} ("${routine.name}").`)
}

export async function routineResume(id: string): Promise<void> {
  const routine = await api.routine.resume.$post({ json: { id: (await findRoutine(id)).id } })
  console.log(`Resumed routine ${routine.id.slice(0, 8)} ("${routine.name}").`)
  printNextRuns(routine)
}

export async function routineRun(id: string): Promise<void> {
  const routine = await findRoutine(id)
  const { workspaceId } = await api.routine.run.$post({ json: { id: routine.id } })
  console.log(`Started workspace ${workspaceId} from routine "${routine.name}".`)
}

export async function routineDelete(id: string): Promise<void> {
  const routine = await findRoutine(id)
  await api.routine.delete.$post({ json: { id: routine.id } })
  console.log(`Deleted routine ${routine.id.slice(0, 8)} ("${routine.name}"). Runs already started keep going until their stop time.`)
}

/** The prompt the options give: `--prompt` itself, or what `--prompt -` or
 *  `--prompt-file` reads. */
async function promptOf(opts: RoutineOptions): Promise<string | undefined> {
  const source = promptSource(opts)
  return source !== undefined ? await readPrompt(source) : opts.prompt
}

/** The settings the options name, in the shape the routes take. */
function settingsOf(opts: RoutineOptions): Partial<RoutineSettings> {
  const timeout = opts.timeout === undefined ? undefined
    : opts.timeout.trim().toLowerCase() === 'next' ? null
    : durationOption('--timeout', opts.timeout)
  return {
    ...(opts.tz !== undefined ? { timeZone: opts.tz } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(opts.tool !== undefined ? { tool: opts.tool } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
    ...(opts.group !== undefined ? { group: opts.group === false ? null : opts.group } : {}),
  }
}

/** The routine an id or unique id prefix names, among every routine the
 *  caller can see. */
async function findRoutine(id: string): Promise<RoutineEntry> {
  const token = id.trim().toLowerCase()
  const matches = (await api.routine.list.$get()).filter((r) => r.id.startsWith(token))
  if (matches.length === 1) return matches[0]
  throw new Error(matches.length === 0
    ? `No routine "${id}". Run "yaac routine list" to see them.`
    : `"${id}" matches more than one routine; use a longer prefix.`)
}

function printNextRuns(routine: RoutineEntry): void {
  if (routine.paused) return
  const runs = routine.nextRuns.map((r) => formatInZone(new Date(r), routine.timeZone))
  console.log(runs.length > 0 ? `Next runs (${routine.timeZone}): ${runs.join(', ')}` : 'Its cron never fires again.')
}
