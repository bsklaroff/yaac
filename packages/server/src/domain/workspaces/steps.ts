/**
 * A workspace's steps (docs/workspace-steps.md): the graph each life starts
 * with, steps added while it runs, and the reconcile pass that opens a
 * window for each step whose needs are met, records how each one ends, and
 * stops a non-interactive workspace once its graph settles.
 */
import { workspaceDriver } from '#drivers/driver'
import { KEEPER_WINDOW, type RuntimeSnapshot, type WorkspaceWindow } from '#drivers/contract'
import path from 'node:path'
import { authorizeProject, systemPrincipal, type Actor } from '#domain/access'
import { assertWorkflowRepos, projectRepoIds, resolveWorkflow } from '#domain/projects'
import {
  applyWorkspaceEvent,
  findWorkspaceRow,
  getSiteRow,
  getVolumeRow,
  getWorkflow,
  insertAddedSteps,
  listWorkspaceRepos,
  listWorkspaceSteps,
  resetSteps,
  storeWorkflow,
  type StepKey,
  type StepRow,
  type WorkspaceRow,
} from '#db'
import { isWorkspaceTerminating, readWorkspaceWindows } from '#runtime/status'
import { killStepWindowExec, stepScript, stepWindowExec } from '#runtime/terminals'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import {
  findCycle,
  fullNeed,
  lifeDirName,
  parseStepGraph,
  stepFullName,
  stepSatisfiesNeeds,
  stepSettled,
  type StepGraph,
  type StepState,
  type WorkspaceStep,
} from '@yaac/shared/steps'
import { inFlightWorkspaceIds } from './provisioning'
import { openTerminalLogs } from './life'
import { claiming } from './prewarm'
import { resolveWorkspaceContainer } from './resolve'
import { stopWorkspace } from './stop'
import { VOLUME_MOUNT_PATH } from './volumes'

/** How long an opened step window may go unlisted before it counts as
 *  killed. */
const LAUNCH_GRACE_MS = 60_000

/**
 * The step a site release's graph names in `needs` for the site's volume
 * (docs/public-sites.md "Volumes: a staged handoff"). It is no step of its
 * own: it counts as succeeded once the release holds the volume's lease.
 */
export const VOLUME_NEED = 'volume'

/** How soon a release's service that exited is opened again: doubling from
 *  the first, up to the last, and back to the first once it ran a while. */
const SERVICE_RESTART_FIRST_MS = 1000
const SERVICE_RESTART_MAX_MS = 5 * 60_000
const SERVICE_RESTART_RESET_MS = 10 * 60_000

let releaseStepListener: (() => void) | null = null

/**
 * Register what runs when a step of a site release changes state, which the
 * composition root wires to a `sites` reconcile pass. A deploy flips once
 * its release's steps are ready, and this step records that after `sites`
 * has run in the same pass, so without a further pass the flip would wait
 * for the next resync.
 */
export function onReleaseStepChanged(fn: () => void): void {
  releaseStepListener = fn
}

/** Each release service's restarts in a row and the earliest it may open
 *  again, by workspace and step. In memory: a server restart only resets
 *  the backoff. */
const serviceRestarts = new Map<string, { count: number; notBefore: number }>()

/**
 * Refuse a change to a workspace nobody may touch while it runs, only stop:
 * a non-interactive one (docs/workspace-steps.md "Non-interactive
 * workspaces"), and a public site's release (docs/public-sites.md), which
 * only its site's routes manage. A `forward` into a release is let through,
 * since the one port a release offers is its site's admin port
 * (`offeredForwards`).
 */
export async function assertInteractive(workspaceId: string, opts: { forward?: boolean } = {}): Promise<void> {
  const row = await findWorkspaceRow(workspaceId)
  if (row?.nonInteractive === true && row.stepsOutcome === undefined && row.stoppedAt === undefined) {
    throw new ServerError('CONFLICT', `workspace ${workspaceId.slice(0, 8)} is non-interactive: `
      + 'nothing can change it while it runs, but it can be stopped')
  }
  if (row?.siteId !== undefined && row.stoppedAt === undefined && opts.forward !== true) {
    throw new ServerError('CONFLICT', `workspace ${workspaceId.slice(0, 8)} is a site's release: `
      + 'nothing can change it while it runs; manage it with `yaac site`')
  }
}

/** A step's full name, `<workflow>.<step>`, which names its window and
 *  its log; the bare name for a row of a life started before steps had
 *  workflows (docs/legacy-compat-shims.md). */
