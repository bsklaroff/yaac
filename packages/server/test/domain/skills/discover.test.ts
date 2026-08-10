import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import { setDataDir, claudeDir, codexDir, opencodeConfigDir, piDir, repoDir } from '@yaac/shared/project-paths'
import { getProjectSkills, getSkillDetail } from '#domain/skills'
// State hooks for the two caches/overrides discovery reads — reset so a case
// sees only what it opts into. Neither is under test here.
import { setClaudeBundledSkills } from '#domain/skills/claude-bundled'
import { setBuiltinSkillsDir } from '#domain/skills/builtin'

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

/**
 * Every `SKILL.md` shape discovery has to survive, keyed by skill dir name.
 * These drive the frontmatter reader across its whole surface — fence variants,
 * unparseable and non-mapping YAML, and each value type a scalar/boolean/list
 * field has to coerce — and are asserted as the summaries a caller gets back.
 */
const SHAPES: Record<string, string> = {
  'no-frontmatter': '# Just markdown\nno fence here\n',
  malformed: '---\nname: [unterminated\ndescription: x\n---\nbody\n',
  'bom-crlf': '﻿---\r\nname: win\r\ndescription: windows-authored\r\n---\r\nbody\r\n',
  'no-body': '---\nname: headless\ndescription: frontmatter only\n---',
  'list-frontmatter': '---\n- one\n- two\n---\nbody\n',
  'list-description': '---\ndescription:\n  - First line\n  - Second line\n---\nb\n',
  'null-first-description': '---\ndescription:\n  -\n  - Second\n---\nb\n',
  'mapping-description': '---\ndescription:\n  nested: value\n---\nb\n',
  'string-bools': '---\nuser-invocable: "false"\ndisable-model-invocation: "true"\n---\nb\n',
  'yaml-1-1-bools': '---\nuser-invocable: yes\ndisable-model-invocation: no\n---\nb\n',
  'string-tools': '---\nallowed-tools: Read, Bash Grep\n---\nb\n',
  'numeric-tools': '---\nallowed-tools: 42\n---\nb\n',
  'blank-tools': '---\nallowed-tools: "  "\n---\nb\n',
  'null-in-tools': '---\nallowed-tools:\n  - Read\n  -\n---\nb\n',
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
  // A subdir with no SKILL.md, and a loose file, are not skills.
  await writeFile(path.join(claude, 'skills', 'not-a-skill', 'README.md'), 'x')
  await writeFile(path.join(claude, 'skills', 'README.md'), 'x')
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

/** Seed yaac's own shipped tier in a tmp dir and point discovery at it. */
async function seedBuiltin(): Promise<void> {
  const dir = path.join(tmp, 'builtin-skills')
  await writeSkill(
    path.join(dir, 'yaac-welcome'),
    '---\nname: yaac-welcome\ndescription: Orient yourself in a yaac session.\n---\nwelcome-body\n',
  )
  setBuiltinSkillsDir(dir)
}

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

  it('reads a symlinked skill dir like a real one', async () => {
    await writeSkill(path.join(tmp, 'external', 'linked'),
      '---\nname: linked\ndescription: symlinked in\n---\nb')
    await fs.symlink(
      path.join(tmp, 'external', 'linked'),
      path.join(claudeDir(slug), 'skills', 'linked'),
      'dir',
    )
    const found = (await getProjectSkills('claude', slug)).skills.find((s) => s.name === 'linked')
    expect(found).toMatchObject({ source: 'personal', description: 'symlinked in' })
  })

  it('tolerates every SKILL.md frontmatter shape, coercing each field type', async () => {
    const personal = path.join(claudeDir('shapes'), 'skills')
    for (const [name, contents] of Object.entries(SHAPES)) {
      await writeSkill(path.join(personal, name), contents)
    }
    const { skills } = await getProjectSkills('claude', 'shapes')
    const by = (name: string) => skills.find((s) => s.id === `personal:${name}`)

    // No fence, unparseable YAML, and a non-mapping block all degrade to no
    // metadata: the skill still lists, named after its directory.
    for (const name of ['no-frontmatter', 'malformed', 'list-frontmatter']) {
      expect(by(name)).toMatchObject({ name, description: '', userInvocable: true, modelInvocable: true })
      expect(by(name)?.allowedTools).toBeUndefined()
    }
    // A BOM and CRLF line endings do not hide the frontmatter, and a block with
    // no trailing body still parses.
    expect(by('bom-crlf')).toMatchObject({ name: 'win', description: 'windows-authored' })
    expect(by('no-body')).toMatchObject({ name: 'headless', description: 'frontmatter only' })
    // A list-valued description reads as its first entry; a leading empty entry
    // or a nested mapping is not a scalar at all.
    expect(by('list-description')?.description).toBe('First line')
    expect(by('null-first-description')?.description).toBe('')
    expect(by('mapping-description')?.description).toBe('')
    // Quoted booleans still count as booleans; YAML 1.1's yes/no do not (the
    // parser reads them as plain strings), so both flags keep their defaults.
    expect(by('string-bools')).toMatchObject({ userInvocable: false, modelInvocable: false })
    expect(by('yaml-1-1-bools')).toMatchObject({ userInvocable: true, modelInvocable: true })
    // allowed-tools: a scalar splits on spaces/commas; a non-list non-string or
    // content-free value is no list at all; empty entries drop out.
    expect(by('string-tools')?.allowedTools).toEqual(['Read', 'Bash', 'Grep'])
    expect(by('numeric-tools')?.allowedTools).toBeUndefined()
    expect(by('blank-tools')?.allowedTools).toBeUndefined()
    expect(by('null-in-tools')?.allowedTools).toEqual(['Read'])
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

  it('treats unreadable and enabledPlugins-less settings tiers as enabling nothing', async () => {
    // Unparseable JSON, valid JSON without the map, and a non-object map: each
    // tier degrades to "nothing enabled" rather than throwing.
    await writeFile(path.join(claudeDir(slug), 'settings.json'), '{not json')
    await writeFile(path.join(repoDir(slug), '.claude', 'settings.json'), '{"other": 1}')
    await writeFile(path.join(repoDir(slug), '.claude', 'settings.local.json'), '{"enabledPlugins": 5}')

    const { skills } = await getProjectSkills('claude', slug)
    expect(skills.find((s) => s.source === 'plugin')).toBeUndefined()
    // The non-plugin tiers are unaffected.
    expect(skills.map((s) => s.name)).toContain('push-branch')
  })

  it('returns nothing for non-claude tools when nothing is set up', async () => {
    expect((await getProjectSkills('codex', slug)).skills).toEqual([])
  })

  it('is empty-safe when a project has no skill dirs', async () => {
    expect((await getProjectSkills('claude', 'nonexistent')).skills).toEqual([])
  })

  it('appends cached claude bundled skills as list-only system skills, sorted last', async () => {
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

  it('does not append the claude bundled tier to other tools', async () => {
    setClaudeBundledSkills([{ name: 'code-review', description: 'x' }])
    const { skills } = await getProjectSkills('codex', slug)
    expect(skills.find((s) => s.sourceLabel === 'bundled')).toBeUndefined()
  })

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

  it('sorts the yaac builtin tier above the agent bundled tier within system', async () => {
    await seedBuiltin()
    // A bundled skill whose name sorts before the yaac one: rank, not name,
    // must still place yaac first so the viewer heads them as two groups.
    setClaudeBundledSkills([{ name: 'aardvark-review', description: 'x' }])
    const { skills } = await getProjectSkills('claude', slug)
    const system = skills.filter((s) => s.source === 'system')
    expect(system.map((s) => `${s.sourceLabel}:${s.name}`)).toEqual([
      'yaac:yaac-welcome',
      'bundled:aardvark-review',
    ])
  })

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

  it('excludes codex plugins disabled in config.toml or absent from its [plugins] table', async () => {
    await writeSkill(path.join(codexDir(slug), '.tmp', 'plugins', 'plugins', 'sentry', 'skills', 'sentry'),
      '---\nname: sentry\ndescription: cx plugin\n---\nb')
    await seedCodexPlugins(slug, { 'sentry@openai-curated': { enabled: false } })
    expect((await getProjectSkills('codex', slug)).skills.find((s) => s.name === 'sentry')).toBeUndefined()

    // A config.toml that parses but declares no plugins installs nothing.
    await writeFile(path.join(codexDir(slug), 'config.toml'), 'model = "gpt-5-codex"\n')
    expect((await getProjectSkills('codex', slug)).skills.find((s) => s.name === 'sentry')).toBeUndefined()
  })

  it('reads opencode singular + plural native dirs and the claude-compat dir, deduping by id', async () => {
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

  // A fresh slug for the git cases so beforeEach's working-tree writes for
  // `proj` don't interfere.
  it('reads project skills from origin/<default>, ignoring uncommitted working-tree files', async () => {
    await commitRepoBranch('gitproj', 'main', {
      '.claude/skills/committed/SKILL.md': '---\nname: committed\ndescription: on main\n---\nb',
    })
    // A working-tree-only skill must NOT appear — the ref read ignores it.
    await writeSkill(path.join(repoDir('gitproj'), '.claude', 'skills', 'uncommitted'),
      '---\nname: uncommitted\ndescription: working tree only\n---\nb')

    const names = (await getProjectSkills('claude', 'gitproj')).skills.map((s) => s.name)
    expect(names).toContain('committed')
    expect(names).not.toContain('uncommitted')
  })

  it('reads project skills from an explicitly selected branch', async () => {
    await commitRepoBranch('gitproj', 'main', {
      '.claude/skills/on-main/SKILL.md': '---\nname: on-main\ndescription: main\n---\nb',
    })
    await commitRepoBranch('gitproj', 'feature', {
      '.claude/skills/on-feature/SKILL.md': '---\nname: on-feature\ndescription: feature\n---\nb',
    })

    const main = (await getProjectSkills('claude', 'gitproj')).skills.map((s) => s.name)
    expect(main).toContain('on-main')
    expect(main).not.toContain('on-feature')

    const feat = (await getProjectSkills('claude', 'gitproj', 'feature')).skills.map((s) => s.name)
    expect(feat).toContain('on-feature')
    expect(feat).toContain('on-main') // feature was branched off main
  })

  it('gates plugins on enabledPlugins committed to the branch, not the working tree', async () => {
    // The plugin is cloned to the host claude dir (a host tier)...
    await writeSkill(
      path.join(claudeDir('gitproj'), 'plugins', 'marketplaces', 'off', 'plugins', 'code-review', 'skills', 'review'),
      '---\nname: review\ndescription: plugin\n---\nb',
    )
    // ...but enabled only via .claude/settings.json committed on the branch.
    await commitRepoBranch('gitproj', 'main', {
      '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'code-review@off': true } }),
    })

    const { skills } = await getProjectSkills('claude', 'gitproj')
    expect(skills.find((s) => s.source === 'plugin' && s.name === 'review')).toBeDefined()
  })

  it('falls back to the working tree when no origin ref exists (local-only repo)', async () => {
    await writeSkill(path.join(repoDir('gitproj'), '.claude', 'skills', 'wt'),
      '---\nname: wt\ndescription: working tree\n---\nb')
    const names = (await getProjectSkills('claude', 'gitproj')).skills.map((s) => s.name)
    expect(names).toContain('wt')
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

  it('flattens every frontmatter value type for display', async () => {
    await writeSkill(
      path.join(claudeDir(slug), 'skills', 'flat'),
      '---\nname: flat\ndescription:\nallowed-tools: [Read, Grep]\nuser-invocable: true\n'
      + 'metadata:\n  version: "1"\n  author: me\n---\nflat-body\n',
    )
    const detail = await getSkillDetail('claude', slug, 'personal:flat')
    expect(detail.frontmatter).toEqual({
      name: 'flat',
      // an empty `description:` is null and drops out entirely
      'allowed-tools': 'Read, Grep', // lists join
      'user-invocable': 'true', // non-string scalars stringify
      metadata: '{"version":"1","author":"me"}', // nested maps JSON-encode
    })
    expect(detail.body.trim()).toBe('flat-body')
  })

  it('throws NOT_FOUND for an unknown id (no path is taken from the client)', async () => {
    await expect(getSkillDetail('claude', slug, 'personal:../../etc/passwd')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('serves a placeholder body for a list-only claude bundled skill', async () => {
    setClaudeBundledSkills([{ name: 'verify', description: 'Confirm a change works.' }])
    const detail = await getSkillDetail('claude', slug, 'system:bundled:verify')
    expect(detail).toMatchObject({ name: 'verify', source: 'system' })
    expect(detail.body).toContain('Built-in Claude Code skill')
  })

  it('serves the full SKILL.md body for a yaac builtin skill (not a placeholder)', async () => {
    await seedBuiltin()
    const detail = await getSkillDetail('claude', slug, 'system:yaac:yaac-welcome')
    expect(detail).toMatchObject({ name: 'yaac-welcome', source: 'system' })
    expect(detail.body.trim()).toBe('welcome-body')
  })

  it('serves the detail body from the selected branch', async () => {
    await commitRepoBranch('gitproj', 'main', {
      '.claude/skills/doc/SKILL.md': '---\nname: doc\ndescription: d\n---\nfull-body-on-main\n',
    })
    const detail = await getSkillDetail('claude', 'gitproj', 'project:doc')
    expect(detail.body.trim()).toBe('full-body-on-main')
  })
})
