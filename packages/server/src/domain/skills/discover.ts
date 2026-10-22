/**
 * Lists the skills a project's agents can use by reading `SKILL.md` files
 * from their host-side config and the repo, so no running workspace is
 * needed. One skill dir read by several agents (a repo's `.agents/skills`,
 * Claude's home, which opencode also reads) is listed once with every agent
 * that reads it.
 *
 * Each agent's readers are listed highest precedence first, as measured
 * against its binary, which decides which of two same-named skills it loads:
 * Claude prefers its home over the repo, opencode and pi the repo over their
 * homes, and codex loads both (it lists both, and `$name` is then
 * ambiguous).
 *
 * Only each agent's known skill roots are read, one level deep
 * (`<root>/<name>/SKILL.md`), never scanning whole trees.
 *
 * Plugin tiers include only enabled plugins: Claude and Codex clone entire
 * marketplace catalogs to disk, so presence doesn't mean installed. Claude
 * records enabled plugins in `enabledPlugins` across its settings.json tiers;
 * Codex in the `[plugins]` table of `config.toml`.
 *
 * Repo tiers are read from `origin/<branch>` (the main clone's
 * working tree is stale), falling back to the working tree when no such ref
 * exists. Host tiers always read from disk.
 *
 * yaac's own built-ins are listed too. The agents' bundled skills are not:
 * Claude's live in its binary, and readSkills skips Codex's dot-dir
 * (`skills/.system/`).
 */