export const stepName = (row: StepKey): string => stepFullName(row.workflowName, row.name)

/**
 * A step's needs as the full names of the steps of its life they wait on,
 * among `known`: a bare need names a step of its own workflow, else a
 * step of an old life known by its bare name, or `volume`.
 */
function needsOf(row: Pick<StepRow, 'workflowName' | 'spec'>, known: { has: (name: string) => boolean }): string[] {
  return (row.spec.needs ?? []).map((n) => {
    const full = fullNeed(row.workflowName, n)
    return known.has(full) || !known.has(n) ? full : n
  })
}

/** A step as the API answers it, with the window the webapp opens while it
 *  runs. */
export function toStepEntry(row: StepRow, windows?: WorkspaceWindow[]): WorkspaceStep & { target?: string } {
  const name = stepName(row)
  const window = row.state === 'running' || row.state === 'ready' || row.exitCode !== undefined
    ? windows?.find((w) => w.name === name)
    : undefined
  return {
    name,
    workflow: row.workflowName,
    origin: row.origin,
    spec: row.spec,
    state: row.state,
    ...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
    life: row.life.toISOString(),
    ...(row.startedAt !== undefined ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.readyAt !== undefined ? { readyAt: row.readyAt.toISOString() } : {}),
    ...(row.finishedAt !== undefined ? { finishedAt: row.finishedAt.toISOString() } : {}),
    ...(window !== undefined ? { target: `window:${window.id}` } : {}),
  }
}

/** A running workspace, its row and its current life's steps. */
interface LiveWorkspace {
  projectId: string
  workspaceId: string
  jobName: string
  row: WorkspaceRow
  life: Date
  steps: StepRow[]
}

/** A running workspace's current life and its steps, or undefined when it
 *  has none running. */
async function liveWorkspace(p: { projectId: string; workspaceId: string; jobName: string }): Promise<LiveWorkspace | undefined> {
  const row = await findWorkspaceRow(p.workspaceId)
  const life = row?.lifeStartedAt
  if (row === undefined || life === undefined) return undefined
  // A stop record older than the life is one a restart failed to clear.
  if (row.stoppedAt !== undefined && row.stoppedAt >= life) return undefined
  const steps = (await listWorkspaceSteps(p.workspaceId)).filter((s) => s.life.getTime() === life.getTime())
  return { ...p, row, life, steps }
}

/**
 * Add steps to a running workspace (docs/workspace-steps.md): a named
 * workflow's current graph under its name, refused when the workspace lacks
 * a repo it names or already runs it in this life; or a graph of its own,
 * stored as a workflow with `repos` (folders or ids) and named `_added-N`
 * (`nextAdded`). A bare need of such a graph that names none of its steps
 * names a step of the life, while only one workflow has a step of that
 * name, and is stored in full. A `<workflow>.<step>` need must name a step
 * of the life. Answers with the new steps; they start once their needs are
 * met.
 */
export async function addSteps(
  principal: Actor,
  idOrPrefix: string,
  add: { steps: unknown; repos?: string[] } | { workflow: string },
): Promise<WorkspaceStep[]> {
  const workspace = await resolveWorkspaceContainer(idOrPrefix, { requireRunning: true, owner: principal })
  await assertInteractive(workspace.workspaceId)
  const live = await liveWorkspace(workspace)
  if (live === undefined) throw new ServerError('CONFLICT', `workspace ${workspace.workspaceId.slice(0, 8)} is not running`)
  const have = (await listWorkspaceRepos(live.workspaceId)).map((c) => c.repoId)
  let workflow: { id: string; name: string; steps: StepGraph }
  let added: number | undefined
  if ('workflow' in add) {
    const named = await resolveWorkflow(live.projectId, add.workflow)
    if (live.steps.some((s) => s.workflowName === named.name)) {
      throw new ServerError('CONFLICT', `workflow "${named.name}" already runs in this workspace`)
    }
    await assertWorkflowRepos(live.projectId, `workflow "${named.name}"`, named.workflow.repos, have)
    workflow = { id: named.workflow.id, name: named.name, steps: named.workflow.steps }
  } else {
    const repos = await projectRepoIds(live.projectId, add.repos ?? [])
    await assertWorkflowRepos(live.projectId, 'these steps', repos, have)
    let graph: StepGraph
    try {
      graph = parseStepGraph(resolveBareNeeds(add.steps, live.steps), new Set(live.steps.filter((s) => s.workflowName === '').map((s) => s.name)))
    } catch (err) {
      throw new ServerError('VALIDATION', (err as Error).message)
    }
    const stored = await storeWorkflow(live.projectId, { steps: graph, secrets: [], repos })
    added = await nextAdded(live.workspaceId)
    workflow = { id: stored.id, name: `${ADDED}${added}`, steps: graph }
  }
  if (Object.keys(workflow.steps).length === 0) throw new ServerError('VALIDATION', 'no steps to add')
  checkPlacement(workflow.name, workflow.steps, live.steps)
  let rows: StepRow[] | undefined
  while (rows === undefined) {
    try {
      rows = await insertAddedSteps(live.projectId, live.workspaceId, live.life, { id: workflow.id, name: workflow.name }, workflow.steps)
    } catch (err) {
      if (added === undefined || !(err instanceof ServerError && err.code === 'CONFLICT')) throw err
      added += 1
      workflow.name = `${ADDED}${added}`
    }
  }
  await reconcileOne(workspace)
  return rows.map((r) => toStepEntry(r))
}

