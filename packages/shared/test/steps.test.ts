import { describe, it, expect } from 'vitest'
import { FULL_COMMIT_PATTERN, graphHasTask, lifeDirName, parseStepGraph, stepSatisfiesNeeds, stepSettled } from '@yaac/shared/steps'

describe('parseStepGraph', () => {
  it('normalizes each step, a single command becoming a list', () => {
    expect(parseStepGraph({
      install: { run: 'pnpm install' },
      db: { run: ['initdb', 'postgres'], service: true, ready: 'pg_isready' },
      build: { run: ['pnpm build'], needs: ['install', 'install'] },
      empty: { run: 'true', needs: [] },
    })).toEqual({
      install: { run: ['pnpm install'] },
      db: { run: ['initdb', 'postgres'], service: true, ready: 'pg_isready' },
      build: { run: ['pnpm build'], needs: ['install'] },
      empty: { run: ['true'] },
    })
  })

  it('refuses a malformed step, naming it and where', () => {
    expect(() => parseStepGraph([])).toThrow('steps must be an object')
    expect(() => parseStepGraph({ a: { run: [] } })).toThrow('step "a".run: must list at least one command')
    expect(() => parseStepGraph({ a: { run: 'x', extra: 1 } })).toThrow('step "a"')
    expect(() => parseStepGraph({ a: { run: 'x', ready: 'y' } })).toThrow('only a service has a ready check')
    expect(() => parseStepGraph({ a: { run: 'x', service: 'yes' } })).toThrow('step "a".service: must be a boolean')
  })

  it('refuses a name a session window, the keeper, a scratch shell or a tmux target could clash with', () => {
    for (const name of ['claude', 'pi-1', 'codex-c09f7077', 'yaac', 'shell', 'shell-2', '_yaac', 'a:b', 'a.b', '-x', 'x'.repeat(49)]) {
      expect(() => parseStepGraph({ [name]: { run: 'x' } }), name).toThrow(`step "${name}"`)
    }
    expect(Object.keys(parseStepGraph({ pip: { run: 'x' }, shellcheck: { run: 'x' }, a_b: { run: 'x' } })))
      .toEqual(['pip', 'shellcheck', 'a_b'])
  })

  it('refuses needs that name no step or form a cycle, but takes a workspace\'s existing steps', () => {
    expect(() => parseStepGraph({ a: { run: 'x', needs: ['b'] } })).toThrow('step "a" needs "b", which is not a step')
    expect(() => parseStepGraph({ a: { run: 'x', needs: ['a'] } })).toThrow('needs itself')
    expect(() => parseStepGraph({
      a: { run: 'x', needs: ['c'] }, b: { run: 'x', needs: ['a'] }, c: { run: 'x', needs: ['b'] },
    })).toThrow('steps form a cycle: a -> c -> b -> a')
    expect(parseStepGraph({ e2e: { run: 'x', needs: ['build'] } }, new Set(['build']))).toEqual({ e2e: { run: ['x'], needs: ['build'] } })
    expect(() => parseStepGraph({ build: { run: 'x' } }, new Set(['build']))).toThrow('already exists')
  })
})

describe('graphHasTask', () => {
  it('is true only with a step that is not a service', () => {
    expect(graphHasTask({})).toBe(false)
    expect(graphHasTask({ db: { run: ['pg'], service: true } })).toBe(false)
    expect(graphHasTask({ db: { run: ['pg'], service: true }, t: { run: ['test'] } })).toBe(true)
  })
})

describe('stepSettled and stepSatisfiesNeeds', () => {
  it('settle every state but pending, running and ready, and let a dependent start on success or readiness', () => {
    expect(['pending', 'running', 'ready', 'succeeded', 'failed', 'skipped', 'cancelled', 'interrupted']
      .filter((s) => stepSettled(s as never))).toEqual(['succeeded', 'failed', 'skipped', 'cancelled', 'interrupted'])
    expect(['ready', 'succeeded', 'failed', 'running'].filter((s) => stepSatisfiesNeeds(s as never))).toEqual(['ready', 'succeeded'])
  })
})

describe('lifeDirName', () => {
  it('is the ISO start time with no colon', () => {
    expect(lifeDirName(new Date('2026-11-03T01:29:05.123Z'))).toBe('2026-11-03T01-29-05.123Z')
    expect(lifeDirName('2026-11-03T01:29:05.123Z')).toBe('2026-11-03T01-29-05.123Z')
  })
})

describe('FULL_COMMIT_PATTERN', () => {
  it('matches a full sha1 or sha256 id only', () => {
    expect(FULL_COMMIT_PATTERN.test('a'.repeat(40))).toBe(true)
    expect(FULL_COMMIT_PATTERN.test('a'.repeat(64))).toBe(true)
    expect(FULL_COMMIT_PATTERN.test('abc123')).toBe(false)
    expect(FULL_COMMIT_PATTERN.test('A'.repeat(40))).toBe(false)
  })
})
