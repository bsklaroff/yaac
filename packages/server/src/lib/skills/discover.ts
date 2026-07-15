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
 * Plugin tiers are gated on the agent's *installed/enabled* set, not on mere
 * on-disk presence: both Claude and Codex clone a marketplace's entire catalog
 * to disk (hundreds of plugins) whether or not you installed them, so listing
 * every dir would surface skills the agent can't actually invoke. Installing a
 * plugin records it in the agent's config — Claude in `enabledPlugins` across
 * its settings.json tiers, Codex in the `[plugins]` table of `config.toml` —
 * and disabling flips it off there while leaving the clone in place. We read
 * that config and keep only the enabled plugins.
 *
 * Project (repo) tiers are read from `origin/<branch>` rather than the on-disk
 * working tree, matching the branch the changes/diff pane compares against: the
 * base clone's checkout is frozen at clone time and drifts behind origin, and a
 * caller (the skills dialog's branch picker) may want a branch other than the
 * default anyway. `resolveRepoRef` turns the picked branch into an `origin/…`
 * ref via the clone's remote-tracking refs, falling back to the working tree
 * when no such ref exists (a local-only or unfetched repo). Host tiers
 * (personal, plugins, Codex's `config.toml`) are never repo checks, so they
 * always read the on-disk files regardless of branch.
 *
 * Out of scope by design: skills embedded in an agent's binary (Claude's
 * bundled skills, Codex's `.system` tier) — there is no supported way to
 * enumerate the former, and the latter is excluded for parity.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { parse as parseToml } from 'smol-toml'
import { claudeDir, codexDir, opencodeConfigDir, piDir, repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool, ProjectSkills, SkillDetail, SkillSummary, SkillSource } from '@yaac/shared/types'
import { getDefaultBranch, remoteBranchExists } from '#lib/git'
import { parseSkillMd, fmString, fmBool, fmList, flattenFrontmatter } from '#lib/skills/parse'

/**
 * A source of `<name>/SKILL.md` skill dirs. Abstracted over the backing store
 * so a host directory (`fsContainer`) and a project tree at a git ref
 * (`gitContainer`) look the same to the scan: `list()` yields the immediate
 * skill-dir names, `read(name)` yields that dir's `SKILL.md` (or null).
 */
interface SkillContainer {
  source: SkillSource
  /** For plugin containers, the plugin the skills came from. */
  sourceLabel?: string
  list: () => Promise<string[]>
  read: (name: string) => Promise<string | null>
}

/** A discovered skill plus a thunk that re-reads its SKILL.md for the detail
 *  view (the store — host file or git blob — is captured by the closure). */
interface DiscoveredSkill extends SkillSummary {
  read: () => Promise<string | null>
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

/** Immediate subtree names of `treePath` at `ref`, or [] when the tree is
 *  missing. Only real subtrees count — a committed skill dir is a tree, so
 *  blobs (including symlinks, which git stores as blobs) are excluded. */
async function gitTreeSubdirs(repoPath: string, ref: string, treePath: string): Promise<string[]> {
  try {
    const out = await simpleGit(repoPath).raw(['ls-tree', `${ref}:${treePath}`])
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l.split(/\s+/)[1] === 'tree')
      .map((l) => l.slice(l.indexOf('\t') + 1))
  } catch {
    return [] // missing tree (path absent at this ref) → no skills
  }
}

/** The blob at `ref:blobPath`, or null when it doesn't exist. */
async function gitReadBlob(repoPath: string, ref: string, blobPath: string): Promise<string | null> {
  try {
    return await simpleGit(repoPath).raw(['show', `${ref}:${blobPath}`])
  } catch {
    return null
  }
}

/** A container reading `<name>/SKILL.md` from a host directory. */
function fsContainer(dir: string, source: SkillSource, sourceLabel?: string): SkillContainer {
  return {
    source,
    sourceLabel,
    list: () => subdirs(dir),
    read: (name) => fs.readFile(path.join(dir, name, 'SKILL.md'), 'utf8').catch(() => null),
  }
}

/** A container reading `<treePath>/<name>/SKILL.md` from a git ref. */
function gitContainer(
  repoPath: string,
  ref: string,
  treePath: string,
  source: SkillSource,
  sourceLabel?: string,
): SkillContainer {
  return {
    source,
    sourceLabel,
    list: () => gitTreeSubdirs(repoPath, ref, treePath),
    read: (name) => gitReadBlob(repoPath, ref, `${treePath}/${name}/SKILL.md`),
  }
}

/** A project (repo) tier: `origin/<branch>` when `ref` resolves, else the
 *  on-disk working tree (local-only/unfetched repos). */
function repoContainer(
  repoPath: string,
  ref: string | null,
  treePath: string,
  source: SkillSource,
  sourceLabel?: string,
): SkillContainer {
  return ref
    ? gitContainer(repoPath, ref, treePath, source, sourceLabel)
    : fsContainer(path.join(repoPath, treePath), source, sourceLabel)
}

/** Read a project (repo) file from `origin/<branch>` when `ref` is set, else
 *  from the working tree; null when absent. */
function readRepoFile(repoPath: string, ref: string | null, relPath: string): Promise<string | null> {
  return ref
    ? gitReadBlob(repoPath, ref, relPath)
    : fs.readFile(path.join(repoPath, relPath), 'utf8').catch(() => null)
}

/** The `origin/<branch>` ref project tiers should read from, or null to fall
 *  back to the working tree. `branch` is the caller's pick; absent, the remote
 *  default (origin/HEAD) is used. Returns null when the branch has no
 *  remote-tracking ref — an unfetched or local-only repo — so discovery
 *  degrades to the on-disk checkout instead of failing. */
async function resolveRepoRef(repoPath: string, branch?: string): Promise<string | null> {
  const target = branch?.trim() || (await getDefaultBranch(repoPath).catch(() => ''))
  if (target && (await remoteBranchExists(repoPath, target))) return `origin/${target}`
  return null
}

/** Parse a Claude settings.json's `enabledPlugins` map out of raw text, or `{}`
 *  when absent/unparseable. Keys are `<plugin>@<marketplace>`; values are
 *  booleans (installing writes `true`, disabling writes `false`). */
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

/** The `<plugin>@<marketplace>` ids Claude has enabled for a project, merged
 *  across the user → project → local settings tiers (local wins, matching
 *  Claude's own precedence). The user tier is the host `~/.claude/settings.json`;
 *  the project/local tiers are repo checks, read from `ref` (origin/<branch>)
 *  like the project skills themselves. A plugin counts as installed exactly
 *  when its id is present and truthy here, so plugins that only exist in the
 *  on-disk marketplace clone — never installed — are excluded. */
async function claudeEnabledPluginIds(slug: string, ref: string | null): Promise<Set<string>> {
  const repo = repoDir(slug)
  const [user, project, local] = await Promise.all([
    fs.readFile(path.join(claudeDir(slug), 'settings.json'), 'utf8').catch(() => null),
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

/** Enabled plugin containers under a Claude-style `plugins/` root, whose
 *  installed layout is `marketplaces/<marketplace>/{plugins,external_plugins}/<plugin>/skills/`.
 *  The `<plugin>` and `<marketplace>` dir names are the same names Claude keys
 *  `enabledPlugins` on, so a dir survives only when `<plugin>@<marketplace>` is
 *  in `enabledIds`. */
async function claudePluginContainers(pluginsRoot: string, enabledIds: Set<string>): Promise<SkillContainer[]> {
  const out: SkillContainer[] = []
  const marketplaces = path.join(pluginsRoot, 'marketplaces')
  for (const mkt of await subdirs(marketplaces)) {
    for (const group of ['plugins', 'external_plugins']) {
      const groupDir = path.join(marketplaces, mkt, group)
      for (const plugin of await subdirs(groupDir)) {
        if (!enabledIds.has(`${plugin}@${mkt}`)) continue
        out.push(fsContainer(path.join(groupDir, plugin, 'skills'), 'plugin', plugin))
      }
    }
  }
  return out
}

/** The plugin names Codex has enabled, read from the `[plugins]` table of its
 *  `config.toml`. Each key is `<plugin>@<marketplace>`; installing writes the
 *  entry and `enabled = false` disables it while leaving it installed. We key
 *  on the base name (before `@`) because the clone under `.tmp/plugins/plugins`
 *  is a single bundled marketplace, so the dir name alone identifies the
 *  plugin. */
async function codexEnabledPluginNames(configPath: string): Promise<Set<string>> {
  let parsed: unknown
  try {
    parsed = parseToml(await fs.readFile(configPath, 'utf8'))
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

/** Enabled plugin containers under Codex's marketplace clone at
 *  `.tmp/plugins/plugins/<plugin>/skills/` — a dir survives only when its
 *  plugin is in `enabledNames`. */
async function codexPluginContainers(pluginsDir: string, enabledNames: Set<string>): Promise<SkillContainer[]> {
  const out: SkillContainer[] = []
  for (const plugin of await subdirs(pluginsDir)) {
    if (!enabledNames.has(plugin)) continue
    out.push(fsContainer(path.join(pluginsDir, plugin, 'skills'), 'plugin', plugin))
  }
  return out
}

async function claudeContainers(slug: string, ref: string | null): Promise<SkillContainer[]> {
  const claude = claudeDir(slug)
  return [
    fsContainer(path.join(claude, 'skills'), 'personal'),
    ...(await claudePluginContainers(path.join(claude, 'plugins'), await claudeEnabledPluginIds(slug, ref))),
    repoContainer(repoDir(slug), ref, '.claude/skills', 'project'),
  ]
}

async function codexContainers(slug: string, ref: string | null): Promise<SkillContainer[]> {
  const codex = codexDir(slug)
  // `skills/` is read directly, so the dot-hidden `.system/` bundled tier is
  // skipped for free (readContainer ignores dot-dirs). config.toml is the host
  // install registry, not a repo check, so its read stays on-disk.
  return [
    fsContainer(path.join(codex, 'skills'), 'personal'),
    ...(await codexPluginContainers(
      path.join(codex, '.tmp', 'plugins', 'plugins'),
      await codexEnabledPluginNames(path.join(codex, 'config.toml')),
    )),
    repoContainer(repoDir(slug), ref, '.agents/skills', 'project'),
  ]
}

function opencodeContainers(slug: string, ref: string | null): SkillContainer[] {
  const cfg = opencodeConfigDir(slug)
  const repo = repoDir(slug)
  // opencode has no plugin-skills tier (its plugins are JS modules). Its own
  // dirs accept both singular `skill/` and plural `skills/`; it also reads the
  // Claude- and agents-compatible locations. Ordered by precedence so the
  // dedupe below keeps the winning copy of a same-named skill.
  return [
    fsContainer(path.join(cfg, 'skill'), 'personal'),
    fsContainer(path.join(cfg, 'skills'), 'personal'),
    fsContainer(path.join(claudeDir(slug), 'skills'), 'personal'),
    repoContainer(repo, ref, '.opencode/skill', 'project'),
    repoContainer(repo, ref, '.opencode/skills', 'project'),
    repoContainer(repo, ref, '.claude/skills', 'project'),
    repoContainer(repo, ref, '.agents/skills', 'project'),
  ]
}

function piContainers(slug: string, ref: string | null): SkillContainer[] {
  const repo = repoDir(slug)
  // pi's whole `~/.pi` home is mounted per-project (piDir), so its global
  // `~/.pi/agent/skills` personal tier is host-visible. `~/.agents/skills` is
  // not mounted, so it isn't reachable. Project skills come from the repo.
  // `skills` plural only; no plugin tier.
  return [
    fsContainer(path.join(piDir(slug), 'agent', 'skills'), 'personal'),
    repoContainer(repo, ref, '.pi/skills', 'project'),
    repoContainer(repo, ref, '.agents/skills', 'project'),
  ]
}

async function containersFor(tool: AgentTool, slug: string, ref: string | null): Promise<SkillContainer[]> {
  switch (tool) {
    case 'claude': return claudeContainers(slug, ref)
    case 'codex': return codexContainers(slug, ref)
    case 'opencode': return opencodeContainers(slug, ref)
    case 'pi': return piContainers(slug, ref)
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
  for (const name of await c.list()) {
    if (name.startsWith('.')) continue // hidden tiers (.system) and VCS dirs (.git)
    const raw = await c.read(name)
    if (raw == null) continue // a subdir without a SKILL.md is not a skill
    const summary = toSummary(raw, {
      id: skillId(c.source, c.sourceLabel, name),
      dirName: name,
      source: c.source,
      sourceLabel: c.sourceLabel,
    })
    out.push({ ...summary, read: () => c.read(name) })
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

async function discover(tool: AgentTool, slug: string, branch?: string): Promise<DiscoveredSkill[]> {
  const ref = await resolveRepoRef(repoDir(slug), branch)
  const containers = await containersFor(tool, slug, ref)
  const perContainer = await Promise.all(containers.map(readContainer))
  const all = dedupeById(perContainer.flat())
  markShadowed(all)
  all.sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.name.localeCompare(b.name))
  return all
}

/** All personal + plugin + project skills available to a project's agent.
 *  `branch` selects the origin branch project (repo) tiers are read from
 *  (default: the remote's default branch). */
export async function getProjectSkills(tool: AgentTool, slug: string, branch?: string): Promise<ProjectSkills> {
  const discovered = await discover(tool, slug, branch)
  const skills: SkillSummary[] = discovered.map(({ read: _read, ...summary }) => summary)
  return { skills }
}

/** The full `SKILL.md` for one skill, resolved by re-reading the containers and
 *  matching the id — the client never supplies a filesystem path, so there is
 *  no traversal. `branch` must match the one the summary was listed under so the
 *  id resolves against the same tree. */
export async function getSkillDetail(tool: AgentTool, slug: string, id: string, branch?: string): Promise<SkillDetail> {
  const match = (await discover(tool, slug, branch)).find((s) => s.id === id)
  if (!match) throw new ServerError('NOT_FOUND', `skill "${id}" not found`)
  const raw = (await match.read()) ?? ''
  const { frontmatter, body } = parseSkillMd(raw)
  return {
    id: match.id,
    name: match.name,
    source: match.source,
    frontmatter: flattenFrontmatter(frontmatter),
    body,
  }
}
