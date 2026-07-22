import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { builtinSkillsDir, listBuiltinSkills } from '#features/skills/builtin'
import { parseSkillMd, fmString } from '#features/skills/parse'

// Guards the shipped push-pr skill the same way the yaac-spawn/yaac-watch-prs
// tests do: a typo in the frontmatter (or a misplaced dir) would silently drop
// it from staging/discovery, since both paths only require a parseable
// SKILL.md. Asserting on the real packaged dir keeps the skill wired in
// without an integration run.
describe('builtin push-pr skill', () => {
  it('is discoverable in the packaged builtin-skills dir', async () => {
    const names = await listBuiltinSkills(builtinSkillsDir())
    expect(names).toContain('push-pr')
  })

  it('has frontmatter with a matching name and a non-empty description', async () => {
    const raw = await fs.readFile(
      path.join(builtinSkillsDir(), 'push-pr', 'SKILL.md'),
      'utf8',
    )
    const { frontmatter } = parseSkillMd(raw)
    expect(fmString(frontmatter, 'name')).toBe('push-pr')
    expect((fmString(frontmatter, 'description') ?? '').length).toBeGreaterThan(0)
  })

  it('drives the watch phase through the yaac-watch-prs command', async () => {
    const { body } = parseSkillMd(await fs.readFile(
      path.join(builtinSkillsDir(), 'push-pr', 'SKILL.md'),
      'utf8',
    ))
    // The watch step must invoke the generalized watcher scoped to comments,
    // matching the usage shape yaac-watch-prs documents.
    expect(body).toContain('yaac-watch-prs --pr <pr-number> --events comment')
  })
})
