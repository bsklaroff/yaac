import { describe, it, expect } from 'vitest'
import { repoArg, selectionOf, type SelectionOptions } from '#commands/repo-selection'

const SHA = 'a'.repeat(40)

describe('repoArg', () => {
  it('gathers each --repo as a repo with its branch, or a full commit in the branch\'s place', () => {
    expect(repoArg('web')).toEqual([{ repo: 'web' }])
    expect(repoArg('api@release/2', [{ repo: 'web' }])).toEqual([{ repo: 'web' }, { repo: 'api', branch: 'release/2' }])
    expect(repoArg(`web@${SHA}`)).toEqual([{ repo: 'web', commit: SHA }])
    // Short of a full commit it is a branch name.
    expect(repoArg('web@abc123')).toEqual([{ repo: 'web', branch: 'abc123' }])
    for (const bad of ['', '@main', 'web@']) expect(() => repoArg(bad)).toThrow('expected <dir> or <dir>@<branch>')
  })
})

describe('selectionOf', () => {
  it('sends only what the options name, and no repos as an empty list', () => {
    expect(selectionOf({})).toEqual({})
    // commander's default for a `--no-repos` nobody passed.
    expect(selectionOf({ repos: true })).toEqual({})
    expect(selectionOf({ repo: [{ repo: 'web' }], nested: true, cwd: 'web', repos: true }))
      .toEqual({ repos: [{ repo: 'web' }], nested: true, cwd: 'web' })
    expect(selectionOf({ branch: 'dev', nested: false })).toEqual({ branch: 'dev', nested: false })
    expect(selectionOf({ repos: false, cwd: '.' })).toEqual({ repos: [], cwd: '.' })
  })

  it('refuses a start given twice, and a repo, start or layout with --no-repos', () => {
    expect(() => selectionOf({ branch: 'dev', commit: SHA })).toThrow('Give --branch or --commit, not both.')
    const strays: Array<[string, SelectionOptions]> = [
      ['repo', { repo: [{ repo: 'web' }] }], ['branch', { branch: 'dev' }], ['commit', { commit: SHA }], ['nested', { nested: true }],
    ]
    for (const [flag, opts] of strays) {
      expect(() => selectionOf({ repos: false, ...opts }), flag)
        .toThrow(`--no-repos starts with no checkout, so it does not take --${flag}.`)
    }
  })
})
