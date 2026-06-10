import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import {
  clonePlansForSession,
  commitAndPushMirror,
  docFileNameForTopic,
  ensurePlansMirror,
  getWikiStatus,
  isValidDocPath,
} from '@/lib/plans/wiki'
import { listDocsInDir, mergePlanDocs, updateFrontmatter } from '@/lib/plans/docs'
import { buildGrillPrompt, buildResumeGrillPrompt, buildBuildPrompt } from '@/lib/plans/prompts'
import { savePlanSessionMeta } from '@/lib/plans/session-meta'
import { plansMirrorDir, sessionPlansDir } from '@/lib/project/paths'
import { listActiveSessions } from '@/lib/session/list'
import { createSession, type SessionCreateOptions } from '@/daemon/session-create'
import { notifySessionListChanged } from '@/daemon/sessions-changed'
import { DaemonError, toErrorBody } from '@/daemon/errors'
import { getGitUserConfig } from '@/lib/git'
import type { AgentTool, PlanRole, PlansResult, SessionListEntry } from '@/shared/types'

// Webapp polls the doc list; pull the wiki mirror at most this often.
const LIST_PULL_MAX_AGE_MS = 15_000

async function livePlanSessions(slug: string): Promise<SessionListEntry[]> {
  // Live sessions only sharpen the doc list (drafts, terminal embedding);
  // a podman hiccup shouldn't take the whole Plan tab down with it.
  try {
    const { sessions } = await listActiveSessions(slug)
    return sessions.filter((s) => s.planRole === 'plan' || s.planRole === 'build')
  } catch {
    return []
  }
}

async function collectDocs(slug: string): Promise<PlansResult['docs']> {
  const [mirrorDocs, planSessions] = await Promise.all([
    listDocsInDir(plansMirrorDir(slug)),
    livePlanSessions(slug),
  ])
  const perSession = await Promise.all(planSessions.map(async (s) => ({
    sessionId: s.sessionId,
    docs: await listDocsInDir(sessionPlansDir(slug, s.sessionId)),
  })))
  return mergePlanDocs(mirrorDocs, perSession)
}

/**
 * Spawn a plan-mode session: clone the wiki for it, persist the
 * role/doc marker (restart re-mounts from it), and create the container
 * with the seed prompt. Shared by the new-plan and promote streams.
 */
async function spawnPlanSession(args: {
  slug: string
  sessionId: string
  role: PlanRole
  doc: string
  seedPrompt: string
  tool?: AgentTool
  onProgress: (message: string) => void
}): Promise<unknown> {
  const hostDir = await clonePlansForSession(args.slug, args.sessionId)
  await savePlanSessionMeta(args.slug, args.sessionId, { role: args.role, doc: args.doc })
  const opts: SessionCreateOptions = {
    sessionId: args.sessionId,
    plans: { role: args.role, doc: args.doc, seedPrompt: args.seedPrompt, hostDir },
    onProgress: args.onProgress,
  }
  if (args.tool) opts.tool = args.tool
  const result = await createSession(args.slug, opts)
  if (!result) throw new DaemonError('INTERNAL', 'session creation returned no result')
  notifySessionListChanged()
  return { ...result, doc: args.doc }
}