import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { claudeDir, codexDir, opencodeConfigDir, piDir, projectDir, repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { AGENT_TOOLS, type AgentTool, type ProjectSkills, type SkillDetail, type SkillSummary } from '@yaac/shared/types'
import { getDefaultBranch, listTreeSubdirs, readBlobAt, remoteBranchExists } from '#domain/git'
import { workspacesSandboxed } from '#drivers/driver'
import { openAgentDir, openRoot, type ConfinedRoot } from '#lib/confined-fs'
import { builtinSkillsDir, isBuiltinSkillLink } from './builtin'
import { parseSkillMd, fmString, fmBool, fmList, flattenFrontmatter } from './parse'

/** Where a reader's skills come from. `key` names the location, so two
 *  agents' readers of one dir share it; it prefixes each skill's id. */
type ReaderMeta = Pick<SkillSummary, 'source' | 'home' | 'sourceLabel'> & { key: string }

/**
 * A source of `<name>/SKILL.md` skill dirs, backed by a host directory
 * (`fsReader`) or a git ref (`gitReader`). `list()` yields skill-dir names;
 * `read(name)` yields that dir's `SKILL.md` or null.
 */
interface SkillReader extends ReaderMeta {
  list: () => Promise<string[]>
  read: (name: string) => Promise<string | null>
}

/** A discovered skill plus its raw `SKILL.md`, for the detail view. */
interface DiscoveredSkill extends SkillSummary {
  raw: string
}

/** Size cap for a `SKILL.md`, which is read whole and may be agent-written. */
const MAX_SKILL_MD_BYTES = 256 * 1024

/**
 * A confined host directory to read skills under: tool homes opened with
 * `openAgentDir` (no links where a sandbox can write, so a planted
 * `SKILL.md` link can't expose server files), and the install and checkout
 * dirs as `inside`. Null when missing (no skills).
 */
type HostRoot = ConfinedRoot | null

function toolHome(projectId: string, dir: string): Promise<HostRoot> {
  return openAgentDir(projectDir(projectId), dir, workspacesSandboxed()).catch(() => null)
}

function hostDir(dir: string): Promise<HostRoot> {
  return openRoot(dir, 'inside').catch(() => null)
}

/** A text file under `root`, or null if absent or unreadable. */
async function readText(root: HostRoot, rel: string, maxBytes: number): Promise<string | null> {
  const raw = await root?.readFile(rel, { maxBytes }).catch(() => null)
  return raw?.toString('utf8') ?? null
}

/** Immediate subdirectory names of `rel` (including symlinks, followed only
 *  as far as the root allows), or [] when missing. */
async function subdirs(root: HostRoot, rel: string): Promise<string[]> {
  const entries = await root?.readdir(rel).catch(() => []) ?? []
  return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
}

/** A reader over `<rel>/<name>/SKILL.md` dirs under a host root. */
function fsReader(root: HostRoot, rel: string, meta: ReaderMeta): SkillReader {
  return {
    ...meta,
    list: () => subdirs(root, rel),
    read: (name) => readText(root, `${rel === '' ? '' : `${rel}/`}${name}/SKILL.md`, MAX_SKILL_MD_BYTES),
  }
}

/**
 * A personal-tier reader over one tool's skills root, excluding yaac's
 * builtin links. Under containerless the builtins are linked into these roots
 * (builtin.ts), and the `yaac` reader already lists them.
 */
function personalReader(tool: AgentTool, root: HostRoot, homeDir: string, rel: string): SkillReader {
  const base = fsReader(root, rel, { key: `${tool}/${rel}`, source: 'personal', home: tool })
  return {
    ...base,
    list: async () => {
      const names = await base.list()
      const ours = await Promise.all(names.map((n) => isBuiltinSkillLink(path.join(homeDir, rel, n))))
      return names.filter((_, i) => !ours[i])
    },
  }
}

/** A repo tier over `<treePath>/<name>/SKILL.md`: read at `origin/<branch>`
 *  when `ref` resolves, else from the on-disk working tree (local-only or
 *  unfetched repos). */
function repoReader(repoPath: string, ref: string | null, treePath: string): SkillReader {
  const meta: ReaderMeta = { key: `repo/${treePath}`, source: 'repo', sourceLabel: treePath }
  if (ref) {
    return {
      ...meta,
      list: () => listTreeSubdirs(repoPath, ref, treePath),
      read: (name) => readBlobAt(repoPath, ref, `${treePath}/${name}/SKILL.md`),
    }
  }
  const root = hostDir(repoPath)
  return {
    ...meta,
    list: async () => subdirs(await root, treePath),
    read: async (name) => readText(await root, `${treePath}/${name}/SKILL.md`, MAX_SKILL_MD_BYTES),
  }
}

/** Read a repo file from `origin/<branch>` when `ref` is set, else
 *  from the working tree; null when absent. */
async function readRepoFile(repoPath: string, ref: string | null, relPath: string): Promise<string | null> {
  return ref
    ? readBlobAt(repoPath, ref, relPath)
    : readText(await hostDir(repoPath), relPath, MAX_SETTINGS_BYTES)
}

/** More than any settings file or `config.toml` a person writes. */
const MAX_SETTINGS_BYTES = 1024 * 1024

/** The `origin/<branch>` ref for repo tiers (`branch` defaults to the
 *  remote default), or null to use the working tree when there is no such
 *  remote-tracking ref. */
async function resolveRepoRef(repoPath: string, branch?: string): Promise<string | null> {
  const target = branch?.trim() || (await getDefaultBranch(repoPath).catch(() => ''))
  if (target && (await remoteBranchExists(repoPath, target))) return `origin/${target}`
  return null
}

/** A Claude settings.json's `enabledPlugins` map (`<plugin>@<marketplace>` →
 *  boolean), or `{}` when absent or unparseable. */
function parseEnabledPlugins(raw: string | null): Record<string, unknown> {
  if (raw == null) return {}
  try {
    const parsed = JSON.parse(raw) as { enabledPlugins?: unknown }
    const map = parsed.enabledPlugins
    return map && typeof map === 'object' ? (map as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The `<plugin>@<marketplace>` ids Claude has enabled, merged across the
 *  user, project and local settings (local wins, as in Claude). The user tier
 *  is the host `settings.json`; project and local are read from `ref` like
 *  project skills. */
async function claudeEnabledPluginIds(projectId: string, claude: HostRoot, ref: string | null): Promise<Set<string>> {
  const repo = repoDir(projectId)
  const [user, project, local] = await Promise.all([
    readText(claude, 'settings.json', MAX_SETTINGS_BYTES),
    readRepoFile(repo, ref, '.claude/settings.json'),
    readRepoFile(repo, ref, '.claude/settings.local.json'),
  ])
  const merged = Object.assign(
    {},
    parseEnabledPlugins(user),
    parseEnabledPlugins(project),
    parseEnabledPlugins(local),
  )
  return new Set(Object.entries(merged).filter(([, on]) => on).map(([id]) => id))
}

function pluginMeta(tool: AgentTool, plugin: string): ReaderMeta {
  return { key: `${tool}-plugin/${plugin}`, source: 'plugin', home: tool, sourceLabel: plugin }
}

/** Readers for enabled plugins under Claude's
 *  `plugins/marketplaces/<marketplace>/{plugins,external_plugins}/<plugin>/skills/`,
 *  keeping only dirs whose `<plugin>@<marketplace>` is in `enabledIds`. */
async function claudePluginReaders(claude: HostRoot, enabledIds: Set<string>): Promise<SkillReader[]> {
  const out: SkillReader[] = []
  const marketplaces = 'plugins/marketplaces'
  for (const mkt of await subdirs(claude, marketplaces)) {
    for (const group of ['plugins', 'external_plugins']) {
      const groupDir = `${marketplaces}/${mkt}/${group}`
      for (const plugin of await subdirs(claude, groupDir)) {
        if (!enabledIds.has(`${plugin}@${mkt}`)) continue
        out.push(fsReader(claude, `${groupDir}/${plugin}/skills`, pluginMeta('claude', plugin)))
      }
    }
  }
  return out
}

/** Plugin names Codex has enabled, from `[plugins]` in `config.toml` (keys
 *  `<plugin>@<marketplace>`; `enabled = false` disables). Keyed on the name
 *  before `@`, since `.tmp/plugins/plugins` holds a single marketplace. */
async function codexEnabledPluginNames(codex: HostRoot): Promise<Set<string>> {
  let parsed: unknown
  try {
    parsed = parseToml(await readText(codex, 'config.toml', MAX_SETTINGS_BYTES) ?? '')
  } catch {
    return new Set()
  }
  const plugins = (parsed as { plugins?: Record<string, { enabled?: unknown }> }).plugins
  if (!plugins || typeof plugins !== 'object') return new Set()
  const out = new Set<string>()
  for (const [id, cfg] of Object.entries(plugins)) {
    if (cfg?.enabled === false) continue
    out.add(id.split('@')[0])
  }
  return out
}

/** Readers for enabled plugins under Codex's
 *  `.tmp/plugins/plugins/<plugin>/skills/`. */
async function codexPluginReaders(codex: HostRoot, enabledNames: Set<string>): Promise<SkillReader[]> {
  const out: SkillReader[] = []
  const pluginsDir = '.tmp/plugins/plugins'
  for (const plugin of await subdirs(codex, pluginsDir)) {
    if (!enabledNames.has(plugin)) continue
    out.push(fsReader(codex, `${pluginsDir}/${plugin}/skills`, pluginMeta('codex', plugin)))
  }
  return out
}

async function claudeReaders(projectId: string, ref: string | null): Promise<SkillReader[]> {
  const dir = claudeDir(projectId)
  const claude = await toolHome(projectId, dir)
  return [
    personalReader('claude', claude, dir, 'skills'),
    ...(await claudePluginReaders(claude, await claudeEnabledPluginIds(projectId, claude, ref))),
    repoReader(repoDir(projectId), ref, '.claude/skills'),
  ]
}

async function codexReaders(projectId: string, ref: string | null): Promise<SkillReader[]> {
  const dir = codexDir(projectId)
  const codex = await toolHome(projectId, dir)
  return [
    personalReader('codex', codex, dir, 'skills'),
    ...(await codexPluginReaders(codex, await codexEnabledPluginNames(codex))),
    repoReader(repoDir(projectId), ref, '.agents/skills'),
  ]
}

async function opencodeReaders(projectId: string, ref: string | null): Promise<SkillReader[]> {
  const cfgDir = opencodeConfigDir(projectId)
  const cfg = await toolHome(projectId, cfgDir)
  const claudeHome = claudeDir(projectId)
  const claude = await toolHome(projectId, claudeHome)
  const repo = repoDir(projectId)
  // No plugin tier (opencode plugins are JS modules). It reads `skill/` and
  // `skills/` in its own config dirs plus the Claude- and agents-compatible
  // locations, the last loaded of a name winning: `skills/` after `skill/`,
  // the repo after the home, `.agents` after `.claude`.
  return [
    repoReader(repo, ref, '.opencode/skills'),
    repoReader(repo, ref, '.opencode/skill'),
    personalReader('opencode', cfg, cfgDir, 'skills'),
    personalReader('opencode', cfg, cfgDir, 'skill'),
    repoReader(repo, ref, '.agents/skills'),
    repoReader(repo, ref, '.claude/skills'),
    personalReader('claude', claude, claudeHome, 'skills'),
  ]
}

async function piReaders(projectId: string, ref: string | null): Promise<SkillReader[]> {
  const repo = repoDir(projectId)
  const dir = piDir(projectId)
  // pi's `~/.pi` is per project (piDir), so `agent/skills` is readable;
  // `~/.agents/skills` is not mounted. No plugin tier. A trusted project's
  // dirs come first, as the launch's `--approve` makes it.
  return [
    repoReader(repo, ref, '.pi/skills'),
    repoReader(repo, ref, '.agents/skills'),
    personalReader('pi', await toolHome(projectId, dir), dir, 'agent/skills'),
  ]
}

async function readersFor(tool: AgentTool, projectId: string, ref: string | null): Promise<SkillReader[]> {
  switch (tool) {
    case 'claude': return claudeReaders(projectId, ref)
    case 'codex': return codexReaders(projectId, ref)
    case 'opencode': return opencodeReaders(projectId, ref)
    case 'pi': return piReaders(projectId, ref)
  }
}

/** Build a summary from a parsed SKILL.md and its location. */
function toSummary(raw: string, dirName: string, reader: SkillReader): SkillSummary {
  const { frontmatter } = parseSkillMd(raw)
  const description = [fmString(frontmatter, 'description'), fmString(frontmatter, 'when_to_use')]
    .filter((s): s is string => !!s && s.length > 0)
    .join(' ')
  return {
    id: `${reader.key}:${dirName}`,
    name: fmString(frontmatter, 'name') || dirName,
    description,
    source: reader.source,
    home: reader.home,
    sourceLabel: reader.sourceLabel,
    agents: [],
    overriddenFor: [],
    userInvocable: fmBool(frontmatter, 'user-invocable') !== false,
    modelInvocable: fmBool(frontmatter, 'disable-model-invocation') !== true,
    allowedTools: fmList(frontmatter, 'allowed-tools'),
  }
}

/** Read every `<name>/SKILL.md` a single reader exposes. */
async function readSkills(reader: SkillReader): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = []
  for (const name of await reader.list()) {
    if (name.startsWith('.')) continue // e.g. .system, .git
    const raw = await reader.read(name)
    if (raw == null) continue // a subdir without a SKILL.md is not a skill
    out.push({ ...toSummary(raw, name, reader), raw })
  }
  return out
}

/** List sections, in order: repo dirs, each agent's personal skills, each
 *  agent's plugins, then yaac's built-ins. */
function groupRank(s: SkillSummary): number {
  const tool = s.home ? AGENT_TOOLS.indexOf(s.home) : 0
  switch (s.source) {
    case 'repo': return 0
    case 'personal': return 1 + tool
    case 'plugin': return 10 + tool
    case 'yaac': return 20
  }
}

/**
 * Walk each agent's readers, highest precedence first, crediting every skill
 * to the agents that read its dir. Personal and repo skills share one
 * namespace per agent, where the first of a name wins and later ones are
 * overridden, except for codex, which loads them all; plugin and yaac skills
 * never collide.
 */
async function discover(projectId: string, branch?: string): Promise<DiscoveredSkill[]> {
  const ref = await resolveRepoRef(repoDir(projectId), branch)
  // yaac's built-ins, read from the install dir since in-pod mounts aren't
  // visible here.
  const yaac = fsReader(await hostDir(builtinSkillsDir()), '', { key: 'yaac', source: 'yaac' })
  const perTool = await Promise.all(AGENT_TOOLS.map(async (tool) => [...await readersFor(tool, projectId, ref), yaac]))
  const reads = new Map<string, Promise<DiscoveredSkill[]>>()
  const lists = await Promise.all(perTool.map((readers) => Promise.all(readers.map((r) => {
    if (!reads.has(r.key)) reads.set(r.key, readSkills(r))
    return reads.get(r.key)!
  }))))

  const byId = new Map<string, DiscoveredSkill>()
  AGENT_TOOLS.forEach((tool, i) => {
    const loaded = new Set<string>()
    for (const skill of lists[i].flat()) {
      byId.set(skill.id, skill)
      skill.agents.push(tool)
      const named = tool !== 'codex' && (skill.source === 'personal' || skill.source === 'repo')
      if (named && loaded.has(skill.name)) skill.overriddenFor.push(tool)
      else if (named) loaded.add(skill.name)
    }
  })
  // Repo skills sort by dir first, so each dir is one section.
  const dir = (s: SkillSummary): string => (s.source === 'repo' ? s.sourceLabel ?? '' : '')
  return [...byId.values()].sort((a, b) => groupRank(a) - groupRank(b)
    || dir(a).localeCompare(dir(b)) || a.name.localeCompare(b.name))
}

/** Every skill any of a project's agents can use. `branch` picks the origin
 *  branch for repo tiers (default: the remote's default branch). */
export async function getProjectSkills(projectId: string, branch?: string): Promise<ProjectSkills> {
  const discovered = await discover(projectId, branch)
  const skills: SkillSummary[] = discovered.map(({ raw: _raw, ...summary }) => summary)
  return { skills }
}

/** The full `SKILL.md` for one skill, found by re-running discovery and
 *  matching the id, so the client never supplies a path. `branch` must match
 *  the listing's. */
export async function getSkillDetail(projectId: string, id: string, branch?: string): Promise<SkillDetail> {
  const match = (await discover(projectId, branch)).find((s) => s.id === id)
  if (!match) throw new ServerError('NOT_FOUND', `skill "${id}" not found`)
  const { frontmatter, body } = parseSkillMd(match.raw)
  return {
    id: match.id,
    name: match.name,
    source: match.source,
    frontmatter: flattenFrontmatter(frontmatter),
    body,
  }
}
