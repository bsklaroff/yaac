import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  builtinSkillsDir,
  setBuiltinSkillsDir,
  listBuiltinSkills,
  stageBuiltinSkills,
  builtinSkillMounts,
  TOOL_SKILL_ROOTS,
} from '#lib/skills/builtin'

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

describe('builtinSkillsDir / setBuiltinSkillsDir', () => {
  it('defaults under the package root and honors an override', () => {
    expect(builtinSkillsDir().endsWith(`${path.sep}builtin-skills`)).toBe(true)
    setBuiltinSkillsDir('/tmp/elsewhere')
    expect(builtinSkillsDir()).toBe('/tmp/elsewhere')
    setBuiltinSkillsDir(null)
    expect(builtinSkillsDir().endsWith(`${path.sep}builtin-skills`)).toBe(true)
  })
})

describe('listBuiltinSkills', () => {
  it('returns sorted names of subdirs that hold a SKILL.md', async () => {
    const src = path.join(tmp, 'src')
    await writeSkill(src, 'beta')
    await writeSkill(src, 'alpha')
    // A subdir without a SKILL.md is not a skill.
    await fs.mkdir(path.join(src, 'not-a-skill'), { recursive: true })
    await fs.writeFile(path.join(src, 'not-a-skill', 'README.md'), 'x')
    // A dot-dir is ignored.
    await writeSkill(src, '.hidden')
    expect(await listBuiltinSkills(src)).toEqual(['alpha', 'beta'])
  })

  it('returns [] for a missing dir (no bundled skills shipped)', async () => {
    expect(await listBuiltinSkills(path.join(tmp, 'nope'))).toEqual([])
  })
})

describe('stageBuiltinSkills', () => {
  it('copies each skill dir (incl. nested files) and returns the names', async () => {
    const src = path.join(tmp, 'src')
    await writeSkill(src, 'welcome')
    // A multi-file skill — nested assets must come along.
    await fs.mkdir(path.join(src, 'welcome', 'refs'), { recursive: true })
    await fs.writeFile(path.join(src, 'welcome', 'driver.mjs'), 'export default 1\n')
    await fs.writeFile(path.join(src, 'welcome', 'refs', 'note.md'), 'note\n')

    const dest = path.join(tmp, 'stage')
    const names = await stageBuiltinSkills(src, dest)
    expect(names).toEqual(['welcome'])
    expect(await fs.readFile(path.join(dest, 'welcome', 'SKILL.md'), 'utf8')).toContain('name: welcome')
    expect(await fs.readFile(path.join(dest, 'welcome', 'driver.mjs'), 'utf8')).toBe('export default 1\n')
    expect(await fs.readFile(path.join(dest, 'welcome', 'refs', 'note.md'), 'utf8')).toBe('note\n')
  })

  it('replaces prior staging so a removed skill does not linger (freshness)', async () => {
    const src = path.join(tmp, 'src')
    const dest = path.join(tmp, 'stage')
    await writeSkill(src, 'keep')
    // Pre-populate the dest with a stale skill that is no longer in src.
    await writeSkill(dest, 'stale')

    const names = await stageBuiltinSkills(src, dest)
    expect(names).toEqual(['keep'])
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
      hostPath: '/stage/welcome',
      mountPath: '/home/yaac/.claude/skills/welcome',
      readOnly: true,
    })
    expect(mounts).toContainEqual({
      hostPath: '/stage/lint',
      mountPath: '/home/yaac/.pi/agent/skills/lint',
      readOnly: true,
    })
  })

  it('returns no mounts when no skills are staged', () => {
    expect(builtinSkillMounts('/stage', [])).toEqual([])
  })
})
