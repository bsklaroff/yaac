/**
 * Enumerates the skills a project's agent has available by reading the loose
 * `SKILL.md` files under its host-mounted config and repo — no pod, no running
 * session required, since those dirs are all on-host.
 *
 * Discovery reads the *explicit* directories each agent loads skills from at
 * their known layout, rather than recursively scanning a whole tree: every
 * skill lives at `<container>/<name>/SKILL.md`, so we shallow-`readdir` each
 * container and read the one file — never descending into `node_modules`, a
 * plugin's resource dirs, or a marketplace's `.git`. Dispatch is keyed on
 * `AgentTool`; the wire type, route, and UI are agent-agnostic.
 *
 * Out of scope by design: skills embedded in an agent's binary (Claude's
 * bundled skills, Codex's `.system` tier) — there is no supported way to
 * enumerate the former, and the latter is excluded for parity.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { claudeDir, codexDir, opencodeConfigDir, piDir, repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool, ProjectSkills, SkillDetail, SkillSummary, SkillSource } from '@yaac/shared/types'
import { parseSkillMd, fmString, fmBool, fmList, flattenFrontmatter } from '#lib/skills/parse'

/** A directory that directly holds `<name>/SKILL.md` skill dirs. */
interface SkillContainer {
  dir: string
  source: SkillSource
  /** For plugin containers, the plugin the skills came from. */
  sourceLabel?: string
}

/** A discovered skill plus the absolute path we re-read for the detail view. */
interface DiscoveredSkill extends SkillSummary {
  absPath: string
}

/** Immediate subdirectory names of `dir` (symlinked dirs included), or [] when
 *  the dir is missing/unreadable — an absent skills dir just means no skills. */
async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Plugin containers under a Claude-style `plugins/` root, whose installed
 *  layout is `marketplaces/<marketplace>/{plugins,external_plugins}/<plugin>/skills/`. */
async function claudePluginContainers(pluginsRoot: string): Promise<SkillContainer[]> {
  const out: SkillContainer[] = []
  const marketplaces = path.join(pluginsRoot, 'marketplaces')
  for (const mkt of await subdirs(marketplaces)) {
    for (const group of ['plugins', 'external_plugins']) {
      const groupDir = path.join(marketplaces, mkt, group)
      for (const plugin of await subdirs(groupDir)) {
        out.push({ dir: path.join(groupDir, plugin, 'skills'), source: 'plugin', sourceLabel: plugin })
      }
    }
  }
  return out
}

/** Plugin containers under Codex's marketplace clone at
 *  `.tmp/plugins/plugins/<plugin>/skills/`. */
async function codexPluginContainers(pluginsDir: string): Promise<SkillContainer[]> {
  const plugins = await subdirs(pluginsDir)
  return plugins.map((plugin) => ({
    dir: path.join(pluginsDir, plugin, 'skills'),
    source: 'plugin' as const,
    sourceLabel: plugin,
  }))
}

async function claudeContainers(slug: string): Promise<SkillContainer[]> {
  const claude = claudeDir(slug)
  return [
    { dir: path.join(claude, 'skills'), source: 'personal' },
    ...(await claudePluginContainers(path.join(claude, 'plugins'))),
    { dir: path.join(repoDir(slug), '.claude', 'skills'), source: 'project' },
  ]
}

async function codexContainers(slug: string): Promise<SkillContainer[]> {
  const codex = codexDir(slug)
  // `skills/` is read directly, so the dot-hidden `.system/` bundled tier is
  // skipped for free (readContainer ignores dot-dirs).
  return [
    { dir: path.join(codex, 'skills'), source: 'personal' },
    ...(await codexPluginContainers(path.join(codex, '.tmp', 'plugins', 'plugins'))),
    { dir: path.join(repoDir(slug), '.agents', 'skills'), source: 'project' },
  ]
}

function opencodeContainers(slug: string): SkillContainer[] {
  const cfg = opencodeConfigDir(slug)
  const repo = repoDir(slug)
  // opencode has no plugin-skills tier (its plugins are JS modules). Its own
  // dirs accept both singular `skill/` and plural `skills/`; it also reads the
  // Claude- and agents-compatible locations. Ordered by precedence so the
  // dedupe below keeps the winning copy of a same-named skill.
  return [
    { dir: path.join(cfg, 'skill'), source: 'personal' },
    { dir: path.join(cfg, 'skills'), source: 'personal' },
    { dir: path.join(claudeDir(slug), 'skills'), source: 'personal' },
    { dir: path.join(repo, '.opencode', 'skill'), source: 'project' },
    { dir: path.join(repo, '.opencode', 'skills'), source: 'project' },
    { dir: path.join(repo, '.claude', 'skills'), source: 'project' },
    { dir: path.join(repo, '.agents', 'skills'), source: 'project' },
  ]
}