export const plansApp = new Hono()
  .get('/', async (c) => {
    const slug = c.req.param('slug')!
    const status = await getWikiStatus(slug)
    if (!status.available) {
      const body: PlansResult = { available: false, reason: status.reason, docs: [] }
      return c.json(body)
    }
    try {
      await ensurePlansMirror(slug, LIST_PULL_MAX_AGE_MS)
    } catch (err) {
      const body: PlansResult = {
        available: false,
        reason: `wiki clone failed: ${err instanceof Error ? err.message : String(err)}`,
        docs: [],
      }
      return c.json(body)
    }
    const body: PlansResult = {
      available: true,
      wikiUrl: status.wikiUrl,
      docs: await collectDocs(slug),
    }
    return c.json(body)
  })
  .get(
    '/doc',
    zValidator('query', z.object({ path: z.string().min(1) })),
    async (c) => {
      const slug = c.req.param('slug')!
      const docPath = c.req.valid('query').path
      if (!isValidDocPath(docPath)) {
        throw new DaemonError('VALIDATION', `invalid doc path "${docPath}"`)
      }
      // Start from the mirror copy, then let a live session copy win only
      // when it actually differs (every clone contains the whole wiki, so
      // an identical copy is not a draft) and is fresher than the best so
      // far.
      let best: { content: string; mtime: number; draftSessionId?: string } | null = null
      try {
        const p = path.join(plansMirrorDir(slug), docPath)
        const [content, stat] = await Promise.all([fs.readFile(p, 'utf8'), fs.stat(p)])
        best = { content, mtime: stat.mtimeMs }
      } catch { /* not pushed yet — drafts below may still have it */ }
      const mirrorContent = best?.content
      for (const s of await livePlanSessions(slug)) {
        const p = path.join(sessionPlansDir(slug, s.sessionId), docPath)
        try {
          const [content, stat] = await Promise.all([fs.readFile(p, 'utf8'), fs.stat(p)])
          if (content === mirrorContent) continue
          if (!best || stat.mtimeMs > best.mtime || best.content === mirrorContent) {
            best = { content, mtime: stat.mtimeMs, draftSessionId: s.sessionId }
          }
        } catch { /* not in this session's clone */ }
      }
      if (!best) throw new DaemonError('NOT_FOUND', `no plan doc "${docPath}"`)
      return c.json({ content: best.content, draftSessionId: best.draftSessionId ?? null })
    },
  )
  .post(
    '/new',
    zValidator('json', z.object({
      topic: z.string().min(1).max(500),
      tool: z.enum(['claude', 'codex', 'opencode']).optional(),
    })),
    (c) => {
      const slug = c.req.param('slug')!
      const body = c.req.valid('json')
      c.header('Content-Type', 'application/x-ndjson')
      return stream(c, async (s) => {
        const write = (event: unknown) => s.writeln(JSON.stringify(event))
        try {
          const status = await getWikiStatus(slug)
          if (!status.available) {
            throw new DaemonError('VALIDATION', status.reason ?? 'wiki unavailable')
          }
          const sessionId = crypto.randomUUID()
          const doc = docFileNameForTopic(body.topic)
          // Topic slugs collide easily ("test" → test.md). Spawning a second
          // grill session against an existing page would clobber it — point
          // at the resume flow instead.
          await ensurePlansMirror(slug, LIST_PULL_MAX_AGE_MS)
          if ((await collectDocs(slug)).some((d) => d.path === doc)) {
            throw new DaemonError(
              'VALIDATION',
              `a plan named "${doc}" already exists — open it and use Start plan session`,
            )
          }
          const result = await spawnPlanSession({
            slug,
            sessionId,
            role: 'plan',
            doc,
            seedPrompt: buildGrillPrompt(body.topic, doc, sessionId),
            tool: body.tool,
            onProgress: (message) => { void write({ type: 'progress', message }) },
          })
          await write({ type: 'result', result })
        } catch (err) {
          const { body: errBody } = toErrorBody(err)
          await write({ type: 'error', error: errBody.error })
        }
      })
    },
  )
  .post(
    '/continue',
    zValidator('json', z.object({
      path: z.string().min(1),
      tool: z.enum(['claude', 'codex', 'opencode']).optional(),
    })),
    (c) => {
      // Resume planning on an existing doc that has no live session: spawn
      // a plan-role session seeded to read the doc and pick the interview
      // back up (it links itself into the frontmatter).
      const slug = c.req.param('slug')!
      const body = c.req.valid('json')
      c.header('Content-Type', 'application/x-ndjson')
      return stream(c, async (s) => {
        const write = (event: unknown) => s.writeln(JSON.stringify(event))
        try {
          if (!isValidDocPath(body.path)) {
            throw new DaemonError('VALIDATION', `invalid doc path "${body.path}"`)
          }
          void write({ type: 'progress', message: 'Syncing wiki…' })
          const mirror = await ensurePlansMirror(slug)
          try {
            await fs.access(path.join(mirror, body.path))
          } catch {
            throw new DaemonError(
              'VALIDATION',
              `"${body.path}" is not on the wiki yet — have its plan session commit and push it first`,
            )
          }
          const sessionId = crypto.randomUUID()
          const result = await spawnPlanSession({
            slug,
            sessionId,
            role: 'plan',
            doc: body.path,
            seedPrompt: buildResumeGrillPrompt(body.path, sessionId),
            tool: body.tool,
            onProgress: (message) => { void write({ type: 'progress', message }) },
          })
          await write({ type: 'result', result })
        } catch (err) {
          const { body: errBody } = toErrorBody(err)
          await write({ type: 'error', error: errBody.error })
        }
      })
    },
  )
  .post(
    '/promote',
    zValidator('json', z.object({
      path: z.string().min(1),
      tool: z.enum(['claude', 'codex', 'opencode']).optional(),
    })),
    (c) => {
      const slug = c.req.param('slug')!
      const body = c.req.valid('json')
      c.header('Content-Type', 'application/x-ndjson')
      return stream(c, async (s) => {
        const write = (event: unknown) => s.writeln(JSON.stringify(event))
        try {
          if (!isValidDocPath(body.path)) {
            throw new DaemonError('VALIDATION', `invalid doc path "${body.path}"`)
          }
          void write({ type: 'progress', message: 'Syncing wiki…' })
          const mirror = await ensurePlansMirror(slug)
          const docFile = path.join(mirror, body.path)
          let md: string
          try {
            md = await fs.readFile(docFile, 'utf8')
          } catch {
            // Promote operates on the wiki's copy: an unpushed draft only
            // exists in its plan session's clone, and pushing is that
            // agent's job — tell the user to ask for a push first.
            throw new DaemonError(
              'VALIDATION',
              `"${body.path}" is not on the wiki yet — have the plan session commit and push it first`,
            )
          }
          const sessionId = crypto.randomUUID()
          void write({ type: 'progress', message: 'Recording promote on the wiki…' })
          const flipped = updateFrontmatter(md, { phase: 'build', appendSession: sessionId })
          await fs.writeFile(docFile, flipped)
          const author = await getGitUserConfig() ?? { name: 'yaac', email: 'yaac@localhost' }
          await commitAndPushMirror(
            slug, body.path, `Promote ${body.path} to build`, author,
          )
          const result = await spawnPlanSession({
            slug,
            sessionId,
            role: 'build',
            doc: body.path,
            seedPrompt: buildBuildPrompt(body.path),
            tool: body.tool,
            onProgress: (message) => { void write({ type: 'progress', message }) },
          })
          await write({ type: 'result', result })
        } catch (err) {
          const { body: errBody } = toErrorBody(err)
          await write({ type: 'error', error: errBody.error })
        }
      })
    },
  )
