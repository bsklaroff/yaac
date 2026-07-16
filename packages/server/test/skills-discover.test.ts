import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import { setDataDir, claudeDir, codexDir, opencodeConfigDir, piDir, repoDir } from '@yaac/shared/project-paths'
import { getProjectSkills, getSkillDetail } from '#lib/skills/discover'
import { setClaudeBundledSkills } from '#lib/skills/claude-bundled'
import { setBuiltinSkillsDir } from '#lib/skills/builtin'

const slug = 'proj'

/** Commit `files` (relPath → contents) onto `branch` of a fresh repo at
 *  `repoDir(s)` and publish the `origin/<branch>` remote-tracking ref discovery
 *  reads from — without any network remote. Files already in the working tree
 *  but not passed here stay uncommitted, so a test can prove ref reads ignore
 *  the working copy. */
async function commitRepoBranch(s: string, branch: string, files: Record<string, string>): Promise<void> {
  const repo = repoDir(s)
  await fs.mkdir(repo, { recursive: true })
  const git = simpleGit(repo)
  if (!(await git.checkIsRepo())) await git.raw(['init', '-b', 'main'])
  await git.addConfig('user.email', 'test@example.com')
  await git.addConfig('user.name', 'Test')
  await git.checkout(['-B', branch])
  const paths: string[] = []
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(repo, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, contents)
    paths.push(rel)
  }
  await git.add(paths)
  await git.commit(`skills on ${branch}`)
  const sha = (await git.revparse(['HEAD'])).trim()
  await git.raw(['update-ref', `refs/remotes/origin/${branch}`, sha])
  await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
}

async function writeSkill(dir: string, contents: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), contents)
}

async function writeFile(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
}

/** Seed a Claude settings.json's `enabledPlugins` map so its plugins pass the
 *  installed/enabled gate. Defaults to the project's user-tier settings. */
async function seedClaudeEnabled(
  s: string,
  enabledPlugins: Record<string, boolean>,
  file = path.join(claudeDir(s), 'settings.json'),
): Promise<void> {
  await writeFile(file, JSON.stringify({ enabledPlugins }))
}

