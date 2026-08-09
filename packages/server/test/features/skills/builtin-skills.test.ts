/**
 * Contract tests for the skills feature's shipped content — the `<name>/SKILL.md`
 * dirs under `builtin-skills/` that yaac stages into every session and surfaces
 * as the `system`/`yaac` tier. They cover files, not a module, so the
 * one-describe-per-barrel-function rule that governs the sealed folder's module
 * tests does not apply here.
 *
 * A typo in the frontmatter (or a misplaced dir) would silently drop a skill
 * from staging and discovery, since both paths only require a parseable
 * SKILL.md. Driving the real packaged dir through the feature's entry points
 * keeps each skill wired in without an integration run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@yaac/shared/project-paths'
import type { SkillSummary } from '@yaac/shared/types'
import { builtinSkillsDir, getProjectSkills, getSkillDetail, stageBuiltinSkills } from '#features/skills'

// A project with nothing on disk, so the only tier discovery finds is the
// packaged one. `builtinSkillsDir()` is left at its packaged default.
const slug = 'shipped-skills'

let tmp: string
let staged: string[]
let shipped: SkillSummary[]

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-shipped-skills-'))
  setDataDir(tmp)
  staged = await stageBuiltinSkills(builtinSkillsDir(), path.join(tmp, 'stage'))
  shipped = (await getProjectSkills('claude', slug)).skills
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

/** The shipped skill `name` as the viewer sees it, asserting it is staged into
 *  sessions and discovered with a usable description. */
function expectShipped(name: string): SkillSummary {
  expect(staged).toContain(name)
  const skill = shipped.find((s) => s.name === name)
  expect(skill).toMatchObject({ id: `system:yaac:${name}`, source: 'system', sourceLabel: 'yaac' })
  expect(skill?.description.length ?? 0).toBeGreaterThan(0)
  return skill as SkillSummary
}

const bodyOf = async (name: string): Promise<string> =>
  (await getSkillDetail('claude', slug, `system:yaac:${name}`)).body

describe('builtin-skills/', () => {
  it('ships only skills — every staged dir is discovered as system/yaac', () => {
    expect(staged.length).toBeGreaterThan(0)
    expect(shipped.map((s) => s.name).sort()).toEqual([...staged].sort())
    // The dir's README.md is a loose file, not a skill dir.
    expect(staged).not.toContain('README.md')
  })
})

describe('push-pr skill', () => {
  it('is discoverable and drives the watch phase through yaac-watch-prs', async () => {
    expectShipped('push-pr')
    // The watch step must invoke the generalized watcher scoped to comments,
    // matching the usage shape yaac-watch-prs documents.
    expect(await bodyOf('push-pr')).toContain('yaac-watch-prs --pr <pr-number> --events comment')
  })
})

describe('yaac-spawn skill', () => {
  it('is discoverable and documents the session-bin usage shape', async () => {
    expectShipped('yaac-spawn')
    expect(await bodyOf('yaac-spawn'))
      .toContain('yaac-spawn [--tool claude|codex|opencode|pi] [--model <model>] "<prompt>"')
  })
})

describe('yaac-watch-prs skill', () => {
  it('is discoverable and documents the session-bin usage shape', async () => {
    expectShipped('yaac-watch-prs')
    expect(await bodyOf('yaac-watch-prs'))
      .toContain('yaac-watch-prs [--interval <seconds>] [--pr <number>] [--events <list>] [--once]')
  })
})

describe('spawn-pr-reviewers skill', () => {
  it('is discoverable and drives both halves through the session-bin commands', async () => {
    expectShipped('spawn-pr-reviewers')
    const body = await bodyOf('spawn-pr-reviewers')
    // The watch half scopes the generalized watcher to newly opened PRs, and
    // the per-reviewer half re-scopes it to that one PR's activity.
    expect(body).toContain('yaac-watch-prs --events opened')
    expect(body).toContain('yaac-watch-prs --pr <n> --events commit,comment')
    // The spawn half must name a tool and model, and resolve the tool itself
    // when the argument names only a model. The model is required with no
    // default, so no model id is baked in anywhere as one.
    expect(body).toContain('yaac-spawn --tool <tool> --model <model>')
    expect(body).toContain('yaac-spawn --models')
    expect(body).toContain('There is **no default model**.')
  })
})

describe('yaac-autoconfig skill', () => {
  it('is discoverable with a non-empty description', () => {
    expectShipped('yaac-autoconfig')
  })
})
