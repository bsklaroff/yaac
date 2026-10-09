/**
 * Contract tests for the shipped `builtin-skills/<name>/SKILL.md` dirs that
 * yaac stages into every session as the `system`/`yaac` tier. They cover
 * files, not a module, so the one-describe-per-barrel-function rule does not
 * apply.
 *
 * A frontmatter typo or misplaced dir would silently drop a skill, so the real
 * packaged dir runs through staging and discovery.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@yaac/shared/project-paths'
import type { SkillSummary } from '@yaac/shared/types'
import { builtinSkillsDir, getProjectSkills, getSkillDetail, stageBuiltinSkills } from '#domain/skills'

// A project with nothing on disk, so discovery finds only the packaged tier.
const projectId = 'shipped-skills'

let tmp: string
let staged: string[]
let shipped: SkillSummary[]

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-shipped-skills-'))
  setDataDir(tmp)
  staged = await stageBuiltinSkills(builtinSkillsDir(), path.join(tmp, 'stage'))
  shipped = (await getProjectSkills('claude', projectId)).skills
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

/** Assert skill `name` is staged and discovered with a description, and
 *  return its summary. */
function expectShipped(name: string): SkillSummary {
  expect(staged).toContain(name)
  const skill = shipped.find((s) => s.name === name)
  expect(skill).toMatchObject({ id: `system:yaac:${name}`, source: 'system', sourceLabel: 'yaac' })
  expect(skill?.description.length ?? 0).toBeGreaterThan(0)
  return skill as SkillSummary
}

const bodyOf = async (name: string): Promise<string> =>
  (await getSkillDetail('claude', projectId, `system:yaac:${name}`)).body

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
    expect(await bodyOf('push-pr')).toContain('yaac-watch-prs --pr <pr-number> --events comment')
  })
})

describe('yaac-mama skill', () => {
  it('is discoverable and documents the workspace-bin usage shape', async () => {
    expectShipped('yaac-mama')
    const body = await bodyOf('yaac-mama')
    expect(body).toContain('yaac-mama create [opts] "<prompt>"')
    expect(body).toContain('yaac-mama queue --parent-workspace W [opts] "<prompt>"')
    expect(body).toContain('yaac-mama edit-queued [--parent-workspace W] [opts] <queued> ["<prompt>"]')
    expect(body).toContain(
      '# opts: [--tool T] [--model M] [--effort E] [--permission-mode P] [--ui-mode U] [--branch B] [--group G] [--title T]')
    expect(body).toContain('yaac-mama list')
    expect(body).toContain('yaac-mama group create "<name>"')
    // Omitting the workspace stops the caller itself, and a self-stop's
    // confirmation may never arrive.
    expect(body).toContain('yaac-mama stop [<workspace>]')
    expect(body).toContain('the workspace ending is the confirmation')
    // The skill must say it is a subset, so an agent does not look for
    // delete or restart.
    expect(body).toContain('strict subset')
  })
})

describe('yaac-watch-prs skill', () => {
  it('is discoverable and documents the workspace-bin usage shape', async () => {
    expectShipped('yaac-watch-prs')
    expect(await bodyOf('yaac-watch-prs'))
      .toContain('yaac-watch-prs [--interval <seconds>] [--pr <number>] [--events <list>] [--once]')
  })
})

describe('review-pr skill', () => {
  it('is discoverable and drives the watch and the self-stop through the workspace-bin commands', async () => {
    expectShipped('review-pr')
    const body = await bodyOf('review-pr')
    // A reviewer watches its PR and stops itself via yaac-mama once approved.
    expect(body).toContain('yaac-watch-prs --pr <n> --events commit,comment')
    expect(body).toContain('yaac-mama stop')
    // An unaddressed nit still blocks approval.
    expect(body).toContain('Say "Approved" only when nothing is outstanding')
    expect(body).toContain('There is no "Approved with nits"')
  })
})

describe('spawn-pr-reviewers skill', () => {
  it('is discoverable and drives both halves through the workspace-bin commands', async () => {
    expectShipped('spawn-pr-reviewers')
    const body = await bodyOf('spawn-pr-reviewers')
    // Watching covers new PRs; each reviewer follows review-pr.
    expect(body).toContain('yaac-watch-prs --events opened')
    expect(body).toContain('`review-pr`')
    // The spawn names a tool and model, resolving the tool when only a model
    // is given. The model has no default, so no model id is baked in.
    expect(body).toContain('yaac-mama create --tool <tool> --model <model>')
    expect(body).toContain('yaac-mama models')
    expect(body).toContain('There is **no default model**.')
  })
})

describe('yaac-autoconfig skill', () => {
  it('is discoverable with a non-empty description', () => {
    expectShipped('yaac-autoconfig')
  })
})
