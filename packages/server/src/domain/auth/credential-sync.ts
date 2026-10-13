import { listProjectRows } from '#db'
import { workspaceDriver, workspacesSandboxed } from '#drivers/driver'
import { serverLog } from '#lib/log'
import { adoptNewest, OAUTH_TOOLS, type OAuthTool } from './oauth-tools'
import { ownedProjectIds } from './store'
import type { AgentTool } from '@yaac/shared/types'

/**
 * Keeps OAuth credentials consistent between each user's store (`#db`
 * tool_credentials, the "host store" below) and the tool homes of that
 * user's projects (`<globalRoot>/projects/<id>/{claude,codex}`), which agents
 * read. A project's tool home only ever holds its owner's credential.
 *
 * With mediated egress (k8s) the project home holds a sentinel and the proxy
 * writes every refresh to the host store, so they never disagree. Without a
 * proxy (containerless) the agent refreshes the real credential in place and
 * the host store goes stale. Refresh tokens rotate, so spending a superseded
 * one fails (and for Codex's single-use tokens can break the chain).
 *
 * Rule: the newest credential wins and both sides converge on it. Harvest
 * copies a newer project bundle up to the host store; push copies the host's
 * down to projects that are behind. Seeding does both, so running it on every
 * create can only move a project forward.
 *
 * Placeholders are never adopted and never count as up to date.
 *
 * With mediated egress nothing is harvested: the proxy is the only refresh
 * writer (docs/workspace-egress.md), and a sandboxed pod could otherwise plant
 * a bundle that switches the account for every project of its owner.
 */

/**
 * Whether the host may refresh a rotating credential itself. False only
 * without a proxy while a workspace is live, since a host refresh would
 * invalidate the agent's copy; the agent refreshes and harvest picks it up.
 * An error counts as "maybe live" (a delayed readout beats logging an agent
 * out).
 *
 * Known gap: a create that launches an agent while an allowed refresh is in
 * flight may hand it the token being spent. This needs an expired host token
 * and tight timing, and self-heals (claude re-reads its store on a 401; the
 * next sweep pushes). Closing it would mean counting in-flight creates as
 * live, which `#domain/workspaces` knows but this module can't import
 * without a cycle.
 */
export async function hostMayRefreshCredentials(): Promise<boolean> {
  if (workspacesSandboxed()) return true
  try {
    const handles = await workspaceDriver().snapshot().workspaces()
    return !handles.some((h) => h.running && !h.terminating)
  } catch (err) {
    serverLog(`[server] credential-sync: liveness check failed, holding off refresh: ${String(err)}`)
    return false
  }
}

// ── Harvest: project tool homes → host store ───────────────────────────

/** Adopt the newest of one tool's bundles among `projectIds` into the host
 *  store. Unreadable projects are skipped. */
async function harvest<B extends { accessToken: string }>(
  t: OAuthTool<B>, owner: string, projectIds: string[],
): Promise<void> {
  const read = async (): Promise<Array<B | null>> => {
    const bundles = []
    for (const id of projectIds) bundles.push(await t.readProject(id).catch(() => null))
    return bundles
  }
  if (await adoptNewest(t, owner, read)) {
    serverLog(`[server] credential-sync: adopted a refreshed ${t.tool} bundle from a workspace`)
  }
}

/**
 * Copy any credential a workspace refreshed up into its owner's store.
 * Cheap (a few file reads per project), so it is called wherever staleness
 * matters (before a host refresh, before seeding a create, on attach, on
 * stop, on resync) instead of using a watcher.
 *
 * `tool` limits the sweep to one tool (plan usage runs per tool, and on macOS
 * each Claude read spawns `security`); `projectId` limits it to one of the
 * owner's project dirs. Unreadable projects are skipped.
 */
export async function harvestToolCredentials(
  owner: string,
  opts: { tool?: 'claude' | 'codex'; projectId?: string } = {},
): Promise<void> {
  if (workspacesSandboxed()) return
  const projectIds = opts.projectId !== undefined ? [opts.projectId] : await ownedProjectIds(owner)
  if (projectIds.length === 0) return
  for (const t of OAUTH_TOOLS) {
    if (opts.tool === undefined || opts.tool === t.tool) await harvest(t, owner, projectIds)
  }
}

