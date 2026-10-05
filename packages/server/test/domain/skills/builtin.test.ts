import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { claudeDir, piDir, setDataDir } from '@yaac/shared/project-paths'

import {
  builtinSkillsDir, builtinSkillMounts, reconcileSharedSkillRoots, sharedSkillRoots, stageBuiltinSkills,
} from '#domain/skills'
// Test hook and policy constant used for setup, not under test.
import { setBuiltinSkillsDir, TOOL_SKILL_ROOTS } from '#domain/skills/builtin'

const SLUG = 'proj'

let tmp: string

async function writeSkill(dir: string, name: string, body = 'body'): Promise<void> {
  await fs.mkdir(path.join(dir, name), { recursive: true })
  await fs.writeFile(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n${body}\n`)
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-builtin-test-'))
  setDataDir(tmp)
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
    // A multi-file skill: nested assets must be copied too.
    await fs.mkdir(path.join(src, 'welcome', 'refs'), { recursive: true })
    await fs.writeFile(path.join(src, 'welcome', 'driver.mjs'), 'export default 1\n')
    await fs.writeFile(path.join(src, 'welcome', 'refs', 'note.md'), 'note\n')
    // A subdir without a SKILL.md is not a skill; a dot-dir is ignored; a
    // loose file is neither.
    await fs.mkdir(path.join(src, 'not-a-skill'), { recursive: true })
    await fs.writeFile(path.join(src, 'not-a-skill', 'README.md'), 'x')
    await writeSkill(src, '.hidden')
    await fs.writeFile(path.join(src, 'README.md'), 'x')
    // A symlinked skill dir counts; an install may link rather than copy.
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

describe('sharedSkillRoots', () => {
  it('names every tool\'s host skills root under the project config dirs', () => {
    const roots = sharedSkillRoots(SLUG)
    // One host root per in-pod root, so every tool sees the skills.
    expect(roots).toHaveLength(TOOL_SKILL_ROOTS.length)
    expect(roots).toContain(path.join(claudeDir(SLUG), 'skills'))
    expect(roots).toContain(path.join(piDir(SLUG), 'agent', 'skills'))
    expect(roots.every((r) => r.startsWith(tmp))).toBe(true)
  })
})

describe('reconcileSharedSkillRoots', () => {
  /** An install shipping `names`. The `builtin-skills` dir name is what
   *  marks its links as ours. */
  async function install(names: string[], where = 'install'): Promise<string> {
    const dir = path.join(tmp, where, 'builtin-skills')
    for (const name of names) await writeSkill(dir, name)
    return dir
  }

  it('links every shipped skill into every tool root, and stays put when re-run', async () => {
    const src = await install(['welcome', 'alpha'])
    expect(await reconcileSharedSkillRoots(src, SLUG, 'link')).toEqual(['alpha', 'welcome'])

    for (const root of sharedSkillRoots(SLUG)) {
      for (const name of ['alpha', 'welcome']) {
        const entry = path.join(root, name)
        expect((await fs.lstat(entry)).isSymbolicLink()).toBe(true)
        // Read through the link, so an upgrade updates every workspace
        // without restaging.
        expect(await fs.readFile(path.join(entry, 'SKILL.md'), 'utf8')).toContain(`name: ${name}`)
      }
    }
    // A second create must not trip over the links the first one left.
    expect(await reconcileSharedSkillRoots(src, SLUG, 'link')).toEqual(['alpha', 'welcome'])
    expect(await fs.readlink(path.join(claudeDir(SLUG), 'skills', 'alpha')))
      .toBe(path.join(src, 'alpha'))
  })

  it('never takes a name the user owns — a real dir, a file, or a link of their own', async () => {
    const root = path.join(claudeDir(SLUG), 'skills')
    // Their own skill, under a name this install also ships.
    await writeSkill(root, 'welcome', 'the-users-own')
    // Their own link, aimed at a live dir of theirs, under another such name.
    const mine = path.join(tmp, 'mine')
    await writeSkill(mine, 'alpha', 'also-theirs')
    await fs.symlink(path.join(mine, 'alpha'), path.join(root, 'alpha'), 'dir')
    // Not a skill at all, under a third. Anything unreadable is left alone.
    await fs.writeFile(path.join(root, 'notes'), 'not a skill dir\n')

    const src = await install(['welcome', 'alpha', 'notes'])
    await reconcileSharedSkillRoots(src, SLUG, 'link')

    expect((await fs.lstat(path.join(root, 'welcome'))).isSymbolicLink()).toBe(false)
    expect(await fs.readFile(path.join(root, 'welcome', 'SKILL.md'), 'utf8')).toContain('the-users-own')
    expect(await fs.readlink(path.join(root, 'alpha'))).toBe(path.join(mine, 'alpha'))
    expect(await fs.readFile(path.join(root, 'notes'), 'utf8')).toBe('not a skill dir\n')
    // Only the claude root was contested; the other roots get every skill.
    expect(await fs.readlink(path.join(piDir(SLUG), 'agent', 'skills', 'welcome')))
      .toBe(path.join(src, 'welcome'))
  })

  it('claims a user link into a dir they named builtin-skills, but never its target', async () => {
    // Any link into a `builtin-skills` dir counts as ours, so a moved
    // install's links stay recognizable. The cost is a user link into a dir
    // of that name, but only the link is touched, never its target.
    const root = path.join(claudeDir(SLUG), 'skills')
    await fs.mkdir(root, { recursive: true })
    const theirs = path.join(tmp, 'notes', 'builtin-skills')
    await writeSkill(theirs, 'welcome', 'theirs-shipped-name')
    await writeSkill(theirs, 'ideas', 'theirs-unshipped-name')
    await fs.symlink(path.join(theirs, 'welcome'), path.join(root, 'welcome'), 'dir')
    await fs.symlink(path.join(theirs, 'ideas'), path.join(root, 'ideas'), 'dir')

    const src = await install(['welcome'])
    await reconcileSharedSkillRoots(src, SLUG, 'link')

    // A shipped name is re-aimed at this install; an unshipped one is pruned.
    expect(await fs.readlink(path.join(root, 'welcome'))).toBe(path.join(src, 'welcome'))
    await expect(fs.lstat(path.join(root, 'ideas'))).rejects.toThrow()
    // Both of their skills are untouched.
    expect(await fs.readFile(path.join(theirs, 'welcome', 'SKILL.md'), 'utf8'))
      .toContain('theirs-shipped-name')
    expect(await fs.readFile(path.join(theirs, 'ideas', 'SKILL.md'), 'utf8'))
      .toContain('theirs-unshipped-name')
  })

  it('re-aims a moved install\'s links and removes a retired skill\'s', async () => {
    const root = path.join(claudeDir(SLUG), 'skills')
    await fs.mkdir(root, { recursive: true })
    // An upgrade leaves links into an install dir that is gone.
    const old = path.join(tmp, 'old-version', 'builtin-skills')
    await fs.symlink(path.join(old, 'welcome'), path.join(root, 'welcome'), 'dir')
    await fs.symlink(path.join(old, 'retired'), path.join(root, 'retired'), 'dir')

    const src = await install(['welcome'], 'new-version')
    expect(await reconcileSharedSkillRoots(src, SLUG, 'link')).toEqual(['welcome'])

    expect(await fs.readlink(path.join(root, 'welcome'))).toBe(path.join(src, 'welcome'))
    // Nothing else cleans the root, so a retired skill is removed here.
    await expect(fs.lstat(path.join(root, 'retired'))).rejects.toThrow()
  })

  it('survives two creates of the same project racing on the same roots', async () => {
    // Both sweeps want the same links, so losing the race must not fail the
    // create.
    const src = await install(['welcome', 'alpha'])
    const [a, b] = await Promise.all([
      reconcileSharedSkillRoots(src, SLUG, 'link'),
      reconcileSharedSkillRoots(src, SLUG, 'link'),
    ])
    expect(a).toEqual(b)
    expect(await fs.readlink(path.join(claudeDir(SLUG), 'skills', 'welcome')))
      .toBe(path.join(src, 'welcome'))
  })

  it('survives a concurrent prune taking the staging link mid-re-aim', async () => {
    // The staging link looks like one of ours under an unshipped name, so a
    // concurrent create can prune it before the rename. That create is
    // converging the same name, so this one must not fail. The race is one
    // syscall wide, so it is staged by stubbing `fs.rename`.
    const root = path.join(claudeDir(SLUG), 'skills')
    await fs.mkdir(root, { recursive: true })
    const old = path.join(tmp, 'old-version', 'builtin-skills')
    await fs.symlink(path.join(old, 'welcome'), path.join(root, 'welcome'), 'dir')
    const src = await install(['welcome'], 'new-version')

    const realRename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await fs.rm(from, { force: true }) // the other create's prune
      return realRename(from, to)
    })
    try {
      await expect(reconcileSharedSkillRoots(src, SLUG, 'link')).resolves.toEqual(['welcome'])
    } finally {
      spy.mockRestore()
    }
    // No staging leftovers, and the name still resolves (to the old link,
    // which the winning create re-aims).
    expect((await fs.readdir(root)).filter((e) => e.startsWith('.'))).toEqual([])
    expect((await fs.lstat(path.join(root, 'welcome'))).isSymbolicLink()).toBe(true)
  })

  it('creates nothing when the install ships no skills (stripped build)', async () => {
    for (const delivery of ['link', 'mountpoint'] as const) {
      expect(await reconcileSharedSkillRoots(path.join(tmp, 'nope'), SLUG, delivery)).toEqual([])
      for (const root of sharedSkillRoots(SLUG)) {
        await expect(fs.access(root)).rejects.toThrow()
      }
    }
  })

  it('makes every mountpoint itself, so the kubelet never creates one root-owned', async () => {
    const root = path.join(claudeDir(SLUG), 'skills')
    // The user's own skill and link under shipped names are left as is.
    await writeSkill(root, 'welcome', 'the-users-own')
    const mine = path.join(tmp, 'mine')
    await writeSkill(mine, 'alpha', 'also-theirs')
    await fs.symlink(path.join(mine, 'alpha'), path.join(root, 'alpha'), 'dir')

    const src = await install(['welcome', 'alpha'])
    expect(await reconcileSharedSkillRoots(src, SLUG, 'mountpoint')).toEqual(['alpha', 'welcome'])

    expect(await fs.readFile(path.join(root, 'welcome', 'SKILL.md'), 'utf8')).toContain('the-users-own')
    expect(await fs.readlink(path.join(root, 'alpha'))).toBe(path.join(mine, 'alpha'))
    // Uncontested names are empty directories; the mount supplies content.
    for (const other of sharedSkillRoots(SLUG).filter((r) => r !== root)) {
      for (const name of ['alpha', 'welcome']) {
        const entry = path.join(other, name)
        expect((await fs.lstat(entry)).isDirectory()).toBe(true)
        expect(await fs.readdir(entry)).toEqual([])
      }
    }
  })

  it('converts either delivery into the other, so an install can switch drivers', async () => {
    const src = await install(['welcome', 'alpha'])
    const claudeRoot = path.join(claudeDir(SLUG), 'skills')

    // containerless → k8s: pods cannot resolve our links, so each becomes a
    // mountpoint.
    await reconcileSharedSkillRoots(src, SLUG, 'link')
    expect(await reconcileSharedSkillRoots(src, SLUG, 'mountpoint')).toEqual(['alpha', 'welcome'])
    for (const root of sharedSkillRoots(SLUG)) {
      for (const name of ['alpha', 'welcome']) {
        const st = await fs.lstat(path.join(root, name))
        expect(st.isSymbolicLink()).toBe(false)
        expect(st.isDirectory()).toBe(true)
      }
    }
    // Every create re-runs this, so it must be idempotent.
    await reconcileSharedSkillRoots(src, SLUG, 'mountpoint')

    // k8s → containerless: the mountpoints become links again.
    await reconcileSharedSkillRoots(src, SLUG, 'link')
    expect(await fs.readFile(path.join(claudeRoot, 'welcome', 'SKILL.md'), 'utf8'))
      .toContain('name: welcome')
    expect(await fs.readlink(path.join(claudeRoot, 'alpha'))).toBe(path.join(src, 'alpha'))
  })

  it('reclaims a spent mountpoint only under a name it ships', async () => {
    const root = path.join(claudeDir(SLUG), 'skills')
    await fs.mkdir(root, { recursive: true })
    // Mountpoints left by an older yaac: one for a shipped name, one for a
    // retired skill.
    await fs.mkdir(path.join(root, 'welcome'))
    await fs.mkdir(path.join(root, 'yaac-spawn'))
    // An empty dir the user made, under no shipped name.
    await fs.mkdir(path.join(root, 'mine-to-be'))

    const src = await install(['welcome'])
    await reconcileSharedSkillRoots(src, SLUG, 'link')

    expect(await fs.readlink(path.join(root, 'welcome'))).toBe(path.join(src, 'welcome'))
    expect((await fs.lstat(path.join(root, 'yaac-spawn'))).isDirectory()).toBe(true)
    expect((await fs.lstat(path.join(root, 'mine-to-be'))).isDirectory()).toBe(true)
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
