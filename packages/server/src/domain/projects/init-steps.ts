/**
 * A project's init steps (docs/workspace-steps.md): the step graph every
 * workspace runs at start unless its create brings its own.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { projectConfigDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { parseStepGraph, type StepGraph } from '@yaac/shared/steps'
import { getProjectRow, listProjectRows, setProjectInitSteps } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { errorText, serverLog } from '#lib/log'
import { assertProjectExists } from './detail'

/** Replace a project's init steps and answer them as stored. */
export async function setInitSteps(principal: Actor, projectId: string, raw: unknown): Promise<StepGraph> {
  await assertProjectExists(projectId)
  await authorizeProject(principal, projectId)
  let graph: StepGraph
  try {
    graph = parseStepGraph(raw)
  } catch (err) {
    throw new ServerError('VALIDATION', `init steps: ${(err as Error).message}`)
  }
  if (!await setProjectInitSteps(projectId, graph)) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  return graph
}

/**
 * The graph an `initCommands` value ran as: the string form's one `init`
 * window chain becomes one step, and each object form entry a step of its
 * own with no needs, as its window ran beside the others. A window name a
 * step may not take (`claude-setup`, `shell`, one over 48 long) is renamed
 * `init-<name>`, cut to 48 and made unique, so the project is not left with
 * a config every create refuses.
 */
function initCommandsGraph(initCommands: unknown): unknown {
  if (!Array.isArray(initCommands)) return initCommands
  if (initCommands.every((c) => typeof c === 'string')) return initCommands.length > 0 ? { init: { run: initCommands } } : {}
  const taken = new Set<string>()
  return Object.fromEntries(initCommands.map((e: { name?: unknown; commands?: unknown }) => {
    let name = String(e.name)
    if (!stepNameAllowed(name)) {
      const base = `init-${name}`.slice(0, 48)
      name = base
      for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 48 - String(i).length - 1)}-${String(i)}`
    }
    taken.add(name)
    return [name, { run: e.commands }]
  }))
}

function stepNameAllowed(name: string): boolean {
  try {
    parseStepGraph({ [name]: { run: 'true' } })
    return true
  } catch {
    return false
  }
}

/**
 * Move an `initCommands` key out of each project's yaac-config.json into its
 * init steps, where the setting now lives, and drop it and `hideInitPane`
 * from the file (docs/legacy-compat-shims.md). Best-effort per project: a
 * file that is not JSON, or a value that does not convert, is left for the
 * user. A project that already has init steps keeps them.
 */
export async function importInitStepsFromConfig(): Promise<void> {
  for (const { id } of await listProjectRows()) {
    const file = path.join(projectConfigDir(id), 'yaac-config.json')
    try {
      const raw = await fs.readFile(file, 'utf8').catch(() => null)
      if (raw === null) continue
      const config: unknown = JSON.parse(raw)
      if (typeof config !== 'object' || config === null || !('initCommands' in config || 'hideInitPane' in config)) continue
      const { initCommands, hideInitPane: _, ...rest } = config as Record<string, unknown>
      const graph = parseStepGraph(initCommandsGraph(initCommands ?? []))
      const row = await getProjectRow(id)
      if (row !== undefined && Object.keys(row.initSteps).length === 0) await setProjectInitSteps(id, graph)
      await fs.writeFile(file, JSON.stringify(rest, null, 2) + '\n')
    } catch (err) {
      serverLog(`[server] initCommands import for project "${id}" failed: ${errorText(err)}`)
    }
  }
}