/** The prefix of the name a workflow added with no name of its own gets. A
 *  chosen name never starts with `_` (docs/workspace-steps.md). */
const ADDED = '_added-'

/**
 * The number for the next workflow added to a workspace with no name of
 * its own: one past the highest of any of its lives, so a name never
 * repeats in its history. An add racing this one can pick the same number,
 * which `insertAddedSteps` refuses, so `addSteps` tries the next.
 */
async function nextAdded(workspaceId: string): Promise<number> {
  const taken = (await listWorkspaceSteps(workspaceId))
    .map((s) => s.workflowName.startsWith(ADDED) ? Number(s.workflowName.slice(ADDED.length)) : 0)
  return Math.max(0, ...taken.filter(Number.isSafeInteger)) + 1
}

/** A graph given to `addSteps` with each bare need that names none of its
 *  steps resolved to the one step of the life so named. */
function resolveBareNeeds(raw: unknown, steps: StepRow[]): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const own = new Set(Object.keys(raw))
  return Object.fromEntries(Object.entries(raw).map(([name, step]) => {
    const needs: unknown = (step as { needs?: unknown } | null)?.needs
    if (!Array.isArray(needs)) return [name, step]
    return [name, { ...(step as object), needs: needs.map((n: unknown) => {
      if (typeof n !== 'string' || n.includes('.') || own.has(n)) return n
      const matches = steps.filter((s) => s.name === n && s.workflowName !== '')
      if (matches.length > 1) {
        throw new ServerError('VALIDATION', `step "${name}" needs "${n}", which several workflows have: `
          + `${matches.map(stepName).join(', ')}; give its full name`)
      }
      return matches.length === 1 ? stepName(matches[0]) : n
    }) }]
  }))
}

/** Refuse a workflow whose needs name no step of the life, or that closes
 *  a cycle with the steps already in it. */
function checkPlacement(workflow: string, graph: StepGraph, steps: StepRow[]): void {
  const known = new Set([...steps.map(stepName), ...Object.keys(graph).map((n) => stepFullName(workflow, n)), VOLUME_NEED])
  const full: Record<string, string[]> = {}
  for (const s of steps) full[stepName(s)] = needsOf(s, known)
  for (const [name, spec] of Object.entries(graph)) {
    const needs = needsOf({ workflowName: workflow, spec }, known)
    const missing = needs.find((n) => !known.has(n))
    if (missing !== undefined) throw new ServerError('VALIDATION', `step "${name}" needs "${missing}", which is not a step of this workspace`)
    full[stepFullName(workflow, name)] = needs
  }
  const cycle = findCycle(full)
  if (cycle !== undefined) throw new ServerError('VALIDATION', `steps form a cycle: ${cycle.join(' -> ')}`)
}

/**
 * A running workspace's step of this life, for a request about it: by its
 * full name, or by its bare name while only one workflow of the life has a
 * step so named.
 */
async function ownedStep(principal: Actor, idOrPrefix: string, name: string): Promise<{ live: LiveWorkspace; step: StepRow }> {
  const workspace = await resolveWorkspaceContainer(idOrPrefix, { requireRunning: true, owner: principal })
  await assertInteractive(workspace.workspaceId)
  const live = await liveWorkspace(workspace)
  const step = live !== undefined ? findStep(live.steps, name) : undefined
  if (live === undefined || step === undefined) {
    throw new ServerError('NOT_FOUND', `workspace ${workspace.workspaceId.slice(0, 8)} has no step "${name}"`)
  }
  return { live, step }
}