/** Seed a Codex config.toml `[plugins]` table entry for a `<plugin>@<mkt>` id. */
async function seedCodexPlugins(s: string, entries: Record<string, { enabled?: boolean }>): Promise<void> {
  const body = Object.entries(entries)
    .map(([id, cfg]) => `[plugins."${id}"]\n${cfg.enabled === undefined ? '' : `enabled = ${cfg.enabled}\n`}`)
    .join('\n')
  await writeFile(path.join(codexDir(s), 'config.toml'), body)
}

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-skills-test-'))
  setDataDir(tmp)
  // The bundled-skills cache is populated by a startup fetch; keep it empty so
  // per-project assertions don't see it unless a test opts in.
  setClaudeBundledSkills([])
  // yaac's shipped builtin-skills tier reads a real packaged dir; point it at a
  // missing dir so per-project assertions don't see it unless a test opts in.
  setBuiltinSkillsDir(path.join(tmp, 'no-builtins'))

  const claude = claudeDir(slug)
  // Personal
  await writeSkill(
    path.join(claude, 'skills', 'push-branch'),
    '---\nname: push-branch\ndescription: Push to main\ndisable-model-invocation: true\n---\nbody-personal\n',
  )
  // Plugin (nested marketplace tree), enabled in settings so it passes the gate
  await writeSkill(
    path.join(claude, 'plugins', 'marketplaces', 'off', 'plugins', 'code-review', 'skills', 'review'),
    '---\ndescription: Review a PR\nallowed-tools: [Read, Grep]\n---\nbody-plugin\n',
  )
  await seedClaudeEnabled(slug, { 'code-review@off': true, 'imessage@off': true })
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
  setBuiltinSkillsDir(null)
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

  it('excludes a plugin present in the marketplace clone but not enabled', async () => {
    // `wallaby@off` is cloned to disk but absent from enabledPlugins.
    await writeSkill(
      path.join(claudeDir(slug), 'plugins', 'marketplaces', 'off', 'plugins', 'wallaby', 'skills', 'trace'),
      '---\nname: trace\ndescription: uninstalled plugin\n---\nb',
    )
    const { skills } = await getProjectSkills('claude', slug)
    expect(skills.find((s) => s.name === 'trace')).toBeUndefined()
    // The enabled code-review plugin still shows.
    expect(skills.find((s) => s.source === 'plugin' && s.name === 'review')).toBeDefined()
  })

  it('excludes a plugin explicitly disabled (enabledPlugins=false)', async () => {
    await seedClaudeEnabled(slug, { 'code-review@off': false })
    const { skills } = await getProjectSkills('claude', slug)
    expect(skills.find((s) => s.source === 'plugin')).toBeUndefined()
  })

  it('enables a plugin from the project/local settings tiers, not just user', async () => {
    // Only user-tier code-review is enabled by beforeEach; enable a second
    // plugin via the repo-local settings.local.json tier.
    await writeSkill(
      path.join(claudeDir(slug), 'plugins', 'marketplaces', 'off', 'plugins', 'ripgrep', 'skills', 'search'),
      '---\nname: search\ndescription: local-tier enabled\n---\nb',
    )
    await seedClaudeEnabled(
      slug,
      { 'ripgrep@off': true },
      path.join(repoDir(slug), '.claude', 'settings.local.json'),
    )
    const { skills } = await getProjectSkills('claude', slug)
    expect(skills.find((s) => s.name === 'search')).toBeDefined()
  })

  it('returns nothing for non-claude tools when nothing is set up', async () => {
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

describe('getProjectSkills (claude bundled tier)', () => {
  it('appends cached bundled skills as list-only system skills, sorted last', async () => {
    setClaudeBundledSkills([
      { name: 'code-review', description: 'Review the current diff.' },
      { name: 'deep-research', description: 'Fan out web searches.' },
    ])
    const { skills } = await getProjectSkills('claude', slug)
    const system = skills.filter((s) => s.source === 'system')
    expect(system.map((s) => `${s.sourceLabel}:${s.name}`)).toEqual([
      'bundled:code-review',
      'bundled:deep-research',
    ])
    expect(skills.at(-1)?.source).toBe('system') // system sorts after the on-disk tiers
    expect(system.find((s) => s.name === 'code-review')).toMatchObject({
      id: 'system:bundled:code-review',
      description: 'Review the current diff.',
    })
  })

  it('serves a placeholder body for a list-only bundled skill', async () => {
    setClaudeBundledSkills([{ name: 'verify', description: 'Confirm a change works.' }])
    const detail = await getSkillDetail('claude', slug, 'system:bundled:verify')
    expect(detail).toMatchObject({ name: 'verify', source: 'system' })
    expect(detail.body).toContain('Built-in Claude Code skill')
  })

  it('does not append the claude bundled tier to other tools', async () => {
    setClaudeBundledSkills([{ name: 'code-review', description: 'x' }])
    const { skills } = await getProjectSkills('codex', slug)
    expect(skills.find((s) => s.sourceLabel === 'bundled')).toBeUndefined()
  })
})

describe('getProjectSkills (yaac builtin tier)', () => {
  async function seedBuiltin(): Promise<void> {
    const dir = path.join(tmp, 'builtin-skills')
    await writeSkill(
      path.join(dir, 'yaac-welcome'),
      '---\nname: yaac-welcome\ndescription: Orient yourself in a yaac session.\n---\nwelcome-body\n',
    )
    setBuiltinSkillsDir(dir)
  }

  it.each(['claude', 'codex', 'opencode', 'pi'] as const)(
    'injects the yaac builtin tier into every tool as system/yaac (%s)',
    async (tool) => {
      await seedBuiltin()
      const { skills } = await getProjectSkills(tool, slug)
      expect(skills.find((s) => s.sourceLabel === 'yaac')).toMatchObject({
        id: 'system:yaac:yaac-welcome',
        name: 'yaac-welcome',
        source: 'system',
        description: 'Orient yourself in a yaac session.',
      })
      // system sorts after the on-disk tiers, so the builtin skill is last.
      expect(skills.at(-1)).toMatchObject({ source: 'system', sourceLabel: 'yaac' })
    },
  )

  it('serves the full SKILL.md body for a builtin skill (not a placeholder)', async () => {
    await seedBuiltin()
    const detail = await getSkillDetail('claude', slug, 'system:yaac:yaac-welcome')
    expect(detail).toMatchObject({ name: 'yaac-welcome', source: 'system' })
    expect(detail.body.trim()).toBe('welcome-body')
  })
})

describe('getProjectSkills (codex)', () => {
  it('reads codex personal + plugin + project dirs plus the built-in .system tier', async () => {
    await writeSkill(path.join(codexDir(slug), 'skills', 'push-branch'),
      '---\nname: push-branch\ndescription: cx personal\n---\nb')
    // OpenAI-bundled tier is materialized to a dot-hidden dir → surfaced as `system`.
    await writeSkill(path.join(codexDir(slug), 'skills', '.system', 'skill-creator'),
      '---\nname: skill-creator\ndescription: bundled\n---\nb')
    await writeSkill(path.join(codexDir(slug), '.tmp', 'plugins', 'plugins', 'sentry', 'skills', 'sentry'),
      '---\nname: sentry\ndescription: cx plugin\n---\nb')
    // A catalog plugin cloned to disk but never installed → excluded.
    await writeSkill(path.join(codexDir(slug), '.tmp', 'plugins', 'plugins', 'stripe', 'skills', 'stripe'),
      '---\nname: stripe\ndescription: cx uninstalled\n---\nb')
    await writeSkill(path.join(repoDir(slug), '.agents', 'skills', 'deploy'),
      '---\nname: deploy\ndescription: cx project\n---\nb')
    await seedCodexPlugins(slug, { 'sentry@openai-curated': {} })

    const { skills } = await getProjectSkills('codex', slug)
    expect(skills.map((s) => `${s.source}:${s.name}`)).toEqual([
      'personal:push-branch',
      'plugin:sentry',
      'project:deploy',
      'system:skill-creator',
    ])
    expect(skills.find((s) => s.name === 'skill-creator')).toMatchObject({
      source: 'system',
      id: 'system:skill-creator',
    })
    expect(skills.find((s) => s.name === 'stripe')).toBeUndefined() // not in config.toml
    expect(skills.find((s) => s.source === 'plugin')?.sourceLabel).toBe('sentry')
  })

  it('reads only .system, not other dot-hidden siblings of skills/, as built-in', async () => {
    await writeSkill(path.join(codexDir(slug), 'skills', '.system', 'skill-creator'),
      '---\nname: skill-creator\ndescription: bundled\n---\nb')
    // A stray dot-dir that isn't the `.system` tier must not leak in.
    await writeSkill(path.join(codexDir(slug), 'skills', '.cache', 'junk'),
      '---\nname: junk\ndescription: not a skill\n---\nb')
    const { skills } = await getProjectSkills('codex', slug)
    expect(skills.map((s) => `${s.source}:${s.name}`)).toEqual(['system:skill-creator'])
  })

  it('excludes a codex plugin whose config.toml entry is disabled', async () => {
    await writeSkill(path.join(codexDir(slug), '.tmp', 'plugins', 'plugins', 'sentry', 'skills', 'sentry'),
      '---\nname: sentry\ndescription: cx plugin\n---\nb')
    await seedCodexPlugins(slug, { 'sentry@openai-curated': { enabled: false } })

    const { skills } = await getProjectSkills('codex', slug)
    expect(skills.find((s) => s.name === 'sentry')).toBeUndefined()
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

describe('getProjectSkills (origin branch)', () => {
  // A fresh slug so beforeEach's working-tree writes for `proj` don't interfere.
  const gslug = 'gitproj'

  it('reads project skills from origin/<default>, ignoring uncommitted working-tree files', async () => {
    await commitRepoBranch(gslug, 'main', {
      '.claude/skills/committed/SKILL.md': '---\nname: committed\ndescription: on main\n---\nb',
    })
    // A working-tree-only skill must NOT appear — the ref read ignores it.
    await writeSkill(path.join(repoDir(gslug), '.claude', 'skills', 'uncommitted'),
      '---\nname: uncommitted\ndescription: working tree only\n---\nb')

    const names = (await getProjectSkills('claude', gslug)).skills.map((s) => s.name)
    expect(names).toContain('committed')
    expect(names).not.toContain('uncommitted')
  })

  it('reads project skills from an explicitly selected branch', async () => {
    await commitRepoBranch(gslug, 'main', {
      '.claude/skills/on-main/SKILL.md': '---\nname: on-main\ndescription: main\n---\nb',
    })
    await commitRepoBranch(gslug, 'feature', {
      '.claude/skills/on-feature/SKILL.md': '---\nname: on-feature\ndescription: feature\n---\nb',
    })

    const main = (await getProjectSkills('claude', gslug)).skills.map((s) => s.name)
    expect(main).toContain('on-main')
    expect(main).not.toContain('on-feature')

    const feat = (await getProjectSkills('claude', gslug, 'feature')).skills.map((s) => s.name)
    expect(feat).toContain('on-feature')
    expect(feat).toContain('on-main') // feature was branched off main
  })

  it('gates plugins on enabledPlugins committed to the branch, not the working tree', async () => {
    // The plugin is cloned to the host claude dir (a host tier)...
    await writeSkill(
      path.join(claudeDir(gslug), 'plugins', 'marketplaces', 'off', 'plugins', 'code-review', 'skills', 'review'),
      '---\nname: review\ndescription: plugin\n---\nb',
    )
    // ...but enabled only via .claude/settings.json committed on the branch.
    await commitRepoBranch(gslug, 'main', {
      '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'code-review@off': true } }),
    })

    const { skills } = await getProjectSkills('claude', gslug)
    expect(skills.find((s) => s.source === 'plugin' && s.name === 'review')).toBeDefined()
  })

  it('serves the detail body from the selected branch', async () => {
    await commitRepoBranch(gslug, 'main', {
      '.claude/skills/doc/SKILL.md': '---\nname: doc\ndescription: d\n---\nfull-body-on-main\n',
    })
    const detail = await getSkillDetail('claude', gslug, 'project:doc')
    expect(detail.body.trim()).toBe('full-body-on-main')
  })

  it('falls back to the working tree when no origin ref exists (local-only repo)', async () => {
    await writeSkill(path.join(repoDir(gslug), '.claude', 'skills', 'wt'),
      '---\nname: wt\ndescription: working tree\n---\nb')
    const names = (await getProjectSkills('claude', gslug)).skills.map((s) => s.name)
    expect(names).toContain('wt')
  })
})
