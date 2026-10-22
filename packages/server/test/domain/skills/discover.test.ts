import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, claudeDir, codexDir, opencodeConfigDir, piDir, repoDir } from '@yaac/shared/project-paths'
import { getProjectSkills, getSkillDetail } from '#domain/skills'
// State hooks, reset so each case sees only the tiers it opts into.
import { setBuiltinSkillsDir } from '#domain/skills/builtin'
import { git } from '@yaac/test-utils/git'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'

// Workspaces sandboxed, as under k8s; a test wanting containerless
// installs its own.
beforeEach(() => { installFakeWorkspaceDriver() })

const projectId = 'proj'

/** Commit `files` (relPath → contents) onto `branch` of a repo at
 *  `repoDir(s)` and set the `origin/<branch>` ref discovery reads, with no
 *  network remote. Other working-tree files stay uncommitted, so a test can
 *  prove ref reads ignore the working copy. */
async function commitRepoBranch(s: string, branch: string, files: Record<string, string>): Promise<void> {
  const repo = repoDir(s)
  await fs.mkdir(repo, { recursive: true })
  const initialized = await fs.access(path.join(repo, '.git')).then(() => true, () => false)
  if (!initialized) await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  await git(repo, ['checkout', '-q', '-B', branch])
  const paths: string[] = []
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(repo, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, contents)
    paths.push(rel)
  }
  await git(repo, ['add', ...paths])
  await git(repo, ['commit', '-m', `skills on ${branch}`])
  const sha = (await git(repo, ['rev-parse', 'HEAD'])).trim()
  await git(repo, ['update-ref', `refs/remotes/origin/${branch}`, sha])
  await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
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
 * Every `SKILL.md` shape discovery must handle, keyed by skill dir name:
 * fence variants, unparseable and non-mapping YAML, and each value type a
 * scalar, boolean or list field must coerce.
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
  // Hide the builtin tier unless a test opts in.
  setBuiltinSkillsDir(path.join(tmp, 'no-builtins'))

  const claude = claudeDir(projectId)
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
  await seedClaudeEnabled(projectId, { 'code-review@off': true, 'imessage@off': true })
  // Repo (checkout)
  await writeSkill(
    path.join(repoDir(projectId), '.claude', 'skills', 'deploy'),
    '---\nname: deploy\ndescription: Deploy it\nuser-invocable: false\n---\nbody-deploy\n',
  )
  // Repo skill whose name collides with the personal one → overridden
  await writeSkill(
    path.join(repoDir(projectId), '.claude', 'skills', 'push-branch'),
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
  it('discovers repo, personal, and plugin skills sorted by section then name', async () => {
    const { skills } = await getProjectSkills(projectId)
    expect(skills.map((s) => [s.source, s.name])).toEqual([
      ['repo', 'deploy'],
      ['repo', 'push-branch'],
      ['personal', 'push-branch'],
      ['plugin', 'review'],
    ])
  })

  it('maps frontmatter into summary fields', async () => {
    const { skills } = await getProjectSkills(projectId)
    const personal = skills.find((s) => s.source === 'personal')
    expect(personal).toMatchObject({
      id: 'claude/skills:push-branch',
      home: 'claude',
      name: 'push-branch',
      description: 'Push to main',
      modelInvocable: false, // disable-model-invocation: true
      userInvocable: true,
    })
    const plugin = skills.find((s) => s.source === 'plugin')
    expect(plugin).toMatchObject({
      name: 'review', // no frontmatter name → directory name
      home: 'claude',
      sourceLabel: 'code-review', // plugin dir before /skills/
      allowedTools: ['Read', 'Grep'],
    })
    const deploy = skills.find((s) => s.name === 'deploy')
    expect(deploy).toMatchObject({ userInvocable: false, sourceLabel: '.claude/skills' })
  })

  it('reads a symlinked skill dir only where no sandbox writes the home', async () => {
    // Under containerless, symlinks are followed while they stay inside the
    // project.
    await writeSkill(path.join(claudeDir(projectId), '..', 'shared-skills', 'linked'),
      '---\nname: linked\ndescription: symlinked in\n---\nb')
    await fs.symlink(
      path.join(claudeDir(projectId), '..', 'shared-skills', 'linked'),
      path.join(claudeDir(projectId), 'skills', 'linked'),
      'dir',
    )
    installFakeWorkspaceDriver({ kind: 'containerless' })
    const found = (await getProjectSkills(projectId)).skills.find((s) => s.name === 'linked')
    expect(found).toMatchObject({ source: 'personal', description: 'symlinked in' })
  })

  it('reads no link a sandbox could have planted in a tool home', async () => {
    // A pod can write the home, so a symlinked SKILL.md could expose any
    // file the server can read.
    const secret = path.join(tmp, 'secret.md')
    await fs.writeFile(secret, '---\nname: leaked\ndescription: server file\n---\nb')
    await fs.mkdir(path.join(claudeDir(projectId), 'skills', 'planted'), { recursive: true })
    await fs.symlink(secret, path.join(claudeDir(projectId), 'skills', 'planted', 'SKILL.md'))
    await fs.symlink(path.dirname(secret), path.join(claudeDir(projectId), 'skills', 'dirlink'), 'dir')
    installFakeWorkspaceDriver({ kind: 'k8s' })
    const names = (await getProjectSkills(projectId)).skills.map((s) => s.name)
    expect(names).not.toContain('leaked')
    expect(names).not.toContain('planted')
    expect(names).not.toContain('dirlink')
  })

  it('tolerates every SKILL.md frontmatter shape, coercing each field type', async () => {
    const personal = path.join(claudeDir('shapes'), 'skills')
    for (const [name, contents] of Object.entries(SHAPES)) {
      await writeSkill(path.join(personal, name), contents)
    }
    const { skills } = await getProjectSkills('shapes')
    const by = (name: string) => skills.find((s) => s.id === `claude/skills:${name}`)

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
      path.join(claudeDir(projectId), 'plugins', 'marketplaces', 'off', 'external_plugins', 'imessage', 'skills', 'access'),
      '---\nname: access\ndescription: external plugin skill\n---\nbody\n',
    )
    const ext = (await getProjectSkills(projectId)).skills.find((s) => s.name === 'access')
    expect(ext).toMatchObject({ source: 'plugin', sourceLabel: 'imessage', id: 'claude-plugin/imessage:access' })
  })

  it('credits each skill to the agents that read its dir, each overriding by its own precedence', async () => {
    const { skills } = await getProjectSkills(projectId)
    const agents = (source: string, name: string) => {
      const s = skills.find((k) => k.source === source && k.name === name)
      return { agents: s?.agents, overriddenFor: s?.overriddenFor }
    }
    // opencode reads Claude's home and `.claude/skills` too, but prefers the
    // repo copy where Claude prefers its home.
    expect(agents('personal', 'push-branch')).toEqual({ agents: ['claude', 'opencode'], overriddenFor: ['opencode'] })
    expect(agents('repo', 'push-branch')).toEqual({ agents: ['claude', 'opencode'], overriddenFor: ['claude'] })
    expect(agents('repo', 'deploy')).toEqual({ agents: ['claude', 'opencode'], overriddenFor: [] })
    expect(agents('plugin', 'review')).toEqual({ agents: ['claude'], overriddenFor: [] })
  })

  it('resolves a name clash in each agent\'s own measured order, and codex loads every copy', async () => {
    const p = 'clash'
    const repo = repoDir(p)
    /** Every dir an agent may read a `push` skill from, by its skill id. */
    const dirs: Record<string, string> = {
      'claude/skills:push': path.join(claudeDir(p), 'skills', 'push'),
      'codex/skills:push': path.join(codexDir(p), 'skills', 'push'),
      'opencode/skills:push': path.join(opencodeConfigDir(p), 'skills', 'push'),
      'opencode/skill:push': path.join(opencodeConfigDir(p), 'skill', 'push'),
      'pi/agent/skills:push': path.join(piDir(p), 'agent', 'skills', 'push'),
      'repo/.claude/skills:push': path.join(repo, '.claude', 'skills', 'push'),
      'repo/.agents/skills:push': path.join(repo, '.agents', 'skills', 'push'),
      'repo/.opencode/skills:push': path.join(repo, '.opencode', 'skills', 'push'),
      'repo/.opencode/skill:push': path.join(repo, '.opencode', 'skill', 'push'),
      'repo/.pi/skills:push': path.join(repo, '.pi', 'skills', 'push'),
    }
    // Highest first: each round drops the winner and expects the next.
    const order = {
      claude: ['claude/skills:push', 'repo/.claude/skills:push'],
      opencode: [
        'repo/.opencode/skills:push', 'repo/.opencode/skill:push', 'opencode/skills:push', 'opencode/skill:push',
        'repo/.agents/skills:push', 'repo/.claude/skills:push', 'claude/skills:push',
      ],
      pi: ['repo/.pi/skills:push', 'repo/.agents/skills:push', 'pi/agent/skills:push'],
    } as const
    const seedAll = async () => {
      for (const dir of Object.values(dirs)) await writeSkill(dir, '---\nname: push\n---\nb')
    }
    const loadedBy = async (tool: string) => (await getProjectSkills(p)).skills
      .filter((s) => s.agents.includes(tool as never) && !s.overriddenFor.includes(tool as never)).map((s) => s.id)

    for (const [tool, ids] of Object.entries(order)) {
      await seedAll()
      for (const id of ids) {
        expect(await loadedBy(tool), `${tool} with ${id} highest left`).toEqual([id])
        await fs.rm(dirs[id], { recursive: true })
      }
    }
    await seedAll()
    expect(await loadedBy('codex')).toEqual(['repo/.agents/skills:push', 'codex/skills:push'])
  })

  it('excludes a plugin present in the marketplace clone but not enabled', async () => {
    // `wallaby@off` is cloned to disk but absent from enabledPlugins.
    await writeSkill(
      path.join(claudeDir(projectId), 'plugins', 'marketplaces', 'off', 'plugins', 'wallaby', 'skills', 'trace'),
      '---\nname: trace\ndescription: uninstalled plugin\n---\nb',
    )
    const { skills } = await getProjectSkills(projectId)
    expect(skills.find((s) => s.name === 'trace')).toBeUndefined()
    // The enabled code-review plugin still shows.
    expect(skills.find((s) => s.source === 'plugin' && s.name === 'review')).toBeDefined()
  })

  it('excludes a plugin explicitly disabled (enabledPlugins=false)', async () => {
    await seedClaudeEnabled(projectId, { 'code-review@off': false })
    const { skills } = await getProjectSkills(projectId)
    expect(skills.find((s) => s.source === 'plugin')).toBeUndefined()
  })

  it('enables a plugin from the project/local settings tiers, not just user', async () => {
    // Only user-tier code-review is enabled by beforeEach; enable a second
    // plugin via the repo-local settings.local.json tier.
    await writeSkill(
      path.join(claudeDir(projectId), 'plugins', 'marketplaces', 'off', 'plugins', 'ripgrep', 'skills', 'search'),
      '---\nname: search\ndescription: local-tier enabled\n---\nb',
    )
    await seedClaudeEnabled(
      projectId,
      { 'ripgrep@off': true },
      path.join(repoDir(projectId), '.claude', 'settings.local.json'),
    )
    const { skills } = await getProjectSkills(projectId)
    expect(skills.find((s) => s.name === 'search')).toBeDefined()
  })

  it('treats unreadable and enabledPlugins-less settings tiers as enabling nothing', async () => {
    // Unparseable JSON, valid JSON without the map, and a non-object map: each
    // tier degrades to "nothing enabled" rather than throwing.
    await writeFile(path.join(claudeDir(projectId), 'settings.json'), '{not json')
    await writeFile(path.join(repoDir(projectId), '.claude', 'settings.json'), '{"other": 1}')
    await writeFile(path.join(repoDir(projectId), '.claude', 'settings.local.json'), '{"enabledPlugins": 5}')

    const { skills } = await getProjectSkills(projectId)
    expect(skills.find((s) => s.source === 'plugin')).toBeUndefined()
    // The non-plugin tiers are unaffected.
    expect(skills.map((s) => s.name)).toContain('push-branch')
  })

  it('credits nothing to codex or pi when only claude dirs are set up', async () => {
    const { skills } = await getProjectSkills(projectId)
    expect(skills.filter((s) => s.agents.includes('codex') || s.agents.includes('pi'))).toEqual([])
  })

  it('is empty-safe when a project has no skill dirs', async () => {
    expect((await getProjectSkills('nonexistent')).skills).toEqual([])
  })

  it('injects the yaac builtin tier into every tool', async () => {
    await seedBuiltin()
    const { skills } = await getProjectSkills(projectId)
    expect(skills.find((s) => s.source === 'yaac')).toMatchObject({
      id: 'yaac:yaac-welcome',
      name: 'yaac-welcome',
      description: 'Orient yourself in a yaac session.',
      agents: ['claude', 'codex', 'opencode', 'pi'],
    })
    // yaac sorts after the on-disk tiers, so the builtin skill is last.
    expect(skills.at(-1)).toMatchObject({ source: 'yaac' })
  })

  it('lists a builtin linked into a personal root once, as yaac rather than personal', async () => {
    // Under containerless, yaac's builtins are linked into the shared skill
    // roots. They must not be listed again as `personal`.
    await seedBuiltin()
    const builtin = path.join(tmp, 'builtin-skills', 'yaac-welcome')
    for (const root of [path.join(claudeDir(projectId), 'skills'), path.join(piDir(projectId), 'agent', 'skills')]) {
      await fs.mkdir(root, { recursive: true })
      await fs.symlink(builtin, path.join(root, 'yaac-welcome'), 'dir')
    }
    // The user's own symlink in the same root stays personal.
    const theirs = path.join(claudeDir(projectId), '..', 'shared-skills', 'theirs')
    await writeSkill(theirs, '---\nname: theirs\ndescription: t\n---\nb')
    await fs.symlink(theirs, path.join(claudeDir(projectId), 'skills', 'theirs'), 'dir')
    installFakeWorkspaceDriver({ kind: 'containerless' })

    const { skills } = await getProjectSkills(projectId)
    expect(skills.filter((s) => s.name === 'yaac-welcome').map((s) => s.source)).toEqual(['yaac'])
    expect((await getProjectSkills(projectId)).skills.find((s) => s.name === 'theirs'))
      .toMatchObject({ source: 'personal' })
  })

  it('reads codex personal + plugin + project dirs', async () => {
    await writeSkill(path.join(codexDir(projectId), 'skills', 'push-branch'),
      '---\nname: push-branch\ndescription: cx personal\n---\nb')
    await writeSkill(path.join(codexDir(projectId), '.tmp', 'plugins', 'plugins', 'sentry', 'skills', 'sentry'),
      '---\nname: sentry\ndescription: cx plugin\n---\nb')
    // A catalog plugin cloned to disk but never installed → excluded.
    await writeSkill(path.join(codexDir(projectId), '.tmp', 'plugins', 'plugins', 'stripe', 'skills', 'stripe'),
      '---\nname: stripe\ndescription: cx uninstalled\n---\nb')
    await writeSkill(path.join(repoDir(projectId), '.agents', 'skills', 'deploy'),
      '---\nname: deploy\ndescription: cx project\n---\nb')
    await seedCodexPlugins(projectId, { 'sentry@openai-curated': {} })

    const skills = (await getProjectSkills(projectId)).skills.filter((s) => s.agents.includes('codex'))
    expect(skills.map((s) => `${s.source}:${s.name}`)).toEqual([
      'repo:deploy',
      'personal:push-branch',
      'plugin:sentry',
    ])
    expect(skills.find((s) => s.source === 'repo')).toMatchObject({ sourceLabel: '.agents/skills' })
    expect(skills.find((s) => s.name === 'push-branch')).toMatchObject({ home: 'codex', agents: ['codex'] })
    expect(skills.find((s) => s.name === 'stripe')).toBeUndefined() // not in config.toml
    expect(skills.find((s) => s.source === 'plugin')?.sourceLabel).toBe('sentry')
  })

  it('lists no dot-dir under a skills root, so not Codex\'s bundled .system tier', async () => {
    await writeSkill(path.join(codexDir(projectId), 'skills', '.system', 'skill-creator'),
      '---\nname: skill-creator\ndescription: bundled\n---\nb')
    await writeSkill(path.join(codexDir(projectId), 'skills', '.cache', 'junk'),
      '---\nname: junk\ndescription: not a skill\n---\nb')
    const { skills } = await getProjectSkills(projectId)
    expect(skills.filter((s) => s.home === 'codex')).toEqual([])
  })

  it('excludes codex plugins disabled in config.toml or absent from its [plugins] table', async () => {
    await writeSkill(path.join(codexDir(projectId), '.tmp', 'plugins', 'plugins', 'sentry', 'skills', 'sentry'),
      '---\nname: sentry\ndescription: cx plugin\n---\nb')
    await seedCodexPlugins(projectId, { 'sentry@openai-curated': { enabled: false } })
    expect((await getProjectSkills(projectId)).skills.find((s) => s.name === 'sentry')).toBeUndefined()

    // A config.toml that parses but declares no plugins installs nothing.
    await writeFile(path.join(codexDir(projectId), 'config.toml'), 'model = "gpt-5-codex"\n')
    expect((await getProjectSkills(projectId)).skills.find((s) => s.name === 'sentry')).toBeUndefined()
  })

  it('reads opencode singular + plural native dirs and the claude-compat dirs, in precedence order', async () => {
    // Global native, singular `skill/` dir.
    await writeSkill(path.join(opencodeConfigDir(projectId), 'skill', 'greet'),
      '---\nname: greet\ndescription: oc global singular\n---\nb')
    // Repo native `.opencode/skills/deploy`, same name as the beforeEach
    // `.claude/skills/deploy`: opencode loads its own, Claude the other.
    await writeSkill(path.join(repoDir(projectId), '.opencode', 'skills', 'deploy'),
      '---\nname: deploy\ndescription: oc project native\n---\nb')

    const { skills } = await getProjectSkills(projectId)
    const credit = (id: string) => {
      const s = skills.find((k) => k.id === id)
      return [s?.agents, s?.overriddenFor]
    }
    expect(credit('opencode/skill:greet')).toEqual([['opencode'], []]) // singular skill/ found
    // claude-compat, though opencode prefers the repo's `.claude/skills/push-branch`.
    expect(credit('claude/skills:push-branch')).toEqual([['claude', 'opencode'], ['opencode']])
    expect(credit('repo/.opencode/skills:deploy')).toEqual([['opencode'], []])
    expect(credit('repo/.claude/skills:deploy')).toEqual([['claude', 'opencode'], ['opencode']])
  })

  it('reads pi personal skills from piDir/agent/skills plus project skills from the repo', async () => {
    // pi's ~/.pi home is per-project, so its global skills tier is visible
    // on the host.
    await writeSkill(path.join(piDir(projectId), 'agent', 'skills', 'globby'),
      '---\nname: globby\ndescription: pi personal skill\n---\nb')
    await writeSkill(path.join(repoDir(projectId), '.pi', 'skills', 'ship'),
      '---\nname: ship\ndescription: pi project skill\n---\nb')
    await writeSkill(path.join(repoDir(projectId), '.agents', 'skills', 'shared'),
      '---\nname: shared\ndescription: agents-compat skill\n---\nb')

    const skills = (await getProjectSkills(projectId)).skills.filter((s) => s.agents.includes('pi'))
    expect(skills.map((s) => `${s.source}:${s.name}`)).toEqual([
      'repo:shared',
      'repo:ship',
      'personal:globby',
    ])
    // `.agents/skills` is the cross-agent dir.
    expect(skills.find((s) => s.name === 'shared')?.agents).toEqual(['codex', 'opencode', 'pi'])
  })

  // A separate slug so beforeEach's working-tree writes don't interfere.
  it('reads repo skills from origin/<default>, ignoring uncommitted working-tree files', async () => {
    await commitRepoBranch('gitproj', 'main', {
      '.claude/skills/committed/SKILL.md': '---\nname: committed\ndescription: on main\n---\nb',
    })
    // A working-tree-only skill must NOT appear — the ref read ignores it.
    await writeSkill(path.join(repoDir('gitproj'), '.claude', 'skills', 'uncommitted'),
      '---\nname: uncommitted\ndescription: working tree only\n---\nb')

    const names = (await getProjectSkills('gitproj')).skills.map((s) => s.name)
    expect(names).toContain('committed')
    expect(names).not.toContain('uncommitted')
  })

  it('reads repo skills from an explicitly selected branch', async () => {
    await commitRepoBranch('gitproj', 'main', {
      '.claude/skills/on-main/SKILL.md': '---\nname: on-main\ndescription: main\n---\nb',
    })
    await commitRepoBranch('gitproj', 'feature', {
      '.claude/skills/on-feature/SKILL.md': '---\nname: on-feature\ndescription: feature\n---\nb',
    })

    const main = (await getProjectSkills('gitproj')).skills.map((s) => s.name)
    expect(main).toContain('on-main')
    expect(main).not.toContain('on-feature')

    const feat = (await getProjectSkills('gitproj', 'feature')).skills.map((s) => s.name)
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

    const { skills } = await getProjectSkills('gitproj')
    expect(skills.find((s) => s.source === 'plugin' && s.name === 'review')).toBeDefined()
  })

  it('falls back to the working tree when no origin ref exists (local-only repo)', async () => {
    await writeSkill(path.join(repoDir('gitproj'), '.claude', 'skills', 'wt'),
      '---\nname: wt\ndescription: working tree\n---\nb')
    const names = (await getProjectSkills('gitproj')).skills.map((s) => s.name)
    expect(names).toContain('wt')
  })
})