/**
 * The step of `steps` a command names: by its full name, or by its bare
 * name while only one workflow has a step so named. Refused when the bare
 * name is ambiguous.
 */
export function findStep<T extends StepRow>(steps: T[], name: string): T | undefined {
  const exact = steps.find((s) => stepName(s) === name)
  if (exact !== undefined || name.includes('.')) return exact
  const matches = steps.filter((s) => s.name === name)
  if (matches.length > 1) {
    throw new ServerError('VALIDATION', `"${name}" is a step of several workflows: ${matches.map(stepName).join(', ')}; `
      + 'give its full name')
  }
  return matches[0]
}

/**
 * Run a settled step again, with the steps it caused to be skipped. Its
 * window and log start over.
 */
export async function rerunStep(principal: Actor, idOrPrefix: string, name: string): Promise<WorkspaceStep> {
  const { live, step } = await ownedStep(principal, idOrPrefix, name)
  const full = stepName(step)
  if (!stepSettled(step.state)) throw new ServerError('CONFLICT', `step "${full}" is ${step.state}; only a finished step reruns`)
  const known = new Set(live.steps.map(stepName))
  const names = new Set([full])
  for (let grew = true; grew;) {
    grew = false
    for (const s of live.steps) {
      if (names.has(stepName(s)) || s.state !== 'skipped' || !needsOf(s, known).some((n) => names.has(n))) continue
      names.add(stepName(s))
      grew = true
    }
  }
  await resetSteps(live.workspaceId, live.life, live.steps.filter((s) => names.has(stepName(s))))
  await reconcileOne(live)
  return toStepEntry((await liveWorkspace(live))?.steps.find((s) => stepName(s) === full) ?? step)
}

/** Stop a step that has not settled: kill its window, if it has one. The
 *  steps that need it are skipped. */
export async function cancelStep(principal: Actor, idOrPrefix: string, name: string): Promise<void> {
  const { live, step } = await ownedStep(principal, idOrPrefix, name)
  const full = stepName(step)
  if (stepSettled(step.state)) throw new ServerError('CONFLICT', `step "${full}" has already ${step.state === 'interrupted' ? 'been interrupted' : step.state}`)
  await changeStep(live, step, 'cancelled')
  const runtime = workspaceDriver()
  await runtime.exec(live.jobName, killStepWindowExec(full, runtime.workspacePaths(live.jobName)), { maxAttempts: 1 })
  await reconcileOne(live)
}

async function changeStep(live: LiveWorkspace, step: StepKey, state: StepState, exitCode?: number): Promise<void> {
  await applyWorkspaceEvent({
    type: 'step-changed',
    projectId: live.projectId,
    workspaceId: live.workspaceId,
    life: live.life,
    workflowName: step.workflowName,
    name: step.name,
    state,
    ...(exitCode !== undefined ? { exitCode } : {}),
  })
  if (live.row.siteId !== undefined) releaseStepListener?.()
}

/**
 * Bring every running workspace's steps up to date: record the steps whose
 * windows exited, became ready or were killed, skip those a failed step
 * blocks, open a window for each one whose needs are met, and stop a
 * non-interactive workspace whose graph has settled.
 *
 * Skips the workspaces a create or claim is still setting up, and any
 * whose setup has not finished (its keeper is not yet `KEEPER_WINDOW`).
 */
export async function reconcileSteps(view: RuntimeSnapshot): Promise<void> {
  const busy = new Set(inFlightWorkspaceIds(Date.now()))
  const listed = await view.workspaces()
  const present = new Set(listed.map((p) => p.workspaceId))
  for (const key of serviceRestarts.keys()) {
    if (!present.has(key.slice(0, key.indexOf('/')))) serviceRestarts.delete(key)
  }
  const running = listed.filter((p) => p.running && !p.prewarmed && !p.terminating
    && !claiming.has(p.jobName) && !busy.has(p.workspaceId) && !isWorkspaceTerminating(p.workspaceId))
  await Promise.all(running.map(async (p) => {
    try {
      await reconcileOne(p)
    } catch (err) {
      serverLog(`[server] steps ${p.workspaceId}: ${String(err)}`)
    }
  }))
}

/** One pass per workspace at a time; a pass asked for during one runs
 *  again after it, since what it read may be stale. */
const passes = new Map<string, { again: boolean; done: Promise<void> }>()

