/**
 * Lists the skills a project's agent can use by reading `SKILL.md` files
 * from its host-side config and repo, so no running workspace is needed.
 *
 * Only each agent's known skill roots are read, one level deep
 * (`<root>/<name>/SKILL.md`), never scanning whole trees.
 *
 * Plugin tiers include only enabled plugins: Claude and Codex clone entire
 * marketplace catalogs to disk, so presence doesn't mean installed. Claude
 * records enabled plugins in `enabledPlugins` across its settings.json tiers;
 * Codex in the `[plugins]` table of `config.toml`.
 *
 * Project (repo) tiers are read from `origin/<branch>` (the main clone's
 * working tree is stale), falling back to the working tree when no such ref
 * exists. Host tiers always read from disk.
 *
 * System tiers: Codex's `.system/` dir on disk, and Claude's bundled skills,
 * listed from the cached commands reference (see claude-bundled.ts).
 */

import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { claudeDir, codexDir, opencodeConfigDir, piDir, repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool, ProjectSkills, SkillDetail, SkillSummary, SkillSource } from '@yaac/shared/types'
import { getDefaultBranch, listTreeSubdirs, readBlobAt, remoteBranchExists } from '#domain/git'
import { openRoot, type ConfinedRoot } from '#lib/confined-fs'
import { openSandboxDir } from '#runtime/agents'
import { getClaudeBundledSkills } from './claude-bundled'
import { builtinSkillsDir, isBuiltinSkillLink } from './builtin'
import { parseSkillMd, fmString, fmBool, fmList, flattenFrontmatter } from './parse'

/**
 * A source of `<name>/SKILL.md` skill dirs, backed by a host directory
 * (`fsReader`) or a git ref (`gitReader`). `list()` yields skill-dir names;
 * `read(name)` yields that dir's `SKILL.md` or null.
 */
