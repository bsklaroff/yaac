import { describe, it, expect } from 'vitest'
import {
  applyEndpointDiff,
  describeEndpointModel,
  diffEndpointModels,
  emptyDiff,
  parseEndpointModels,
} from '@yaac/shared/endpoint-models'
import type { EndpointModel } from '@yaac/shared/tool-providers'

const efforts = (levels: ('low' | 'medium' | 'high')[], d: 'low' | 'medium' | 'high'): EndpointModel['efforts'] => ({ levels, default: d })
const stored: EndpointModel[] = [{ id: 'a', efforts: efforts(['low', 'high'], 'low') }, { id: 'b' }, { id: 'mine' }]
const fetched: EndpointModel[] = [{ id: 'a', efforts: efforts(['high', 'low', 'medium'], 'low') }, { id: 'b' }, { id: 'new' }]

describe('diffEndpointModels', () => {
  it('matches by id: new, changed (name or levels, in any order) and gone', () => {
    expect(diffEndpointModels(stored, fetched)).toEqual({
      added: [{ id: 'new' }],
      changed: [{ before: stored[0], after: fetched[0] }],
      removed: [{ id: 'mine' }],
    })
    // Order, of the list or of a model's levels, is no change.
    expect(emptyDiff(diffEndpointModels(stored, [{ id: 'mine' }, { id: 'b' }, { id: 'a', efforts: efforts(['high', 'low'], 'low') }])))
      .toBe(true)
  })
})

describe('emptyDiff', () => {
  it('is true only when nothing was added, changed or removed', () => {
    expect(emptyDiff({ added: [], changed: [], removed: [] })).toBe(true)
    expect(emptyDiff({ added: [], changed: [], removed: [{ id: 'x' }] })).toBe(false)
  })
})

describe('applyEndpointDiff', () => {
  it('applies only the picked parts: changes in place, removals dropped, additions appended', () => {
    const diff = diffEndpointModels(stored, fetched)
    expect(applyEndpointDiff(stored, diff, { added: new Set(['new']), changed: new Set(['a']), removed: new Set() }))
      .toEqual([fetched[0], { id: 'b' }, { id: 'mine' }, { id: 'new' }])
    expect(applyEndpointDiff(stored, diff, { added: new Set(), changed: new Set(), removed: new Set(['mine']) }))
      .toEqual([stored[0], { id: 'b' }])
  })
})

describe('describeEndpointModel', () => {
  it('names a model, its label and its levels with the default starred', () => {
    expect(describeEndpointModel({ id: 'a', name: 'A', efforts: efforts(['low', 'high'], 'high') })).toBe('a (A) [low high*]')
    expect(describeEndpointModel({ id: 'b' })).toBe('b')
  })
})

describe('parseEndpointModels', () => {
  it('returns the checked list, or each problem by path', () => {
    expect(parseEndpointModels([{ id: ' a ' }])).toEqual({ ok: true, value: [{ id: 'a' }] })
    expect(parseEndpointModels([{ id: 'a' }, { id: 'a', efforts: { levels: ['low'], default: 'max' } }])).toEqual({
      ok: false,
      errors: ['[1].efforts.default: the default is not one of the levels', '[1].id: "a" is listed twice'],
    })
    expect(parseEndpointModels({})).toMatchObject({ ok: false, errors: [expect.stringMatching(/^\(list\): /)] })
  })
})