async function reconcileOne(p: { projectId: string; workspaceId: string; jobName: string }): Promise<void> {
  const current = passes.get(p.workspaceId)
  if (current !== undefined) {
    current.again = true
    return await current.done
  }
  const pass = { again: true, done: Promise.resolve() }
  pass.done = (async () => {
    try {
      while (pass.again) {
        pass.again = false
        await reconcilePass(p)
      }
    } finally {
      passes.delete(p.workspaceId)
    }
  })()
  passes.set(p.workspaceId, pass)
  await pass.done
}

async function reconcilePass(p: { projectId: string; workspaceId: string; jobName: string }): Promise<void> {
  const windows = readWorkspaceWindows(p.projectId, p.workspaceId)
  if (windows?.some((w) => w.name === KEEPER_WINDOW) !== true) return
  const live = await liveWorkspace(p)
  if (live === undefined || live.steps.length === 0) return
  const states = new Map(live.steps.map((s) => [stepName(s), s.state]))
  const listed = new Map(windows.map((w) => [w.name, w]))
  const now = Date.now()
  const release = live.row.siteId !== undefined
  // Only the release serving its site restarts its services; in a deploy's
  // new one, a service that exits fails the deploy at once.
  const serving = release && (await getSiteRow(live.row.siteId ?? ''))?.liveWorkspaceId === live.workspaceId
  const volume = release && live.row.volumeId !== undefined ? await getVolumeRow(live.row.volumeId) : undefined
  if (volume !== undefined) states.set(VOLUME_NEED, volume.holderWorkspaceId === live.workspaceId ? 'succeeded' : 'pending')
  const needs = new Map(live.steps.map((s) => [stepName(s), needsOf(s, states)]))
  const restarted = new Set<string>()

  for (const s of live.steps) {
    if (s.state !== 'running' && s.state !== 'ready') continue
    const name = stepName(s)
    const w = listed.get(name)
    let next: StepState | undefined
    // A serving release keeps serving: its service that exits opens again
    // after a backoff, with its log kept, rather than failing.
    if (w?.dead === true && serving && s.spec.service === true) {
      const key = `${live.workspaceId}/${name}`
      const ranMs = s.startedAt !== undefined ? now - s.startedAt.getTime() : 0
      const count = ranMs > SERVICE_RESTART_RESET_MS ? 0 : (serviceRestarts.get(key)?.count ?? 0)
      const delay = Math.min(SERVICE_RESTART_MAX_MS, SERVICE_RESTART_FIRST_MS * 2 ** count)
      serviceRestarts.set(key, { count: count + 1, notBefore: now + delay })
      serverLog(`[server] steps ${live.workspaceId}: service "${name}" exited (${String(w.exitStatus)}); `
        + `restarting in ${String(Math.round(delay / 1000))}s`)
      await resetSteps(live.workspaceId, live.life, [s])
      states.set(name, 'pending')
      restarted.add(name)
      setTimeout(() => { void reconcileOne(live).catch(() => {}) }, delay).unref()
      continue
    }
    if (w?.dead === true) next = s.spec.service !== true && w.exitStatus === 0 ? 'succeeded' : 'failed'
    else if (w !== undefined && w.ready === true && s.state === 'running' && s.spec.service === true) next = 'ready'
    else if (w === undefined && (s.startedAt === undefined || now - s.startedAt.getTime() > LAUNCH_GRACE_MS)) next = 'cancelled'
    if (next === undefined) continue
    states.set(name, next)
    await changeStep(live, s, next, next === 'succeeded' || next === 'failed' ? w?.exitStatus : undefined)
  }

  // Skipping one step can block another, so repeat until nothing changes. A
  // need on no step of the life (an init workflow that did not start) blocks.
  for (let changed = true; changed;) {
    changed = false
    for (const s of live.steps) {
      const name = stepName(s)
      if (states.get(name) !== 'pending') continue
      const blocked = (needs.get(name) ?? []).some((n) => {
        const state = states.get(n)
        return state === undefined || (stepSettled(state) && !stepSatisfiesNeeds(state))
      })
      if (!blocked) continue
      states.set(name, 'skipped')
      await changeStep(live, s, 'skipped')
      changed = true
    }
  }

  const ready = live.steps.filter((s) => states.get(stepName(s)) === 'pending'
    && (needs.get(stepName(s)) ?? []).every((n) => stepSatisfiesNeeds(states.get(n) ?? 'pending'))
    && (serviceRestarts.get(`${live.workspaceId}/${stepName(s)}`)?.notBefore ?? 0) <= now)
  if (ready.length > 0) {
    const runtime = workspaceDriver()
    const paths = runtime.workspacePaths(live.jobName)
    const dir = lifeDirName(live.life)
    const logs = await openTerminalLogs(live.projectId, live.workspaceId)
    const checkouts = await listWorkspaceRepos(live.workspaceId)
    // Only the steps that wait on the volume are told where it is, so the
    // ones before the handoff leave it to the release still holding it.
    const usesVolume = volume !== undefined ? volumeUsers(live.steps) : new Set<string>()
    for (const s of ready) {
      const name = stepName(s)
      const inside = `${paths.terminalLogDir}/${dir}/${name}`
      const env = usesVolume.has(name) && volume !== undefined
        ? [`YAAC_VOLUME_DIR=${VOLUME_MOUNT_PATH}`, `YAAC_VOLUME_NAME=${volume.name}`]
        : []
      try {
        // A restarted service appends to its log, so its crash stays above.
        const restart = serviceRestarts.has(`${live.workspaceId}/${name}`) && !restarted.has(name)
        for (const ext of restart ? [] : ['log', 'log.1', 'events']) {
          await logs.removeTree(`${dir}/${name}.${ext}`).catch((err: unknown) => {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          })
        }
        const cwd = await stepDir(s, paths.workspaceDir, checkouts)
        await logs.writeAtomic(`${dir}/${name}.sh`, stepScript(name, s.spec, `${inside}.events`, env, cwd))
        await runtime.exec(live.jobName, stepWindowExec(name, paths, `${inside}.sh`), { maxAttempts: 1 })
      } catch (err) {
        serverLog(`[server] steps ${live.workspaceId}: opening "${name}" failed: ${String(err)}`)
        states.set(name, 'failed')
        await changeStep(live, s, 'failed')
        continue
      }
      states.set(name, 'running')
      await changeStep(live, s, 'running')
    }
  }

  if (live.row.nonInteractive && live.row.stepsOutcome === undefined) {
    const tasks = live.steps.filter((s) => s.spec.service !== true)
    if (tasks.every((s) => stepSettled(states.get(stepName(s)) ?? 'pending'))) {
      const outcome = live.steps.every((s) => {
        const state = states.get(stepName(s))
        return state === 'succeeded' || state === 'ready' || state === 'running'
      }) ? 'succeeded' : 'failed'
      await applyWorkspaceEvent({ type: 'steps-settled', projectId: live.projectId, workspaceId: live.workspaceId, outcome })
      // Not awaited: a slow stop must not hold up the next pass.
      void stopWorkspace(systemPrincipal, live.workspaceId)
        .catch((err: unknown) => serverLog(`[server] stopping settled ${live.workspaceId}: ${String(err)}`))
    }
  }
}

