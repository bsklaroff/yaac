import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { builtinSkillsDir, listBuiltinSkills } from '#features/skills/builtin'
import { parseSkillMd, fmString } from '#features/skills/parse'

// Guards the shipped yaac-spawn skill: a typo in the frontmatter (or a
// misplaced dir) would silently drop it from staging/discovery, since both
// paths only require a parseable SKILL.md. Asserting on the real packaged dir
// keeps the skill wired in without an integration run.
describe('builtin yaac-spawn skill', () => {
  it('is discoverable in the packaged builtin-skills dir', async () => {
    const names = await listBuiltinSkills(builtinSkillsDir())
    expect(names).toContain('yaac-spawn')
  })

  it('has frontmatter with a matching name and a non-empty description', async () => {
    const raw = await fs.readFile(
      path.join(builtinSkillsDir(), 'yaac-spawn', 'SKILL.md'),
      'utf8',
    )
    const { frontmatter } = parseSkillMd(raw)
    expect(fmString(frontmatter, 'name')).toBe('yaac-spawn')
    expect((fmString(frontmatter, 'description') ?? '').length).toBeGreaterThan(0)
  })

  it('documents the same usage shape as the session-bin script', async () => {
    const { body } = parseSkillMd(await fs.readFile(
      path.join(builtinSkillsDir(), 'yaac-spawn', 'SKILL.md'),
      'utf8',
    ))
    expect(body).toContain('yaac-spawn [--tool claude|codex|opencode|pi] [--model <model>] "<prompt>"')
  })
})
