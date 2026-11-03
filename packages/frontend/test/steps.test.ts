import { describe, it, expect } from 'vitest'
import { foldSteps, isStepTarget, startPoint, stepLive, stepLogFile, stepTarget, stepTargetName } from '#lib/steps'
import { isSpecialPane } from '#lib/panes'
import type { StepState } from '@yaac/shared/steps'

/**
 * A workspace's steps in the webapp (docs/workspace-steps.md): a step's pane
 * is the webapp's own, the bar folds finished steps away but keeps a
 * failure in view, and the Base branch field sends a full commit id as one.
 */

const step = (name: string, state: StepState) => ({ name, state })

describe('stepTarget', () => {
  it('addresses a step pane by its name, both ways, as a pane the webapp keeps', () => {
    expect(stepTarget('build')).toBe('step:build')
    expect(isStepTarget('step:build')).toBe(true)
    expect(isStepTarget('session:abc')).toBe(false)
    expect(stepTargetName('step:build')).toBe('build')
    expect(isSpecialPane(stepTarget('build'))).toBe(true)
  })
})

describe('foldSteps', () => {
  it('folds succeeded and skipped steps, and lists the rest one by one in order', () => {
    const steps = [
      step('install', 'succeeded'), step('db', 'ready'), step('build', 'failed'), step('docs', 'skipped'),
      step('server', 'pending'), step('lint', 'running'), step('e2e', 'cancelled'),
    ]
    const { shown, done } = foldSteps(steps)
    expect(shown.map((s) => s.name)).toEqual(['db', 'build', 'server', 'lint', 'e2e'])
    expect(done.map((s) => s.name)).toEqual(['install', 'docs'])
  })
})

describe('stepLive', () => {
  it('follows a step whose log can still grow', () => {
    expect((['pending', 'running', 'ready'] as const).map((s) => stepLive({ state: s }))).toEqual([true, true, true])
    expect((['succeeded', 'failed', 'cancelled'] as const).map((s) => stepLive({ state: s }))).toEqual([false, false, false])
  })
})

describe('stepLogFile', () => {
  it('names the life dir without colons, and the log after the step', () => {
    expect(stepLogFile({ name: 'build', life: '2026-11-03T01:29:05.123Z' }))
      .toEqual({ life: '2026-11-03T01-29-05.123Z', file: 'build.log' })
  })
})

describe('startPoint', () => {
  it('sends a full commit id as a commit, anything else as a branch, and nothing for an empty field', () => {
    const sha = 'a'.repeat(40)
    expect(startPoint(` ${sha} `)).toEqual({ commit: sha })
    expect(startPoint('b'.repeat(64))).toEqual({ commit: 'b'.repeat(64) })
    expect(startPoint('main')).toEqual({ branch: 'main' })
    expect(startPoint('abc1234')).toEqual({ branch: 'abc1234' })
    expect(startPoint('')).toEqual({})
  })
})
