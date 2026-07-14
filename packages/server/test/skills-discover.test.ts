import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, claudeDir, codexDir, opencodeConfigDir, piDir, repoDir } from '@yaac/shared/project-paths'
import { getProjectSkills, getSkillDetail } from '#lib/skills/discover'

const slug = 'proj'

async function writeSkill(dir: string, contents: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), contents)
}

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-skills-test-'))
  setDataDir(tmp)

  const claude = claudeDir(slug)
  // Personal
  await writeSkill(
    path.join(claude, 'skills', 'push-branch'),
    '---\nname: push-branch\ndescription: Push to main\ndisable-model-invocation: true\n---\nbody-personal\n',
  )
  // Plugin (nested marketplace tree)
  await writeSkill(
    path.join(claude, 'plugins', 'marketplaces', 'off', 'plugins', 'code-review', 'skills', 'review'),
    '---\ndescription: Review a PR\nallowed-tools: [Read, Grep]\n---\nbody-plugin\n',
  )
  // Project (repo checkout)
  await writeSkill(
    path.join(repoDir(slug), '.claude', 'skills', 'deploy'),
    '---\nname: deploy\ndescription: Deploy it\nuser-invocable: false\n---\nbody-deploy\n',
  )
  // Project skill whose name collides with the personal one → shadowed
  await writeSkill(
    path.join(repoDir(slug), '.claude', 'skills', 'push-branch'),
    '---\nname: push-branch\ndescription: project override\n---\nbody-proj\n',
  )
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('getProjectSkills', () => {
  it('discovers personal, plugin, and project skills sorted by source then name', async () => {
    const { skills } = await getProjectSkills('claude', slug)
    expect(skills.map((s) => [s.source, s.name])).toEqual([
      ['personal', 'push-branch'],
      ['plugin', 'review'],
      ['project', 'deploy'],
      ['project', 'push-branch'],
    ])
  })

  it('maps frontmatter into summary fields', async () => {
    const { skills } = await getProjectSkills('claude', slug)
    const personal = skills.find((s) => s.source === 'personal')
    expect(personal).toMatchObject({
      id: 'personal:push-branch',
      name: 'push-branch',
      description: 'Push to main',
      modelInvocable: false, // disable-model-invocation: true
      userInvocable: true,
    })
    const plugin = skills.find((s) => s.source === 'plugin')
    expect(plugin).toMatchObject({
      name: 'review', // no frontmatter name → directory name
      sourceLabel: 'code-review', // plugin dir before /skills/
      allowedTools: ['Read', 'Grep'],
    })
    const deploy = skills.find((s) => s.name === 'deploy')
    expect(deploy?.userInvocable).toBe(false)
  })

  it('discovers plugin skills under external_plugins too, not just plugins', async () => {
    await writeSkill(
      path.join(claudeDir(slug), 'plugins', 'marketplaces', 'off', 'external_plugins', 'imessage', 'skills', 'access'),
      '---\nname: access\ndescription: external plugin skill\n---\nbody\n',
    )
    const ext = (await getProjectSkills('claude', slug)).skills.find((s) => s.name === 'access')
    expect(ext).toMatchObject({ source: 'plugin', sourceLabel: 'imessage', id: 'plugin:imessage:access' })
  })

  it('marks a project skill shadowed by a same-named personal skill', async () => {
    const { skills } = await getProjectSkills('claude', slug)
    const projPush = skills.find((s) => s.source === 'project' && s.name === 'push-branch')
    expect(projPush?.shadowedBy).toBe('personal')
    // The personal one and the unrelated project skill are not shadowed.
    expect(skills.find((s) => s.source === 'personal')?.shadowedBy).toBeUndefined()
    expect(skills.find((s) => s.name === 'deploy')?.shadowedBy).toBeUndefined()
  })

  it('returns nothing for non-claude tools (not yet wired)', async () => {
    expect((await getProjectSkills('codex', slug)).skills).toEqual([])
  })

  it('is empty-safe when a project has no skill dirs', async () => {
    expect((await getProjectSkills('claude', 'nonexistent')).skills).toEqual([])
  })
})

