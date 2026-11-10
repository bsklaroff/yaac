import type { EndpointModel } from '#tool-providers'
import { endpointModelsSchema } from '#types'

/**
 * How a custom endpoint's fetched model list differs from the stored one,
 * matched by id, for the re-fetch review in the webapp and `yaac auth
 * endpoint refresh` (docs/custom-endpoints.md).
 */
export interface EndpointModelsDiff {
  /** Fetched, not in the list. */
  added: EndpointModel[]
  /** In both, with a different name or different levels. */
  changed: { before: EndpointModel; after: EndpointModel }[]
  /** In the list, not fetched: possibly added by hand. */
  removed: EndpointModel[]
}

/** Which ids of each part of a diff to apply. */
export interface EndpointDiffPick {
  added: ReadonlySet<string>
  changed: ReadonlySet<string>
  removed: ReadonlySet<string>
}

function sameModel(a: EndpointModel, b: EndpointModel): boolean {
  const levels = (m: EndpointModel): string => [...m.efforts?.levels ?? []].sort().join(' ')
  return a.name === b.name && levels(a) === levels(b) && a.efforts?.default === b.efforts?.default
}

export function diffEndpointModels(current: EndpointModel[], fetched: EndpointModel[]): EndpointModelsDiff {
  const stored = new Map(current.map((m) => [m.id, m]))
  const listed = new Set(fetched.map((m) => m.id))
  return {
    added: fetched.filter((m) => !stored.has(m.id)),
    changed: fetched.flatMap((after) => {
      const before = stored.get(after.id)
      return before !== undefined && !sameModel(before, after) ? [{ before, after }] : []
    }),
    removed: current.filter((m) => !listed.has(m.id)),
  }
}

/** Whether a diff has nothing in it. */
export function emptyDiff(diff: EndpointModelsDiff): boolean {
  return diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0
}

/** The list with the picked parts of `diff` applied: changes in place,
 *  removals dropped, additions appended in fetched order. */
export function applyEndpointDiff(current: EndpointModel[], diff: EndpointModelsDiff, pick: EndpointDiffPick): EndpointModel[] {
  const changed = new Map(diff.changed.filter((c) => pick.changed.has(c.after.id)).map((c) => [c.after.id, c.after]))
  return [
    ...current.filter((m) => !pick.removed.has(m.id)).map((m) => changed.get(m.id) ?? m),
    ...diff.added.filter((m) => pick.added.has(m.id)),
  ]
}

/** A model as one line: its id, name, and levels with the default starred. */
export function describeEndpointModel(m: EndpointModel): string {
  const levels = m.efforts?.levels.map((l) => (l === m.efforts?.default ? `${l}*` : l)).join(' ')
  return `${m.id}${m.name !== undefined ? ` (${m.name})` : ''}${levels !== undefined ? ` [${levels}]` : ''}`
}

/**
 * A hand-edited model list, checked as the server will: the list, or each
 * problem located by path (`[2].efforts.default: …`).
 */
export function parseEndpointModels(value: unknown): { ok: true; value: EndpointModel[] } | { ok: false; errors: string[] } {
  const parsed = endpointModelsSchema.safeParse(value)
  if (parsed.success) return { ok: true, value: parsed.data }
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => {
      const where = i.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '')
      return `${where || '(list)'}: ${i.message}`
    }),
  }
}