describe('getSkillDetail', () => {
  it('returns the full body and frontmatter for a discovered id', async () => {
    const detail = await getSkillDetail(projectId, 'claude/skills:push-branch')
    expect(detail).toMatchObject({
      id: 'claude/skills:push-branch',
      name: 'push-branch',
      source: 'personal',
    })
    expect(detail.frontmatter).toMatchObject({ description: 'Push to main' })
    expect(detail.body.trim()).toBe('body-personal')
  })

  it('flattens every frontmatter value type for display', async () => {
    await writeSkill(
      path.join(claudeDir(projectId), 'skills', 'flat'),
      '---\nname: flat\ndescription:\nallowed-tools: [Read, Grep]\nuser-invocable: true\n'
      + 'metadata:\n  version: "1"\n  author: me\n---\nflat-body\n',
    )
    const detail = await getSkillDetail(projectId, 'claude/skills:flat')
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
    await expect(getSkillDetail(projectId, 'claude/skills:../../etc/passwd')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('serves the full SKILL.md body for a yaac builtin skill (not a placeholder)', async () => {
    await seedBuiltin()
    const detail = await getSkillDetail(projectId, 'yaac:yaac-welcome')
    expect(detail).toMatchObject({ name: 'yaac-welcome', source: 'yaac' })
    expect(detail.body.trim()).toBe('welcome-body')
  })

  it('serves the detail body from the selected branch', async () => {
    await commitRepoBranch('gitproj', 'main', {
      '.claude/skills/doc/SKILL.md': '---\nname: doc\ndescription: d\n---\nfull-body-on-main\n',
    })
    const detail = await getSkillDetail('gitproj', 'repo/.claude/skills:doc')
    expect(detail.body.trim()).toBe('full-body-on-main')
  })
})