// ── Push: host store → project tool homes ──────────────────────────────

/**
 * Write the host's bundle into a project that is behind it. When one
 * project's agent rotates the shared refresh token, the others hold a
 * superseded one; harvest updates the host store and this copies it back
 * out.
 */
async function push<B extends { accessToken: string }>(
  t: OAuthTool<B>, owner: string, projectId: string,
): Promise<void> {
  const host = await t.stored(owner)
  if (!host) return
  const current = await t.readProject(projectId).catch(() => null)
  // Same token: nothing to do. This also covers yaac-in-yaac, where both
  // hold the same sentinel.
  if (current && current.accessToken === host.accessToken) return
  // A real project credential is replaced only by a strictly newer real
  // one, never by a sentinel (which a chained install's host store holds).
  // A project with a sentinel or nothing takes whatever the host has.
  if (current && !t.isPlaceholder(current) && (t.isPlaceholder(host) || !t.isNewer(host, current))) return
  await t.writeProject(projectId, host)
}

// ── The composed operations ────────────────────────────────────────────

/**
 * Prepare a project's tool homes for a workspace launch from its owner's
 * store; called on every create. Sandboxed, it just writes sentinels.
 * Otherwise it harvests first (so a running workspace's refresh reaches the
 * store), then pushes, so it never overwrites a newer credential.
 */
export async function seedProjectToolHome(projectId: string, owner: string): Promise<void> {
  if (workspacesSandboxed()) {
    for (const t of OAUTH_TOOLS) await writePlaceholder(t, owner, projectId)
    return
  }
  await harvestToolCredentials(owner, { projectId })
  for (const t of OAUTH_TOOLS) await push(t, owner, projectId)
}

async function writePlaceholder<B extends { accessToken: string }>(
  t: OAuthTool<B>, owner: string, projectId: string,
): Promise<void> {
  const host = await t.stored(owner)
  if (host) await t.writeProjectPlaceholder(projectId, host)
}

/**
 * Converge every project both ways: adopt the newest credential among each
 * owner's projects, then update that owner's projects that are behind. Run
 * by a timed reconcile step, whose first run is at attach. A no-op when
 * sandboxed, where project homes hold sentinels kept current by
 * `fanOutToolCredentials`.
 */
export async function syncToolCredentials(): Promise<void> {
  if (workspacesSandboxed()) return
  const byOwner = new Map<string, string[]>()
  for (const { id, owner } of await listProjectRows()) byOwner.set(owner, [...byOwner.get(owner) ?? [], id])
  for (const [owner, projectIds] of byOwner) {
    for (const t of OAUTH_TOOLS) await harvest(t, owner, projectIds)
    for (const projectId of projectIds) {
      try {
        for (const t of OAUTH_TOOLS) await push(t, owner, projectId)
      } catch (err) {
        serverLog(`[server] credential-sync: push to project "${projectId}" failed: ${String(err)}`)
      }
    }
  }
}

/**
 * Write a user's new login into each of their projects: a sentinel when
 * sandboxed, the real bundle otherwise. Unconditional, since a login may
 * switch accounts and must not lose a newest-wins comparison. Per-project
 * failures are logged and skipped; the next sweep or create repairs them.
 */
export async function fanOutToolCredentials(owner: string, tool: AgentTool): Promise<void> {
  // opencode and pi authenticate by env var and keep no project file.
  const t = OAUTH_TOOLS.find((o) => o.tool === tool)
  if (t) await fanOut(t, owner)
}

async function fanOut<B extends { accessToken: string }>(t: OAuthTool<B>, owner: string): Promise<void> {
  // api-key auth has no bundle; the key is passed as an env var.
  const host = await t.stored(owner)
  if (!host) return
  const sandboxed = workspacesSandboxed()
  for (const projectId of await ownedProjectIds(owner)) {
    try {
      if (sandboxed) await t.writeProjectPlaceholder(projectId, host)
      else await t.writeProject(projectId, host)
    } catch (err) {
      serverLog(`[server] credential-sync: ${t.tool} fan-out to project "${projectId}" failed: ${String(err)}`)
    }
  }
}
