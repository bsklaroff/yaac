/**
 * The one-shot move of each project's `yaac-config.json` onto its row
 * (docs/legacy-compat-shims.md "A project's yaac-config.json"). Every key
 * the file could hold is a project setting now, so nothing else reads it.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { projectConfigDir } from '@yaac/shared/project-paths'
import { parseStepGraph, type StepGraph } from '@yaac/shared/steps'
import type { ProjectConfig } from '@yaac/shared/types'
import {
  backfillWorkspaceScratchDirs, insertNamedWorkflow, listNamedWorkflows, listProjectRows, setProjectConfig, setProjectScratchDirs,
  storeWorkflow,
} from '#db'
import { workspaceDriver } from '#drivers/driver'
import { errorText, serverLog } from '#lib/log'
import { cacheVolumesSchema, checkoutPathSchema, portForwardsSchema } from './config'

const K8S_ONLY = ['cacheVolumes', 'nestedContainers', 'npmCache'] as const

/**
 * The graph an `initCommands` value ran as: the string form's one `init`
 * window chain becomes one step, and each object form entry a step of its
 * own with no needs, as its window ran beside the others. A window name a
 * step may not take (one with a `.`, or over 48 long) is renamed
 * `init-<name>`, cut to 48 and made unique.
 */
function initCommandsGraph(initCommands: unknown): unknown {
  if (!Array.isArray(initCommands)) return initCommands
  if (initCommands.every((c) => typeof c === 'string')) return initCommands.length > 0 ? { init: { run: initCommands } } : {}
  const taken = new Set<string>()
  return Object.fromEntries(initCommands.map((e: { name?: unknown; commands?: unknown }) => {
    let name = String(e.name)
    if (!stepNameAllowed(name)) {
      const base = `init-${name.replace(/[^A-Za-z0-9_-]/g, '-')}`.slice(0, 48)
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

/** Where a file that did not wholly import is kept, beside where it was:
 *  a value that did not validate may still hold what the user meant, and
 *  the server log is no place for it (an `initCommands` line can export a
 *  token). */
const LEFTOVER_NAME = 'yaac-config.json.unimported'

/** What one project's file holds, validated, before anything is written. */
interface ImportPlan {
  set: Partial<ProjectConfig>
  scratchDirs?: string[]
  initSteps?: StepGraph
  /** The keys left out, each with why. Never a value, which can be a secret. */
  leftOut: string[]
  /** Whether one left out could matter to the user, so the file is kept. */
  keep: boolean
}

function planImport(file: Record<string, unknown>): ImportPlan {
  const plan: ImportPlan = { set: {}, leftOut: [], keep: false }
  const take = (key: string, parse: () => void): void => {
    try {
      parse()
    } catch (err) {
      plan.leftOut.push(`${key} (${err instanceof z.ZodError ? err.issues[0].message : errorText(err)})`)
      plan.keep = true
    }
  }
  const containerless = workspaceDriver().kind === 'containerless'
  for (const [key, value] of Object.entries(file)) {
    // Never in effect on this substrate, so nothing is lost by dropping it.
    if (containerless && (K8S_ONLY as readonly string[]).includes(key)) plan.leftOut.push(`${key} (applies under k8s only)`)
    else if (key === 'portForward') take(key, () => { plan.set.portForwards = portForwardsSchema.parse(value) })
    else if (key === 'cacheVolumes') take(key, () => { plan.set.cacheVolumes = cacheVolumesSchema.parse(value) })
    else if (key === 'nestedContainers' || key === 'npmCache') take(key, () => { plan.set[key] = z.boolean().parse(value) })
    else if (key === 'ephemeralModulesPaths') {
      take(key, () => { plan.scratchDirs = [...new Set(z.array(checkoutPathSchema).parse(value))] })
    } else if (key === 'initCommands') take(key, () => { plan.initSteps = parseStepGraph(initCommandsGraph(value)) })
    else if (key !== 'hideInitPane') {
      plan.leftOut.push(`${key} (not a setting)`)
      plan.keep = true
    }
  }
  return plan
}

/** Write a plan onto the project's row. Safe to run again after a partial
 *  failure: each write sets the same values, and the init workflow is
 *  written once. */
async function applyImport(projectId: string, plan: ImportPlan): Promise<void> {
  if (plan.scratchDirs) {
    await setProjectScratchDirs(projectId, { dirs: plan.scratchDirs.map((p) => ({ path: p })) })
    // Its workspaces running now were started with this list too.
    await backfillWorkspaceScratchDirs(projectId, plan.scratchDirs)
  }
  // Written as an init workflow named `init` (`init-steps` where the
  // project has an `init`, as the migration names one), unless the project
  // has init workflows of its own already, an earlier import's included.
  const flows = await listNamedWorkflows(projectId)
  if (plan.initSteps && !flows.some((w) => w.init)) {
    const taken = new Set(flows.map((w) => w.name))
    const name = ['init', 'init-steps'].find((n) => !taken.has(n)) ?? `init-${projectId.slice(0, 6)}`
    const { id } = await storeWorkflow(projectId, { steps: plan.initSteps, secrets: [] })
    await insertNamedWorkflow(projectId, name, id, true)
  }
  if (Object.keys(plan.set).length > 0) await setProjectConfig(projectId, plan.set)
}

/**
 * Move each project's yaac-config.json onto its row. A file that wholly
 * imported is deleted; one with a key that did not, or that is not a JSON
 * object, is renamed `yaac-config.json.unimported` for the user to recover
 * from, and only the keys and reasons are logged. A failed write leaves the
 * file where it was, so the next start imports it again.
 */
export async function importProjectConfigFiles(): Promise<void> {
  for (const { id } of await listProjectRows()) {
    const file = path.join(projectConfigDir(id), 'yaac-config.json')
    const raw = await fs.readFile(file, 'utf8').catch(() => null)
    if (raw === null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    const plan: ImportPlan = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? planImport(parsed as Record<string, unknown>)
      : { set: {}, leftOut: ['the file (not a JSON object)'], keep: true }
    try {
      await applyImport(id, plan)
    } catch (err) {
      // A database error's own message can quote the query's parameters,
      // which hold the values; the driver's cause names only what failed.
      const why = err instanceof Error && err.cause instanceof Error ? err.cause.message : errorText(err)
      serverLog(`[server] project "${id}": yaac-config.json not imported, retried at next start: ${why}`)
      continue
    }
    const kept = path.join(path.dirname(file), LEFTOVER_NAME)
    const done = plan.keep ? fs.rename(file, kept) : fs.rm(file, { force: true })
    await done.catch((err: unknown) => serverLog(`[server] project "${id}": could not clear yaac-config.json: ${errorText(err)}`))
    if (plan.leftOut.length > 0) {
      serverLog(`[server] project "${id}": yaac-config.json left out ${plan.leftOut.join('; ')}${plan.keep ? `; kept as ${kept}` : ''}`)
    }
  }
}
