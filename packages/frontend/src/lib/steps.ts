/**
 * A workspace's steps in the webapp (docs/workspace-steps.md): their pane
 * targets, how the workspace bar lists them, where their logs are, and
 * reading a graph typed into a settings form.
 */

import { FULL_COMMIT_PATTERN, lifeDirName, stepSettled, type WorkspaceStep } from '@yaac/shared/steps'

const STEP_PREFIX = 'step:'

/** A step's pane target. */
export function stepTarget(name: string): string {
  return `${STEP_PREFIX}${name}`
}

export function isStepTarget(target: string): boolean {
  return target.startsWith(STEP_PREFIX)
}

/** The step a step pane shows. */
export function stepTargetName(target: string): string {
  return target.slice(STEP_PREFIX.length)
}

/**
 * How the workspace bar lists a life's steps: each one still running or
 * pending, or one that failed, was cancelled or interrupted, on its own
 * (`shown`), and the ones that succeeded or were skipped folded into one
 * entry (`done`), so finished steps keep out of the way and a failure stays
 * in view.
 */
export function foldSteps<S extends Pick<WorkspaceStep, 'state'>>(steps: S[]): { shown: S[]; done: S[] } {
  const done = steps.filter((s) => s.state === 'succeeded' || s.state === 'skipped')
  return { shown: steps.filter((s) => !done.includes(s)), done }
}

/** Whether a step's log may still grow, so its pane follows it. */
export function stepLive(step: Pick<WorkspaceStep, 'state'>): boolean {
  return !stepSettled(step.state)
}

/**
 * Whether nothing in a workspace may be changed by hand: one that runs its
 * graph untouched, or a public site's release (docs/public-sites.md), which
 * only its site's deploys manage. The server refuses sessions, shells and
 * step actions in either.
 */
export function isLocked(w: { nonInteractive?: true; site?: string }): boolean {
  return w.nonInteractive === true || w.site !== undefined
}

/** A step's log file: its life's dir and the file in it. */
export function stepLogFile(step: Pick<WorkspaceStep, 'name' | 'life'>): { life: string; file: string } {
  return { life: lifeDirName(step.life), file: `${step.name}.log` }
}

/**
 * Where a create starts, from the Base branch field: a full commit id is
 * sent as one (the workspace then has no base branch), anything else as a
 * branch, and an empty field as neither.
 */
export function startPoint(value: string): { branch: string } | { commit: string } | Record<string, never> {
  const v = value.trim()
  if (v === '') return {}
  return FULL_COMMIT_PATTERN.test(v) ? { commit: v } : { branch: v }
}

/**
 * Parse a step graph typed by hand, which must be a JSON object. The server
 * checks the rest and its message shows as given.
 */
export function parseSteps(text: string): Record<string, unknown> {
  let steps: unknown
  try {
    steps = JSON.parse(text)
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (typeof steps !== 'object' || steps === null || Array.isArray(steps)) throw new Error('Steps must be a JSON object')
  return steps as Record<string, unknown>
}