/**
 * Where a step starts (docs/workflows.md "Repos"), read off its workflow
 * and the workspace's checkouts, neither of which changes while the
 * workspace lives: the checkout of the one repo its workflow names, the
 * workspace root when it names several, else undefined for the workspace's
 * cwd.
 */
async function stepDir(step: StepRow, root: string, checkouts: Array<{ repoId: string; path: string }>): Promise<string | undefined> {
  const repos = step.workflowId !== undefined ? (await getWorkflow(step.workflowId))?.repos ?? [] : []
  if (repos.length === 0) return undefined
  const checkout = repos.length === 1 ? checkouts.find((c) => c.repoId === repos[0]) : undefined
  return checkout !== undefined && checkout.path !== '' ? path.posix.join(root, checkout.path) : root
}

/** The steps that need the volume, directly or through another step, by
 *  full name. */
export function volumeUsers(steps: Array<Pick<StepRow, 'workflowName' | 'name' | 'spec'>>): Set<string> {
  const users = new Set<string>()
  const known = new Set([...steps.map(stepName), VOLUME_NEED])
  for (let grew = true; grew;) {
    grew = false
    for (const s of steps) {
      if (users.has(stepName(s)) || !needsOf(s, known).some((n) => n === VOLUME_NEED || users.has(n))) continue
      users.add(stepName(s))
      grew = true
    }
  }
  return users
}

/** Authorize a request about a workspace's recorded steps. */
export async function authorizeWorkspace(principal: Actor, workspaceId: string): Promise<WorkspaceRow> {
  const row = await findWorkspaceRow(workspaceId)
  if (row === undefined) throw new ServerError('NOT_FOUND', `no workspace ${workspaceId}`)
  await authorizeProject(principal, row.projectId)
  return row
}