function piContainers(slug: string): SkillContainer[] {
  const repo = repoDir(slug)
  // pi's whole `~/.pi` home is mounted per-project (piDir), so its global
  // `~/.pi/agent/skills` personal tier is host-visible. `~/.agents/skills` is
  // not mounted, so it isn't reachable. Project skills come from the repo.
  // `skills` plural only; no plugin tier.
  return [
    { dir: path.join(piDir(slug), 'agent', 'skills'), source: 'personal' },
    { dir: path.join(repo, '.pi', 'skills'), source: 'project' },
    { dir: path.join(repo, '.agents', 'skills'), source: 'project' },
  ]
}

async function containersFor(tool: AgentTool, slug: string): Promise<SkillContainer[]> {
  switch (tool) {
    case 'claude': return claudeContainers(slug)
    case 'codex': return codexContainers(slug)
    case 'opencode': return opencodeContainers(slug)
    case 'pi': return piContainers(slug)
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

/** Read every `<name>/SKILL.md` directly under one container. */
async function readContainer(c: SkillContainer): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = []
  for (const name of await subdirs(c.dir)) {
    if (name.startsWith('.')) continue // hidden tiers (.system) and VCS dirs (.git)
    const absPath = path.join(c.dir, name, 'SKILL.md')
    let raw: string
    try {
      raw = await fs.readFile(absPath, 'utf8')
    } catch {
      continue // a subdir without a SKILL.md is not a skill
    }
    const summary = toSummary(raw, {
      id: skillId(c.source, c.sourceLabel, name),
      dirName: name,
      source: c.source,
      sourceLabel: c.sourceLabel,
    })
    out.push({ ...summary, absPath })
  }
  return out
}

/** Keep the first skill seen per id — containers are listed in precedence
 *  order, so a native dir wins over a compat dir for the same-named skill. */
function dedupeById(skills: DiscoveredSkill[]): DiscoveredSkill[] {
  const seen = new Set<string>()
  return skills.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
}

/**
 * Mark project skills that a same-named personal skill overrides (personal >
 * project). Plugin skills are namespaced and never collide, so they are left
 * untouched. Shadowed skills stay in the list — the viewer surfaces the state
 * rather than hiding them.
 */
function markShadowed(skills: DiscoveredSkill[]): void {
  const personalNames = new Set(skills.filter((s) => s.source === 'personal').map((s) => s.name))
  for (const s of skills) {
    if (s.source === 'project' && personalNames.has(s.name)) s.shadowedBy = 'personal'
  }
}

const SOURCE_ORDER: Record<SkillSource, number> = { personal: 0, plugin: 1, project: 2 }

async function discover(tool: AgentTool, slug: string): Promise<DiscoveredSkill[]> {
  const containers = await containersFor(tool, slug)
  const perContainer = await Promise.all(containers.map(readContainer))
  const all = dedupeById(perContainer.flat())
  markShadowed(all)
  all.sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.name.localeCompare(b.name))
  return all
}

/** All personal + plugin + project skills available to a project's agent. */
export async function getProjectSkills(tool: AgentTool, slug: string): Promise<ProjectSkills> {
  const discovered = await discover(tool, slug)
  const skills: SkillSummary[] = discovered.map(({ absPath: _absPath, ...summary }) => summary)
  return { skills }
}

/** The full `SKILL.md` for one skill, resolved by re-reading the containers and
 *  matching the id — the client never supplies a filesystem path, so there is
 *  no traversal. */
export async function getSkillDetail(tool: AgentTool, slug: string, id: string): Promise<SkillDetail> {
  const match = (await discover(tool, slug)).find((s) => s.id === id)
  if (!match) throw new ServerError('NOT_FOUND', `skill "${id}" not found`)
  const raw = await fs.readFile(match.absPath, 'utf8').catch(() => '')
  const { frontmatter, body } = parseSkillMd(raw)
  return {
    id: match.id,
    name: match.name,
    source: match.source,
    frontmatter: flattenFrontmatter(frontmatter),
    body,
  }
}