interface SkillReader {
  source: SkillSource
  /** For plugin readers, the plugin the skills came from. */
  sourceLabel?: string
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
 * `openSandboxDir` (no links where a sandbox can write, so a planted
 * `SKILL.md` link can't expose server files), and the install and checkout
 * dirs as `inside`. Null when missing (no skills).
 */
type HostRoot = ConfinedRoot | null

function toolHome(projectId: string, dir: string): Promise<HostRoot> {
  return openSandboxDir(projectId, dir).catch(() => null)
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
function fsReader(root: HostRoot, rel: string, source: SkillSource, sourceLabel?: string): SkillReader {
  return {
    source,
    sourceLabel,
    list: () => subdirs(root, rel),
    read: (name) => readText(root, `${rel === '' ? '' : `${rel}/`}${name}/SKILL.md`, MAX_SKILL_MD_BYTES),
  }
}

/**
 * A personal-tier reader over one tool's skills root, excluding yaac's
 * builtin links. Under containerless the builtins are linked into these roots
 * (builtin.ts), and the `system`/`yaac` reader already lists them.
 */
function personalReader(root: HostRoot, homeDir: string, rel: string): SkillReader {
  const base = fsReader(root, rel, 'personal')
  return {
    ...base,
    list: async () => {
      const names = await base.list()
      const ours = await Promise.all(names.map((n) => isBuiltinSkillLink(path.join(homeDir, rel, n))))
      return names.filter((_, i) => !ours[i])
    },
  }
}

/** A reader over `<treePath>/<name>/SKILL.md` dirs at a git ref. */
function gitReader(
  repoPath: string,
  ref: string,
  treePath: string,
  source: SkillSource,
  sourceLabel?: string,
): SkillReader {
  return {
    source,
    sourceLabel,
    list: () => listTreeSubdirs(repoPath, ref, treePath),
    read: (name) => readBlobAt(repoPath, ref, `${treePath}/${name}/SKILL.md`),
  }
}

/** A project (repo) tier: `origin/<branch>` when `ref` resolves, else the
 *  on-disk working tree (local-only/unfetched repos). */
function repoReader(
  repoPath: string,
  ref: string | null,
  treePath: string,
  source: SkillSource,
): SkillReader {
  if (ref) return gitReader(repoPath, ref, treePath, source)
  const root = hostDir(repoPath)
  return {
    source,
    list: async () => subdirs(await root, treePath),
    read: async (name) => readText(await root, `${treePath}/${name}/SKILL.md`, MAX_SKILL_MD_BYTES),
  }
}

/** Read a project (repo) file from `origin/<branch>` when `ref` is set, else
 *  from the working tree; null when absent. */
async function readRepoFile(repoPath: string, ref: string | null, relPath: string): Promise<string | null> {
  return ref
    ? readBlobAt(repoPath, ref, relPath)
    : readText(await hostDir(repoPath), relPath, MAX_SETTINGS_BYTES)
}

/** More than any settings file or `config.toml` a person writes. */
const MAX_SETTINGS_BYTES = 1024 * 1024

/** The `origin/<branch>` ref for project tiers (`branch` defaults to the
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
        out.push(fsReader(claude, `${groupDir}/${plugin}/skills`, 'plugin', plugin))
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
    out.push(fsReader(codex, `${pluginsDir}/${plugin}/skills`, 'plugin', plugin))
  }
  return out
}

async function claudeReaders(projectId: string, ref: string | null): Promise<SkillReader[]> {
  const dir = claudeDir(projectId)
  const claude = await toolHome(projectId, dir)
  return [
    personalReader(claude, dir, 'skills'),
    ...(await claudePluginReaders(claude, await claudeEnabledPluginIds(projectId, claude, ref))),
    repoReader(repoDir(projectId), ref, '.claude/skills', 'project'),
  ]
}

async function codexReaders(projectId: string, ref: string | null): Promise<SkillReader[]> {
  const dir = codexDir(projectId)
  const codex = await toolHome(projectId, dir)
  // readSkills skips dot-dirs, so `skills/.system/` isn't listed as
  // personal; a separate `system` reader is rooted at it.
  return [
    personalReader(codex, dir, 'skills'),
    fsReader(codex, 'skills/.system', 'system'),
    ...(await codexPluginReaders(codex, await codexEnabledPluginNames(codex))),
    repoReader(repoDir(projectId), ref, '.agents/skills', 'project'),
  ]
}

async function opencodeReaders(projectId: string, ref: string | null): Promise<SkillReader[]> {
  const cfgDir = opencodeConfigDir(projectId)
  const cfg = await toolHome(projectId, cfgDir)
  const claudeHome = claudeDir(projectId)
  const claude = await toolHome(projectId, claudeHome)
  const repo = repoDir(projectId)
  // No plugin tier (opencode plugins are JS modules). It reads `skill/` and
  // `skills/` plus the Claude- and agents-compatible locations, listed in
  // precedence order for the dedupe.
  return [
    personalReader(cfg, cfgDir, 'skill'),
    personalReader(cfg, cfgDir, 'skills'),
    personalReader(claude, claudeHome, 'skills'),
    repoReader(repo, ref, '.opencode/skill', 'project'),
    repoReader(repo, ref, '.opencode/skills', 'project'),
    repoReader(repo, ref, '.claude/skills', 'project'),
    repoReader(repo, ref, '.agents/skills', 'project'),
  ]
}

async function piReaders(projectId: string, ref: string | null): Promise<SkillReader[]> {
  const repo = repoDir(projectId)
  const dir = piDir(projectId)
  // pi's `~/.pi` is per project (piDir), so `agent/skills` is readable;
  // `~/.agents/skills` is not mounted. No plugin tier.
  return [
    personalReader(await toolHome(projectId, dir), dir, 'agent/skills'),
    repoReader(repo, ref, '.pi/skills', 'project'),
    repoReader(repo, ref, '.agents/skills', 'project'),
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

/** A stable, source-qualified id: `<source>[:<plugin>]:<name>`. */
function skillId(source: SkillSource, sourceLabel: string | undefined, name: string): string {
  return sourceLabel ? `${source}:${sourceLabel}:${name}` : `${source}:${name}`
}

/** Build a summary from a parsed SKILL.md and its location. */
function toSummary(
  raw: string,
  ctx: { id: string; dirName: string; source: SkillSource; sourceLabel?: string },
): SkillSummary {
  const { frontmatter } = parseSkillMd(raw)
  const description = [fmString(frontmatter, 'description'), fmString(frontmatter, 'when_to_use')]
    .filter((s): s is string => !!s && s.length > 0)
    .join(' ')
  return {
    id: ctx.id,
    name: fmString(frontmatter, 'name') || ctx.dirName,
    description,
    source: ctx.source,
    sourceLabel: ctx.sourceLabel,
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
    const summary = toSummary(raw, {
      id: skillId(reader.source, reader.sourceLabel, name),
      dirName: name,
      source: reader.source,
      sourceLabel: reader.sourceLabel,
    })
    out.push({ ...summary, raw })
  }
  return out
}

/** Keep the first skill per id; readers are in precedence order. */
function dedupeById(skills: DiscoveredSkill[]): DiscoveredSkill[] {
  const seen = new Set<string>()
  return skills.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
}

/**
 * Mark project skills overridden by a same-named personal skill. Plugin
 * skills are namespaced and never collide. Shadowed skills stay listed.
 */
function markShadowed(skills: DiscoveredSkill[]): void {
  const personalNames = new Set(skills.filter((s) => s.source === 'personal').map((s) => s.name))
  for (const s of skills) {
    if (s.source === 'project' && personalNames.has(s.name)) s.shadowedBy = 'personal'
  }
}

const SOURCE_ORDER: Record<SkillSource, number> = { personal: 0, plugin: 1, project: 2, system: 3 }

/** Sort rank by source, with yaac's built-ins above the agent's bundled
 *  ones within `system`, so the viewer can show them as two groups. */
function groupRank(s: SkillSummary): number {
  if (s.source !== 'system') return SOURCE_ORDER[s.source]
  return s.sourceLabel === 'yaac' ? SOURCE_ORDER.system : SOURCE_ORDER.system + 1
}

/** Body shown for a bundled skill, whose full SKILL.md isn't available. */
const BUNDLED_BODY =
  'Built-in Claude Code skill. This summary is from Claude\'s official commands '
  + 'reference (code.claude.com/docs/en/commands); the full instructions are '
  + 'bundled in the Claude binary and load on demand when the skill runs.'

/** Claude's bundled skills from the cache, as `system` skills with a
 *  placeholder body. */
function claudeBundledDiscovered(): DiscoveredSkill[] {
  return getClaudeBundledSkills().map((s): DiscoveredSkill => ({
    id: skillId('system', 'bundled', s.name),
    name: s.name,
    description: s.description,
    source: 'system',
    sourceLabel: 'bundled',
    userInvocable: true,
    modelInvocable: true,
    raw: BUNDLED_BODY,
  }))
}

async function discover(tool: AgentTool, projectId: string, branch?: string): Promise<DiscoveredSkill[]> {
  const ref = await resolveRepoRef(repoDir(projectId), branch)
  const readers = await readersFor(tool, projectId, ref)
  // yaac's built-ins (builtin.ts), read from the install dir since in-pod
  // mounts aren't visible here.
  readers.push(fsReader(await hostDir(builtinSkillsDir()), '', 'system', 'yaac'))
  const perReader = await Promise.all(readers.map(readSkills))
  const flat = perReader.flat()
  if (tool === 'claude') flat.push(...claudeBundledDiscovered())
  const all = dedupeById(flat)
  markShadowed(all)
  all.sort((a, b) => groupRank(a) - groupRank(b) || a.name.localeCompare(b.name))
  return all
}

/** Every skill available to a project's agent. `branch` picks the origin
 *  branch for project tiers (default: the remote's default branch). */
export async function getProjectSkills(tool: AgentTool, projectId: string, branch?: string): Promise<ProjectSkills> {
  const discovered = await discover(tool, projectId, branch)
  const skills: SkillSummary[] = discovered.map(({ raw: _raw, ...summary }) => summary)
  return { skills }
}

/** The full `SKILL.md` for one skill, found by re-running discovery and
 *  matching the id, so the client never supplies a path. `branch` must match
 *  the listing's. */
export async function getSkillDetail(tool: AgentTool, projectId: string, id: string, branch?: string): Promise<SkillDetail> {
  const match = (await discover(tool, projectId, branch)).find((s) => s.id === id)
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