describe('getSkillDetail', () => {
  it('returns the full body and frontmatter for a discovered id', async () => {
    const detail = await getSkillDetail('claude', slug, 'personal:push-branch')
    expect(detail).toMatchObject({
      id: 'personal:push-branch',
      name: 'push-branch',
      source: 'personal',
    })
    expect(detail.frontmatter).toMatchObject({ description: 'Push to main' })
    expect(detail.body.trim()).toBe('body-personal')
  })

  it('throws NOT_FOUND for an unknown id (no path is taken from the client)', async () => {
    await expect(getSkillDetail('claude', slug, 'personal:../../etc/passwd')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('getProjectSkills (codex)', () => {
  it('reads codex personal + plugin + project dirs and excludes the hidden .system tier', async () => {
    await writeSkill(path.join(codexDir(slug), 'skills', 'push-branch'),
      '---\nname: push-branch\ndescription: cx personal\n---\nb')
    // OpenAI-bundled tier lives under a dot-hidden dir → must not be listed.
    await writeSkill(path.join(codexDir(slug), 'skills', '.system', 'skill-creator'),
      '---\nname: skill-creator\ndescription: bundled\n---\nb')
    await writeSkill(path.join(codexDir(slug), '.tmp', 'plugins', 'plugins', 'sentry', 'skills', 'sentry'),
      '---\nname: sentry\ndescription: cx plugin\n---\nb')
    await writeSkill(path.join(repoDir(slug), '.agents', 'skills', 'deploy'),
      '---\nname: deploy\ndescription: cx project\n---\nb')

    const { skills } = await getProjectSkills('codex', slug)
    expect(skills.map((s) => `${s.source}:${s.name}`)).toEqual([
      'personal:push-branch',
      'plugin:sentry',
      'project:deploy',
    ])
    expect(skills.find((s) => s.name === 'skill-creator')).toBeUndefined()
    expect(skills.find((s) => s.source === 'plugin')?.sourceLabel).toBe('sentry')
  })
})

describe('getProjectSkills (opencode)', () => {
  it('reads singular + plural native dirs and the claude-compat dir, deduping by id', async () => {
    // Global native, singular `skill/` — the tier the old grandparent rule missed.
    await writeSkill(path.join(opencodeConfigDir(slug), 'skill', 'greet'),
      '---\nname: greet\ndescription: oc global singular\n---\nb')
    // Project native `.opencode/skills/deploy` — same name as the beforeEach
    // `.claude/skills/deploy`, so the two collapse to one project:deploy.
    await writeSkill(path.join(repoDir(slug), '.opencode', 'skills', 'deploy'),
      '---\nname: deploy\ndescription: oc project native\n---\nb')

    const { skills } = await getProjectSkills('opencode', slug)
    const names = skills.map((s) => `${s.source}:${s.name}`)
    expect(names).toContain('personal:greet') // singular skill/ found
    expect(names).toContain('personal:push-branch') // reads claudeDir/skills (claude-compat)
    expect(names.filter((n) => n === 'project:deploy')).toHaveLength(1) // deduped
  })
})

describe('getProjectSkills (pi)', () => {
  it('reads pi personal skills from piDir/agent/skills plus project skills from the repo', async () => {
    // pi's whole ~/.pi home is mounted per-project, so its global skills tier
    // (~/.pi/agent/skills) is host-visible.
    await writeSkill(path.join(piDir(slug), 'agent', 'skills', 'globby'),
      '---\nname: globby\ndescription: pi personal skill\n---\nb')
    await writeSkill(path.join(repoDir(slug), '.pi', 'skills', 'ship'),
      '---\nname: ship\ndescription: pi project skill\n---\nb')
    await writeSkill(path.join(repoDir(slug), '.agents', 'skills', 'shared'),
      '---\nname: shared\ndescription: agents-compat skill\n---\nb')

    const { skills } = await getProjectSkills('pi', slug)
    expect(skills.map((s) => `${s.source}:${s.name}`)).toEqual([
      'personal:globby',
      'project:shared',
      'project:ship',
    ])
  })
})
