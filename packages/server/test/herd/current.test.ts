import { describe, it, expect, afterEach } from 'vitest'
import { _resetHerdForTests, _setHerdForTests, herd, setHerd } from '#herd'
import type { HerdClient } from '#herd'

afterEach(() => { _resetHerdForTests() })

/** A herd that answers one question, and nothing else. */
function fake(observe: HerdClient['workspaces']['observe']): HerdClient {
  return { workspaces: { observe } } as unknown as HerdClient
}

const empty = () => Promise.resolve({ workspaces: [], stale: [], gitAuthFailures: {} })

describe('herd', () => {
  // No degraded behavior is meaningful: every caller is answering a request
  // or running a reconcile step, and a herd-less server has nothing to say
  // about a workspace.
  it('throws when none is attached', () => {
    expect(() => herd()).toThrow('no herd is attached')
  })

  it('answers with the attached herd', async () => {
    setHerd(fake(empty))
    expect(await herd().workspaces.observe()).toEqual({
      workspaces: [], stale: [], gitAuthFailures: {},
    })
  })

  // A stub answers only the calls a test set up; anything else has to say
  // which call it was, or the failure reads as `undefined is not a function`
  // somewhere far from the crossing that caused it.
  it('names the unstubbed call a stub was asked for', () => {
    _setHerdForTests({ workspaces: { observe: empty } })
    expect(() => herd().workspaces.create('proj', {}))
      .toThrow('herd stub: workspaces.create was called but not stubbed')
  })
})

describe('setHerd', () => {
  it('replaces the previous herd', async () => {
    setHerd(fake(empty))
    setHerd(fake(() => Promise.resolve({
      workspaces: [], stale: [{ jobName: 'j', projectSlug: 'p', sessionId: 's', zombie: false }], gitAuthFailures: {},
    })))
    expect((await herd().workspaces.observe()).stale).toHaveLength(1)
  })
})
