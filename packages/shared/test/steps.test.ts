import { describe, it, expect } from 'vitest'
import {
  FULL_COMMIT_PATTERN, findCycle, formatCommits, fullNeed, graphHasTask, isAgentWindow, isStepName, lifeDirName, parseStepGraph,
  stepFullName, stepSatisfiesNeeds, stepSettled,
} from '@yaac/shared/steps'

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

  it('refuses a name holding a "." or a tmux target character, and takes a tool\'s or a shell\'s', () => {
    for (const name of ['_yaac', 'a:b', 'a.b', '-x', 'x'.repeat(49)]) {
      expect(() => parseStepGraph({ [name]: { run: 'x' } }), name).toThrow(`step "${name}"`)
    }
    expect(Object.keys(parseStepGraph({ claude: { run: 'x' }, shell: { run: 'x' }, yaac: { run: 'x' }, a_b: { run: 'x' } })))
      .toEqual(['claude', 'shell', 'yaac', 'a_b'])
  })

  it('refuses a bare need on no step of the graph, or a cycle, and takes a need on another workflow\'s step', () => {
    expect(() => parseStepGraph({ a: { run: 'x', needs: ['b'] } })).toThrow('step "a" needs "b", which is not a step')
    expect(() => parseStepGraph({ a: { run: 'x', needs: ['a'] } })).toThrow('needs itself')
    expect(() => parseStepGraph({
      a: { run: 'x', needs: ['c'] }, b: { run: 'x', needs: ['a'] }, c: { run: 'x', needs: ['b'] },
    })).toThrow('steps form a cycle: a -> c -> b -> a')
    // `volume` names no step of a site release's graph.
    expect(parseStepGraph({ app: { run: 'x', needs: ['volume'] } }, new Set(['volume']))).toEqual({ app: { run: ['x'], needs: ['volume'] } })
    // A step of another workflow is checked only when placed in a life.
    expect(parseStepGraph({ migrate: { run: 'x', needs: ['db-init.postgres'] } })).toEqual({ migrate: { run: ['x'], needs: ['db-init.postgres'] } })
    // A minted workflow name starts with `_`; a step name never does.
    expect(parseStepGraph({ e2e: { run: 'x', needs: ['_added-2.run', '_steps.build'] } }).e2e.needs).toEqual(['_added-2.run', '_steps.build'])
    expect(() => parseStepGraph({ _e2e: { run: 'x' } })).toThrow('a name is')
    for (const need of ['a.b.c', '.b', 'a.', 'a b.c', 'a._b', '__x.b', '_.b']) {
      expect(() => parseStepGraph({ x: { run: 'x', needs: [need] } }), need).toThrow('not a step name or <workflow>.<step>')
    }
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

describe('isStepName', () => {
  it('takes letters, digits, - and _, at most 48, and no "."', () => {
    expect(['web-init', 'a_1', 'x'.repeat(48)].every(isStepName)).toBe(true)
    expect(['web.init', '-x', '', 'x'.repeat(49)].some(isStepName)).toBe(false)
  })
})

describe('stepFullName and fullNeed', () => {
  it('join a workflow to its step, bare for a step of no workflow, a full need as given', () => {
    expect(stepFullName('web-init', 'install')).toBe('web-init.install')
    expect(stepFullName('', 'install')).toBe('install')
    expect(fullNeed('web-init', 'install')).toBe('web-init.install')
    expect(fullNeed('web-init', 'api-init.migrate')).toBe('api-init.migrate')
  })
})

describe('findCycle', () => {
  it('finds a cycle through several workflows, passing over needs on no step', () => {
    expect(findCycle({ 'a.x': ['b.y'], 'b.y': ['a.x'] })).toEqual(['a.x', 'b.y', 'a.x'])
    expect(findCycle({ 'a.x': ['gone.y'] })).toBeUndefined()
  })
})

describe('isAgentWindow', () => {
  it('is a session\'s window, never a step\'s, which holds a "."', () => {
    expect(isAgentWindow('claude-c09f7077')).toBe(true)
    expect(isAgentWindow('claude-review.lint')).toBe(false)
    expect(isAgentWindow('shell')).toBe(false)
  })
})

describe('formatCommits', () => {
  it('prints <dir>@<short> each, bare for a checkout at the root', () => {
    expect(formatCommits([{ dir: '', commit: 'a'.repeat(40) }], 8)).toBe('aaaaaaaa')
    expect(formatCommits([{ dir: 'web', commit: 'a'.repeat(40) }, { dir: 'api', commit: 'b'.repeat(40) }])).toBe(`web@${'a'.repeat(12)} api@${'b'.repeat(12)}`)
  })
})
