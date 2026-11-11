/**
 * A workspace's steps (docs/workspace-steps.md): named lists of shell
 * commands, each run in a tmux window of its own and ordered by `needs`.
 * Every step belongs to a workflow with a name in its workspace, and is
 * known as `<workflow>.<step>`. One parser serves every source of a graph:
 * a project's init workflows, the graph a create brings in their place, and
 * steps added to a running workspace.
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
  /** Its full name, `<workflow>.<step>`, which names its window, its log
   *  and its pane; a bare name for a step of a life started before steps
   *  had workflows. */
  name: string
  /** The name its workflow has in this workspace; '' for such a step. */
  workflow: string
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

/** A step's name, and a workflow's: no `.`, so a full name splits one way. */
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/

/** Whether `name` may name a step or a workflow. */
export function isStepName(name: string): boolean {
  return NAME_PATTERN.test(name)
}

export const NAME_RULE = 'letters, digits, "-" and "_", starting with a letter or digit, at most 48 long'

/** Whether `name` may name a workflow in a need: a chosen name, or one the
 *  server mints for a workflow that has none (`_steps`, `_added-2`), whose
 *  leading `_` no chosen name can have (docs/workspace-steps.md). */
function isWorkflowName(name: string): boolean {
  return isStepName(name.startsWith('_') ? name.slice(1) : name)
}

/** A step's full name: `<workflow>.<step>`, or the bare name for a step
 *  whose workflow has no name (a life started before steps had one). */
export function stepFullName(workflow: string, step: string): string {
  return workflow === '' ? step : `${workflow}.${step}`
}

/** A need as a full name: a bare one names a step of the same workflow. */
export function fullNeed(workflow: string, need: string): string {
  return need.includes('.') ? need : stepFullName(workflow, need)
}

const AGENT_TOOL = `(?:${AGENT_TOOLS.join('|')})`

/**
 * Whether a tmux window is an agent session's (`claude-c09f7077`), by the
 * same `<tool>-*` match as the log hook (`lifeHooksConfig`). A step's window
 * holds a `.`, which no session's does, so a workflow named after a tool is
 * still a step. An `acp` session's window is logged, but only for its chat
 * pane to offer once the agent exits, so it is left out of the workspace's
 * log listing.
 */
export function isAgentWindow(window: string): boolean {
  return !window.includes('.') && new RegExp(`^${AGENT_TOOL}-`).test(window)
}

const command = z.string({ error: 'must be a non-empty string' }).min(1, { error: 'must be a non-empty string' })

const stepSchema = z.object({
  run: z.union([command.transform((c) => [c]), z.array(command).min(1, { error: 'must list at least one command' })],
    { error: 'must be a command or a non-empty list of commands' }),
  needs: z.array(z.string({ error: 'must be a step name' }), { error: 'must be a list of step names' }).optional(),
  service: z.boolean({ error: 'must be a boolean' }).optional(),
  ready: command.optional(),
}).strict()

/**
 * Parse a step graph, throwing an `Error` that names the first problem. A
 * bare need names a step of the graph, or one of `existing` (`volume`, for a
 * site's release); `<workflow>.<step>` names a step of another workflow of
 * the same life, which only placing the graph in a life can check.
 */
export function parseStepGraph(raw: unknown, existing: ReadonlySet<string> = new Set()): StepGraph {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('steps must be an object of steps by name')
  }
  const graph: StepGraph = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!isStepName(name)) throw new Error(`step "${name}": a name is ${NAME_RULE}`)
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
      const [workflow, step, extra] = need.split('.')
      if (step !== undefined) {
        if (extra !== undefined || !isWorkflowName(workflow) || !isStepName(step)) {
          throw new Error(`step "${name}" needs "${need}", which is not a step name or <workflow>.<step>`)
        }
        continue
      }
      if (!(need in graph) && !existing.has(need)) throw new Error(`step "${name}" needs "${need}", which is not a step`)
    }
  }
  const cycle = findCycle(Object.fromEntries(Object.entries(graph).map(([n, s]) => [n, s.needs ?? []])))
  if (cycle !== undefined) throw new Error(`steps form a cycle: ${cycle.join(' -> ')}`)
  return graph
}

/** A cycle among `graph`'s steps (each step's needs by name), as the names
 *  around it, if any. A need on no step of `graph` is passed over. */
export function findCycle(graph: Record<string, string[]>): string[] | undefined {
  const done = new Set<string>()
  const path: string[] = []
  const visit = (name: string): string[] | undefined => {
    if (done.has(name)) return undefined
    const at = path.indexOf(name)
    if (at !== -1) return [...path.slice(at), name]
    path.push(name)
    for (const need of graph[name] ?? []) {
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

/** Commits as one line: `<dir>@<short>` each, bare for a checkout at the
 *  workspace root, joined by spaces. */
export function formatCommits(commits: Array<{ dir: string; commit: string }>, length = 12): string {
  return commits.map((c) => `${c.dir !== '' ? `${c.dir}@` : ''}${c.commit.slice(0, length)}`).join(' ')
}
