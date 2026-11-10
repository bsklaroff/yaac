/**
 * A workspace's steps (docs/workspace-steps.md): named lists of shell
 * commands, each run in a tmux window of its own and ordered by `needs`.
 * One parser serves every source of a graph: a project's init steps, the
 * graph a create brings in their place, and steps added to a running
 * workspace.
 */
import { z } from 'zod'
import { AGENT_TOOLS } from './types'

/** One step, as stored: `run` is always a list. */
export interface StepSpec {
  /** Run in order in one shell, stopping at the first failure. */
  run: string[]
  /** Steps that must succeed (or, for a service, be ready) first. */
  needs?: string[]
  /** Long-running: its last command is the process, and it is never done. */
  service?: boolean
  /** A service's readiness check, run every two seconds until it passes. */
  ready?: string
}

/** Steps by name. */
export type StepGraph = Record<string, StepSpec>

export const STEP_STATES = [
  'pending', 'running', 'ready', 'succeeded', 'failed', 'skipped', 'cancelled', 'interrupted',
] as const
export type StepState = typeof STEP_STATES[number]

/** Where a workspace's step came from: its start graph, which reruns in
 *  every life, or a request while it ran, which runs once. */
export type StepOrigin = 'start' | 'added'

/** A step as the API answers it. */
export interface WorkspaceStep {
  name: string
  origin: StepOrigin
  spec: StepSpec
  state: StepState
  /** The window's exit status, once it has exited. */
  exitCode?: number
  /** The workspace life the step ran in (ISO time), which names its log dir. */
  life: string
  startedAt?: string
  readyAt?: string
  finishedAt?: string
}

/** How a non-interactive workspace's graph ended. */
export type StepsOutcome = 'succeeded' | 'failed'

/** States a step never leaves on its own. */
export function stepSettled(state: StepState): boolean {
  return state !== 'pending' && state !== 'running' && state !== 'ready'
}

/** Whether a step in `state` lets the steps that need it start. */
export function stepSatisfiesNeeds(state: StepState): boolean {
  return state === 'succeeded' || state === 'ready'
}

const STEP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/

const AGENT_TOOL = `(?:${AGENT_TOOLS.join('|')})`

/**
 * Whether a tmux window is an agent session's (`claude-c09f7077`), by the
 * same `<tool>-*` match as the log hook (`lifeHooksConfig`). An `acp`
 * session's window is logged, but only for its chat pane to offer once the
 * agent exits, so it is left out of the workspace's log listing.
 */
export function isAgentWindow(window: string): boolean {
  return new RegExp(`^${AGENT_TOOL}-`).test(window)
}

/**
 * Names a step may not take: an agent tool's, or one starting with it and a
 * `-` like a session's window, which the log hook leaves unlogged; `yaac`;
 * and the webapp's scratch shells (`shell`, `shell-2`), whose windows a
 * step's launch would kill.
 */
const RESERVED_STEP_NAME = new RegExp(`^(?:${AGENT_TOOL}(?:-.*)?|yaac|shell(?:-\\d+)?)$`)

const command = z.string({ error: 'must be a non-empty string' }).min(1, { error: 'must be a non-empty string' })

const stepSchema = z.object({
  run: z.union([command.transform((c) => [c]), z.array(command).min(1, { error: 'must list at least one command' })],
    { error: 'must be a command or a non-empty list of commands' }),
  needs: z.array(z.string({ error: 'must be a step name' }), { error: 'must be a list of step names' }).optional(),
  service: z.boolean({ error: 'must be a boolean' }).optional(),
  ready: command.optional(),
}).strict()

/**
 * Parse a step graph, throwing an `Error` that names the first problem.
 * `existing` names steps the workspace already has, which an added step's
 * `needs` may name; they are not part of the graph and may not be redefined.
 */
export function parseStepGraph(raw: unknown, existing: ReadonlySet<string> = new Set()): StepGraph {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('steps must be an object of steps by name')
  }
  const graph: StepGraph = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!STEP_NAME_PATTERN.test(name)) {
      throw new Error(`step "${name}": a name is letters, digits, "-" and "_", starting with a letter or digit, at most 48 long`)
    }
    if (RESERVED_STEP_NAME.test(name)) throw new Error(`step "${name}": the name is reserved`)
    if (existing.has(name)) throw new Error(`step "${name}" already exists in this workspace`)
    const parsed = stepSchema.safeParse(value)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue.path.length > 0 ? `.${issue.path.join('.')}` : ''
      throw new Error(`step "${name}"${where}: ${issue.message}`)
    }
    const { run, needs, service, ready } = parsed.data
    if (ready !== undefined && service !== true) throw new Error(`step "${name}": only a service has a ready check`)
    graph[name] = {
      run,
      ...(needs !== undefined && needs.length > 0 ? { needs: [...new Set(needs)] } : {}),
      ...(service === true ? { service: true } : {}),
      ...(ready !== undefined ? { ready } : {}),
    }
  }
  for (const [name, step] of Object.entries(graph)) {
    for (const need of step.needs ?? []) {
      if (need === name) throw new Error(`step "${name}" needs itself`)
      if (!(need in graph) && !existing.has(need)) throw new Error(`step "${name}" needs "${need}", which is not a step`)
    }
  }
  const cycle = findCycle(graph)
  if (cycle !== undefined) throw new Error(`steps form a cycle: ${cycle.join(' -> ')}`)
  return graph
}

/** A cycle among `graph`'s own steps, as the names around it, if any. */
function findCycle(graph: StepGraph): string[] | undefined {
  const done = new Set<string>()
  const path: string[] = []
  const visit = (name: string): string[] | undefined => {
    if (done.has(name)) return undefined
    const at = path.indexOf(name)
    if (at !== -1) return [...path.slice(at), name]
    path.push(name)
    for (const need of graph[name]?.needs ?? []) {
      if (!(need in graph)) continue
      const cycle = visit(need)
      if (cycle !== undefined) return cycle
    }
    path.pop()
    done.add(name)
    return undefined
  }
  for (const name of Object.keys(graph)) {
    const cycle = visit(name)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

/** Whether a graph has a step that is not a service, which a
 *  non-interactive workspace needs: it ends when those settle. */
export function graphHasTask(graph: StepGraph): boolean {
  return Object.values(graph).some((s) => s.service !== true)
}

/** A life's log directory name: its start time, with no `:` (which some
 *  filesystems refuse). */
export function lifeDirName(life: Date | string): string {
  return (typeof life === 'string' ? life : life.toISOString()).replace(/:/g, '-')
}

/** A full commit id: 40 hex digits, or 64 in a SHA-256 repository. */
export const FULL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
