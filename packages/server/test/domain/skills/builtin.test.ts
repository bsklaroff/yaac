import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { builtinSkillsDir, stageBuiltinSkills, builtinSkillMounts } from '#domain/skills'
// setBuiltinSkillsDir is the feature's test hook (restore the packaged default
// between cases); TOOL_SKILL_ROOTS is the policy constant the mounts derive
// from. Neither is under test here.
import { setBuiltinSkillsDir, TOOL_SKILL_ROOTS } from '#domain/skills/builtin'

let tmp: string

async function writeSkill(dir: string, name: string, body = 'body'): Promise<void> {
  await fs.mkdir(path.join(dir, name), { recursive: true })
  await fs.writeFile(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n${body}\n`)
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-builtin-test-'))
})

afterEach(async () => {
  setBuiltinSkillsDir(null)
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('builtinSkillsDir', () => {
  it('defaults under the package root and honors an override', () => {
    expect(builtinSkillsDir().endsWith(`${path.sep}builtin-skills`)).toBe(true)
    setBuiltinSkillsDir('/tmp/elsewhere')
    expect(builtinSkillsDir()).toBe('/tmp/elsewhere')
    setBuiltinSkillsDir(null)
    expect(builtinSkillsDir().endsWith(`${path.sep}builtin-skills`)).toBe(true)
  })
})

describe('stageBuiltinSkills', () => {
  it('copies every skill dir (incl. nested files), sorted, skipping non-skills', async () => {
    const src = path.join(tmp, 'src')
    await writeSkill(src, 'welcome')
    await writeSkill(src, 'alpha')
    // A multi-file skill — nested assets must come along.
    await fs.mkdir(path.join(src, 'welcome', 'refs'), { recursive: true })
    await fs.writeFile(path.join(src, 'welcome', 'driver.mjs'), 'export default 1\n')
    await fs.writeFile(path.join(src, 'welcome', 'refs', 'note.md'), 'note\n')
    // A subdir without a SKILL.md is not a skill; a dot-dir is ignored; a
    // loose file is neither.
    await fs.mkdir(path.join(src, 'not-a-skill'), { recursive: true })
    await fs.writeFile(path.join(src, 'not-a-skill', 'README.md'), 'x')
    await writeSkill(src, '.hidden')
    await fs.writeFile(path.join(src, 'README.md'), 'x')
    // A symlinked skill dir counts — an install may link rather than copy.
    await fs.symlink(path.join(src, 'alpha'), path.join(src, 'linked'), 'dir')

    const dest = path.join(tmp, 'stage')
    expect(await stageBuiltinSkills(src, dest)).toEqual(['alpha', 'linked', 'welcome'])
    expect(await fs.readFile(path.join(dest, 'welcome', 'SKILL.md'), 'utf8')).toContain('name: welcome')
    expect(await fs.readFile(path.join(dest, 'welcome', 'driver.mjs'), 'utf8')).toBe('export default 1\n')
    expect(await fs.readFile(path.join(dest, 'welcome', 'refs', 'note.md'), 'utf8')).toBe('note\n')
    expect(await fs.readFile(path.join(dest, 'linked', 'SKILL.md'), 'utf8')).toContain('name: alpha')
    await expect(fs.access(path.join(dest, 'not-a-skill'))).rejects.toThrow()
    await expect(fs.access(path.join(dest, '.hidden'))).rejects.toThrow()
  })

  it('replaces prior staging so a removed skill does not linger (freshness)', async () => {
    const src = path.join(tmp, 'src')
    const dest = path.join(tmp, 'stage')
    await writeSkill(src, 'keep')
    // Pre-populate the dest with a stale skill that is no longer in src.
    await writeSkill(dest, 'stale')

    expect(await stageBuiltinSkills(src, dest)).toEqual(['keep'])
    await expect(fs.access(path.join(dest, 'stale'))).rejects.toThrow()
  })

  it('returns [] and leaves no staging when the source is missing', async () => {
    const dest = path.join(tmp, 'stage')
    expect(await stageBuiltinSkills(path.join(tmp, 'nope'), dest)).toEqual([])
    await expect(fs.access(dest)).rejects.toThrow()
  })
})

describe('builtinSkillMounts', () => {
  it('mounts each skill read-only into every tool skills root', () => {
    const mounts = builtinSkillMounts('/stage', ['welcome', 'lint'])
    expect(mounts).toHaveLength(2 * TOOL_SKILL_ROOTS.length)
    expect(mounts.every((m) => m.readOnly === true)).toBe(true)
    expect(mounts).toContainEqual({
      source: { kind: 'hostPath', path: '/stage/welcome' },
      mountPath: '/home/yaac/.claude/skills/welcome',
      readOnly: true,
    })
    expect(mounts).toContainEqual({
      source: { kind: 'hostPath', path: '/stage/lint' },
      mountPath: '/home/yaac/.pi/agent/skills/lint',
      readOnly: true,
    })
  })

  it('returns no mounts when no skills are staged', () => {
    expect(builtinSkillMounts('/stage', [])).toEqual([])
  })
})
