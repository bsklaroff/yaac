import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { jsonBodyLimit, optionalProjectRef, projectRef, zv } from '#routes/validator'
import { z } from 'zod'
import { allowWorkspaceHost, claimDraft, keepScratchDirsInCheckout, discardDraftWorkspace, discardQueuedWorkspace, dismissProvisioning, dismissWorkspacePort, forwardWorkspacePort, getAcpStoredImage, getConversationTranscript, getWorkspaceBlockedHosts, getWorkspaceDetail, listActiveWorkspaces, listProvisioning, listStoppedWorkspaces, listWorkspaceGroups, markWaitingSeen, moveWorkspaceToGroup, removeWorkspaceGroup, setGroupWorkspaceLimit, prepareRestart, prepareStart, queueWorkspace, resolveGroup, resolveProjectWorkspace, resolveWorkspaceContainer, resolveWorkspaceId, resolveWorkspaceRecord, runQueuedWorkspace, saveDraftWorkspace, stopWorkspace, toConversationEntry, unforwardWorkspacePort, updateQueuedWorkspace, createWorkspaceFolder, deleteWorkspace, deleteWorkspaceEntry, getWorkspaceChangeDiffs, getWorkspaceChanges, getWorkspaceComparison, getWorkspaceGitLog, listWorkspaceDir, readWorkspaceFile, readWorkspaceFileAtRev, readWorkspaceMedia, renameWorkspaceEntry, saveWorkspaceAttachment, uploadWorkspaceFile, writeWorkspaceFile, runMamaCommand, mamaCaller, openSession, assertInteractive, addSteps, rerunStep, cancelStep, prepareRerun, listWorkspaceLogs, readWorkspaceLog, changeSessionAgentOptions, closeSession, resumeSession, renameSession, type QueueStart, listQueuedWorkspaces, setWorkspaceBase, setWorkspaceTimeout } from '#domain/workspaces'
import { createShellWindow, killWindowTerminal } from '#runtime/terminals'
import {
  createWorkspaceGroup,
  findWorkspaceByMamaToken,
  findWorkspaceRow,
  getQueuedWorkspaceRow,
  getRoutineRow,
  getSessionRow,
  listDraftWorkspaceRows,
  listWorkspaceConversations,
  recordAllDeathsSeen,
  recordDeathSeen,
  renameWorkspaceGroup,
  setWorkspaceGroupPinned,
  setWorkspaceTitle,
  type WorkspaceRow,
} from '#db'
import { streamProvisioned } from '#routes/provisioned-stream'
import { withPreviews } from '#api/prompt-previews'
import { requireDriverFeature } from '#api/http/driver-features'
import type { IdentityEnv } from '#api/http/web-auth'
import { authorizeProject } from '#domain/access'
import { workspaceDriver } from '#drivers/driver'
import { MAX_ICON_BYTES } from '#domain/projects'
import { serveHostedRepo } from '#domain/repos'
import { ServerError } from '@yaac/shared/errors'
import { MAX_TEXT_FILE_BYTES } from '#lib/text-file'
import { MAX_ATTACHMENT_BYTES } from '@yaac/shared/attachments'
// Group names are stored through `normalizeTitle`, which truncates at
// MAX_TITLE_LENGTH, so routes accept no longer. Otherwise two long names
// sharing a prefix would resolve to one group.
import { MAX_TITLE_LENGTH, normalizeTitle } from '@yaac/shared/titles'
import {
  draftWorkspaceSettingsSchema,
  MAX_LOG_COMMITS,
  MAX_PROMPT_BYTES,
  agentOptionsSchema,
  queuedWorkspaceSettingsSchema,
  timeoutMinutesSchema,
} from '@yaac/shared/types'

const queuedSettings = queuedWorkspaceSettingsSchema.shape

/** Refuse a request that would change a running non-interactive workspace,
 *  which only a stop may touch (docs/workspace-steps.md). */
const interactiveOnly: MiddlewareHandler<IdentityEnv> = async (c, next) => {
  await assertInteractive(await resolveWorkspaceId(c.req.param('id') ?? ''))
  await next()
}

// The group a queued workspace launches into, by id or name (an unknown name
// creates the group); null means ungrouped. If omitted, a queue takes its
// parent's group and an update keeps the entry's. An entry with no parent
// names an existing group with a workspace limit, which it waits for room in.
const queuedGroup = z.string().min(1).max(MAX_TITLE_LENGTH).nullable().optional()

// When a queued workspace starts instead of after a parent
// (docs/routines.md): `startAt` is read in the owner's zone, and `startIn`
// counts minutes from the server's clock, so the client's does not matter.
const queueStart = {
  startAt: z.string().min(1).max(64).optional(),
  startIn: timeoutMinutesSchema.optional(),
}

/** The start a queue request names, if any. Naming both is refused. */
function startOf(body: { startAt?: string; startIn?: number }): QueueStart | undefined {
  if (body.startAt !== undefined && body.startIn !== undefined) {
    throw new ServerError('VALIDATION', 'give startAt or startIn, not both')
  }
  return body.startAt !== undefined ? { at: body.startAt }
    : body.startIn !== undefined ? { inMinutes: body.startIn }
    : undefined
}

// The draft a create or queue is made from (docs/draft-workspaces.md). It is
// claimed for the request, hidden while it runs, and deleted only after
// success, so a failure keeps the draft.
const draftId = z.string().min(1).optional()

/** `minutes` from now, as a deadline. */
function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000)
}

/**
 * A session's prompt as the snapshot shows it (`toSessionEntry`), whole: the
 * message it was opened with, else its conversation's first, for a session
 * opened on one.
 */
async function sessionPrompt(sessionId: string): Promise<string | undefined> {
  const s = await getSessionRow(sessionId)
  if (s?.conversationId === undefined || s.firstPrompt !== undefined) return s?.firstPrompt
  return (await listWorkspaceConversations(s.projectId, s.workspaceId))
    .find((l) => l.tool === s.tool && l.conversationId === s.conversationId)?.firstPrompt
}

/**
 * A session id given under a workspace's path, checked to be that
 * workspace's, so a request never acts on a session it did not name the
 * workspace of.
 */
async function sessionOf(workspaceIdOrPrefix: string, sessionId: string): Promise<string> {
  const workspaceId = await resolveWorkspaceId(workspaceIdOrPrefix)
  const session = await getSessionRow(sessionId)
  if (session?.workspaceId !== workspaceId) {
    throw new ServerError('NOT_FOUND', `workspace ${workspaceIdOrPrefix} has no session ${sessionId}`)
  }
  return session.id
}

/** A full git object id, SHA-1 or SHA-256. */
const GIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** Finds the row of the calling workspace a `yaac-mama` or hosted-git
 *  request is answered for. */
type IdentifyCaller = (bearer: string, header: (name: string) => string | undefined)
  => Promise<WorkspaceRow | undefined>

/**
 * The largest yaac-mama request, checked before it is parsed: the larger of
 * a prompt of `MAX_PROMPT_BYTES` (at most that many UTF-16 units, each at
 * most 6 bytes of JSON as a `\uXXXX` escape) and `icon set`'s image of
 * `MAX_ICON_BYTES` as base64, plus room for the command and its args. What
 * the body may hold is each command's to check (`runMamaCommand`).
 */
export const MAMA_BODY_LIMIT = Math.max(MAX_PROMPT_BYTES * 6, Math.ceil(MAX_ICON_BYTES / 3) * 4) + 64 * 1024

/**
 * The endpoints a workspace calls: `yaac-mama`, and the remote of a project
 * the server hosts (docs/hosted-projects.md). Both ways in share these;
 * they differ only in how the caller is identified.
 *
 * `yaac-mama` ends in `runMamaCommand`, which holds the command allowlist.
 * Answers are JSON, except a file (`fetch`'s git bundle, `history`'s
 * transcripts, database or one file, a step's log from `logs`, the
 * project's icon from `icon-get`), sent as the body with the workspace it
 * is about, when there is one, in `x-yaac-workspace-id` (and a
 * conversation in `x-yaac-conversation-id`).
 */
function mamaRoute(identifyCaller: IdentifyCaller) {
  const callerOf = async (c: Context): Promise<WorkspaceRow> => {
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    const caller = await identifyCaller(bearer, (name) => c.req.header(name))
    if (!caller) throw new ServerError('UNAUTHENTICATED', 'unknown or revoked yaac-mama credential')
    // A site's release runs code that faces the internet, so it may not act
    // on yaac at all (docs/public-sites.md); the proxy refuses it too.
    if (caller.siteId !== undefined) throw new ServerError('FORBIDDEN', 'a public site\'s release may not call yaac')
    return caller
  }
  const hostedGit = (pathInfo: string) => async (c: Context): Promise<Response> => {
    const caller = await callerOf(c)
    const repoId = (c.req.param('repo') ?? '').replace(/\.git$/, '')
    return serveHostedRepo(repoId, c.req.raw, pathInfo, { kind: 'workspace', projectId: caller.projectId })
  }
  return new Hono().post(
    '/mama',
    jsonBodyLimit(MAMA_BODY_LIMIT, 'the yaac-mama request is too large'),
    zv('json', z.object({
      command: z.string().min(1).max(32),
      args: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      /** The calling agent's session (`YAAC_SESSION_ID`), when it has one. */
      session: z.string().max(64).optional(),
    })),
    async (c) => {
      const caller = await callerOf(c)
      const { command, args, body, session } = c.req.valid('json')
      const outcome = await runMamaCommand(
        await mamaCaller(caller, session),
        { command, args: args ?? {}, body: body ?? '' },
      )
      if (!outcome.ok) return c.json({ error: outcome.error }, 422)
      if ('output' in outcome) return c.json({ output: outcome.output })
      return c.body(outcome.body, 200, {
        'content-type': outcome.contentType,
        ...(outcome.workspaceId !== undefined ? { 'x-yaac-workspace-id': outcome.workspaceId } : {}),
        ...(outcome.conversationId !== undefined ? { 'x-yaac-conversation-id': outcome.conversationId } : {}),
      })
    },
  )
    .get('/git/:repo/info/refs', hostedGit('/info/refs'))
    .post('/git/:repo/git-upload-pack', hostedGit('/git-upload-pack'))
    .post('/git/:repo/git-receive-pack', hostedGit('/git-receive-pack'))
}

/**
 * Containerless workspaces call the API directly, identified by the bearer
 * token minted at create (their gitconfig sends it to a hosted remote), so
 * a request cannot claim to be another workspace.
 * This sits on top of the normal identity gate, which sees a loopback caller.
 * k8s workspaces get no token, which would put a server credential inside
 * the sandbox; their calls arrive through `mamaRelayApp`.
 */
const mamaApp = mamaRoute(async (bearer) => {
  if (workspaceDriver().kind !== 'containerless') {
    throw new ServerError(
      'NOT_SUPPORTED',
      'This server runs workspaces in containers, whose yaac-mama calls the egress '
      + 'proxy relays to a listener of their own.',
    )
  }
  return findWorkspaceByMamaToken(bearer)
})

/**
 * The endpoint as the egress proxy relays it for a k8s workspace pod, on the
 * driver's own listener (`WorkspaceDriver.mamaRelay`). The proxy names the
 * caller it resolved from the pod's source IP in `x-yaac-workspace-id` and
 * proves it is the proxy with `authenticate`.
 */
export function mamaRelayApp(authenticate: (bearer: string) => Promise<boolean>) {
  return mamaRoute(async (bearer, header) =>
    await authenticate(bearer) ? findWorkspaceRow(header('x-yaac-workspace-id') ?? '') : undefined)
}

export const workspaceApp = new Hono<IdentityEnv>()
  .get(
    '/list',
    zv('query', z.object({ project: optionalProjectRef })),
    async (c) => {
      const { project } = c.req.valid('query')
      return c.json(await listActiveWorkspaces(project))
    },
  )
  .get(
    '/list-stopped',
    zv('query', z.object({
      project: optionalProjectRef,
      owner: z.uuid().optional(),
      limit: z.coerce.number().int().positive().optional(),
      cursor: z.string().optional(),
      q: z.string().optional(),
      group: z.string().optional(),
      // Comma-separated ids.
      excludeGroups: z.string().optional().transform((v) => v ? v.split(',') : undefined),
      exclude: z.string().optional().transform((v) => v ? v.split(',') : undefined),
      workspace: z.string().optional(),
    })),
    async (c) => {
      const page = await listStoppedWorkspaces(c.req.valid('query'))
      return c.json({ ...page, entries: page.entries.map(withPreviews) })
    },
  )
  .post(
    '/create',
    zv('json', z.object({
      project: projectRef,
      // Pre-generated by the webapp so the provisioning row is usable before
      // any round-trip; the CLI omits it and the server mints one.
      workspaceId: z.string().uuid().optional(),
      // Its session's id, pre-generated by the webapp for the same reason.
      sessionId: z.uuid().optional(),
      // The queue's settings, with the prompt optional and typed into the
      // agent pane once it's up. `acp` with a tool that has no adapter, or a
      // permission mode the tool lacks, is a 400 rather than a downgrade. A
      // permission mode given here becomes the project's next default.
      ...queuedSettings,
      prompt: queuedSettings.prompt.optional(),
      // Sidebar group by id or name; an unknown name creates the group.
      group: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
      draftId,
      // Keep the prompt as a draft if the create fails, not only if it is
      // stopped. The webapp sets it, since its sidebar is where the draft is
      // retried from; a CLI retry could only add another draft.
      draftOnFailure: z.boolean().optional(),
      // Start it with no session; the agent settings and prompt are refused
      // beside it.
      noSession: z.boolean().optional(),
      // A volume of the project to mount, by name (docs/workspace-volumes.md).
      volume: z.string().min(1).optional(),
    })),
    async (c) => {
      const body = c.req.valid('json')
      // A non-interactive workspace opens no session (docs/workspace-steps.md).
      const noSession = body.noSession === true || body.nonInteractive === true
      if (noSession && (['tool', 'model', 'permissionMode', 'effort', 'agentOptions', 'mode', 'prompt'] as const)
        .some((k) => body[k] !== undefined)) {
        throw new ServerError('VALIDATION', 'a workspace with no session takes no prompt or agent settings')
      }
      const workspaceId = body.workspaceId ?? randomUUID()
      // A client-chosen id already in use is a plain 409 before the stream
      // opens. The row insert inside the create guards against races.
      if (body.workspaceId !== undefined && await findWorkspaceRow(workspaceId)) {
        throw new ServerError('CONFLICT', `workspace id ${workspaceId} is already in use`)
      }
      if (body.sessionId !== undefined && (await getSessionRow(body.sessionId) !== undefined
        || listProvisioning().some((p) => p.sessionId === body.sessionId))) {
        throw new ServerError('CONFLICT', `session id ${body.sessionId} is already in use`)
      }
      // Claimed first, so a second run of one draft is refused outright.
      const draft = await claimDraft(c.get('principal'), body.project, body.draftId)
      const title = normalizeTitle(body.title ?? '')
      // Without one, keep the title its draft was shown under, until its
      // agent gives one.
      const generatedTitle = title === '' ? draft.generatedTitle(body.prompt) : undefined
      // Checked and registered before streaming, so a bad setting or an id
      // still provisioning is a plain error rather than a failed row.
      const run = await prepareStart(c.get('principal'), {
        projectId: body.project,
        workspaceId,
        ...(body.tool !== undefined ? { tool: body.tool } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
        ...(body.effort !== undefined ? { effort: body.effort } : {}),
        ...(body.agentOptions !== undefined ? { agentOptions: body.agentOptions } : {}),
        ...(body.mode !== undefined ? { mode: body.mode } : {}),
        ...(body.repos !== undefined ? { repos: body.repos } : {}),
        ...(body.nested !== undefined ? { nested: body.nested } : {}),
        ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
        ...(body.branch !== undefined ? { branch: body.branch } : {}),
        ...(body.commit !== undefined ? { commit: body.commit } : {}),
        ...(body.steps !== undefined ? { steps: body.steps } : {}),
        ...(body.workflow !== undefined ? { workflow: body.workflow } : {}),
        ...(body.nonInteractive === true ? { nonInteractive: true } : {}),
        ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
        ...(title ? { title } : {}),
        ...(generatedTitle !== undefined ? { generatedTitle } : {}),
        ...(body.group !== undefined ? { group: body.group } : {}),
        ...(body.timeout !== undefined ? { deadline: minutesFromNow(body.timeout) } : {}),
        ...(noSession ? { noSession: true } : {}),
        ...(body.volume !== undefined ? { volume: body.volume } : {}),
        // A user request, so its settings become the project's defaults.
        rememberDefaults: true,
        claimSpare: true,
        draft: {
          ...(body.draftId !== undefined ? { id: body.draftId } : {}),
          ...(body.draftOnFailure === true ? { onFailure: true } : {}),
        },
      }).catch((err: unknown) => {
        draft.release()
        throw err
      })
      return streamProvisioned(c, (onProgress) => draft.run(() => run(onProgress)))
    },
  )
  // Rerun a non-interactive workspace: a new one with its graph at its
  // start commit, or with `interactive` an interactive one to debug in.
  // `rerunId`, the new one's id, is pre-generated by the webapp as a
  // create's is, so its provisioning row is the one the run fills.
  .post(
    '/rerun',
    zv('json', z.object({
      workspaceId: z.string().min(1),
      interactive: z.boolean().optional(),
      rerunId: z.uuid().optional(),
    })),
    async (c) => {
      const { workspaceId, interactive, rerunId } = c.req.valid('json')
      if (rerunId !== undefined && await findWorkspaceRow(rerunId)) {
        throw new ServerError('CONFLICT', `workspace id ${rerunId} is already in use`)
      }
      return streamProvisioned(c, await prepareRerun(c.get('principal'), workspaceId, {
        workspaceId: rerunId ?? randomUUID(),
        ...(interactive === true ? { interactive } : {}),
      }))
    },
  )
  .post(
    '/restart',
    zv('json', z.object({
      // An id or its unique prefix.
      workspaceId: z.string().min(1),
      // No agent settings: each session restarts as it was. No `gitUser`:
      // the commit identity is a server setting.
      // Minutes from the restart until the server stops it; without one the
      // restart clears any timeout it had.
      timeout: timeoutMinutesSchema.optional(),
      // A volume to attach by name, or null to restart without the one it
      // had; absent attaches the one it last held (docs/workspace-volumes.md).
      volume: z.string().min(1).nullable().optional(),
      // If its last checkpoint is unreadable, restore the newest state that
      // is rather than refuse (docs/node-local-workspaces.md "Restore").
      restoreNewest: z.literal(true).optional(),
    })),
    // Checked and registered before streaming, so an unknown workspace, one
    // already provisioning, or a volume another holds is a plain error.
    async (c) => {
      const { workspaceId, timeout, volume, restoreNewest } = c.req.valid('json')
      return streamProvisioned(c, await prepareRestart(c.get('principal'), workspaceId, {
        ...(timeout !== undefined ? { deadline: minutesFromNow(timeout) } : {}),
        ...(volume !== undefined ? { volume } : {}),
        ...(restoreNewest === true ? { restoreNewest } : {}),
      }))
    },
  )
  // Give a running workspace a timeout counted from now, or clear it with
  // null (docs/routines.md "Timeouts"). No `yaac-mama` verb reaches it.
  .post(
    '/timeout',
    zv('json', z.object({
      workspaceId: z.string().min(1),
      timeout: timeoutMinutesSchema.nullable(),
    })),
    async (c) => {
      const { workspaceId, timeout } = c.req.valid('json')
      return c.json(await setWorkspaceTimeout(c.get('principal'), workspaceId, timeout))
    },
  )
  .post(
    '/stop',
    zv('json', z.object({ workspaceId: z.string().min(1) })),
    async (c) => {
      const { workspaceId } = c.req.valid('json')
      const info = await stopWorkspace(c.get('principal'), workspaceId)
      return c.json(info)
    },
  )
  .post(
    '/delete',
    zv('json', z.object({ workspaceId: z.string().min(1) })),
    async (c) => c.json({ workspaceId: await deleteWorkspace(c.get('principal'), c.req.valid('json').workspaceId) }),
  )
  // Record that the caller viewed an abnormal death's detail, clearing the
  // caller's "Stopped workspaces" dot and row highlight on every client.
  // Open to every user, like the waiting mark below.
  .post(
    '/mark-death-seen',
    zv('json', z.object({
      projectId: projectRef,
      workspaceId: z.string().min(1),
    })),
    async (c) => {
      const { projectId, workspaceId } = c.req.valid('json')
      await recordDeathSeen(projectId, workspaceId, c.get('principal').userId)
      return c.body(null, 204)
    },
  )
  // Record that the caller viewed a waiting session's current spell,
  // clearing the caller's unread dot on every client. Open to every user,
  // since each has their own dot. `marked` is false when the spell named is
  // no longer the session's.
  .post(
    '/mark-waiting-seen',
    zv('json', z.object({
      sessionId: z.uuid(),
      waitingSinceMs: z.number().int().nonnegative(),
    })),
    async (c) => {
      const { sessionId, waitingSinceMs } = c.req.valid('json')
      return c.json({ marked: await markWaitingSeen(c.get('principal'), sessionId, waitingSinceMs) })
    },
  )
  // The same for every death in a project ("mark all as read").
  .post(
    '/mark-all-deaths-seen',
    zv('json', z.object({ projectId: projectRef })),
    async (c) => {
      const { projectId } = c.req.valid('json')
      await recordAllDeathsSeen(projectId, c.get('principal').userId)
      return c.body(null, 204)
    },
  )
  // Queued workspaces (docs/queued-workspaces.md): create requests that run
  // when their parent (a workspace or another entry) stops naturally. Plain
  // JSON rather than a provisioning stream, since queueing is fast and a "Run
  // now" reports progress through its provisioning row. No permission ceiling
  // applies here; that only limits agents (`yaac-mama queue`).
  // Every project's queued workspaces not launching, oldest first: the
  // snapshot's feed, for the CLI.
  .get('/queue/list', async (c) => c.json(await listQueuedWorkspaces()))
  .post(
    '/queue/create',
    zv('json', z.object({
      project: projectRef,
      // A workspace id or queued entry id, or a unique prefix of either.
      // Omitted with no start, the entry waits for room in its group
      // (docs/workspace-groups.md). Not with a start.
      parent: z.string().min(1).optional(),
      ...queueStart,
      ...queuedSettings,
      // Absent only for a non-interactive entry.
      prompt: queuedSettings.prompt.optional(),
      group: queuedGroup,
      draftId,
    })),
    async (c) => {
      const { project, draftId: fromDraft, startAt, startIn, ...rest } = c.req.valid('json')
      const start = startOf({ startAt, startIn })
      const request = { ...rest, ...(start !== undefined ? { start } : {}) }
      const principal = c.get('principal')
      const draft = await claimDraft(principal, project, fromDraft)
      return c.json(await draft.run(() => queueWorkspace(principal, project, request, 'user', draft.generatedTitle(request.prompt))))
    },
  )
  .post(
    '/queue/update',
    zv('json', z.object({
      id: z.string().min(1),
      // null leaves it waiting for room in its group, as a queue with no
      // parent does. Not with a start.
      parent: z.string().min(1).nullable().optional(),
      ...queueStart,
      ...queuedSettings,
      prompt: queuedSettings.prompt.optional(),
      group: queuedGroup,
      // Null clears it.
      timeout: timeoutMinutesSchema.nullable().optional(),
    })),
    async (c) => {
      const { id, startAt, startIn, ...rest } = c.req.valid('json')
      const start = startOf({ startAt, startIn })
      const patch = { ...rest, ...(start !== undefined ? { start } : {}) }
      return c.json(await updateQueuedWorkspace(c.get('principal'), id, patch, 'user'))
    },
  )
  .post(
    '/queue/discard',
    zv('json', z.object({ id: z.string().min(1) })),
    async (c) => {
      await discardQueuedWorkspace(c.get('principal'), c.req.valid('json').id)
      return c.body(null, 204)
    },
  )
  .post(
    '/queue/run',
    zv('json', z.object({ id: z.string().min(1) })),
    async (c) => c.json(await runQueuedWorkspace(c.get('principal'), c.req.valid('json').id)),
  )
  // A queued entry's, draft's, routine's or session's whole prompt, which the
  // snapshot carries only a preview of. A session's comes from its create's
  // provisioning row until the create records the session. Open to every
  // user, as the snapshot is.
  .get(
    '/prompt',
    zv('query', z.object({ id: z.string().min(1) })),
    async (c) => {
      const { id } = c.req.valid('query')
      const prompt = (await getQueuedWorkspaceRow(id))?.prompt
        ?? (await listDraftWorkspaceRows()).find((d) => d.id === id)?.prompt
        ?? (await getRoutineRow(id))?.prompt
        ?? await sessionPrompt(id)
        ?? listProvisioning().find((p) => p.sessionId === id)?.prompt
      if (prompt === undefined) throw new ServerError('NOT_FOUND', `no queued workspace, draft, routine or session ${id}`)
      return c.json({ prompt })
    },
  )
  // Draft workspaces (docs/draft-workspaces.md): saved create-dialog contents.
  // A save without an id creates a draft; with one it replaces all fields.
  .post(
    '/draft/save',
    zv('json', draftWorkspaceSettingsSchema.extend({
      id: z.string().min(1).optional(),
      project: projectRef,
    })),
    async (c) => {
      const { id, project, ...settings } = c.req.valid('json')
      return c.json(await saveDraftWorkspace(c.get('principal'), project, settings, id))
    },
  )
  .post(
    '/draft/discard',
    zv('json', z.object({ id: z.string().min(1) })),
    async (c) => {
      await discardDraftWorkspace(c.get('principal'), c.req.valid('json').id)
      return c.body(null, 204)
    },
  )
  .route('/', mamaApp)
  // Sidebar-group routes. All take an explicit project rather than
  // resolving a container, since members may be stopped workspaces. The
  // writes go straight to `#db`, so each checks the project's owner first,
  // as the death-seen marks and titles do.
  // The list is for clients without a snapshot (`yaac group list`); the
  // webapp reads the same rows from `/events`.
  .get(
    '/group/list',
    zv('query', z.object({ project: optionalProjectRef })),
    async (c) => {
      const { project } = c.req.valid('query')
      return c.json({ groups: await listWorkspaceGroups(project) })
    },
  )
  .post(
    '/group/create',
    zv('json', z.object({
      projectId: projectRef,
      // The first member ("new group from this workspace"). If omitted, the
      // group starts empty and pinned (as with `yaac group create`).
      workspaceId: z.string().min(1).optional(),
      name: z.string().min(1).max(MAX_TITLE_LENGTH),
    })),
    async (c) => {
      const { projectId, workspaceId, name } = c.req.valid('json')
      await authorizeProject(c.get('principal'), projectId)
      const group = await createWorkspaceGroup(projectId, name, workspaceId ?? null)
      // Return the stored name, which the store normalizes (whitespace
      // collapsed, length capped).
      return c.json({ groupId: group.groupId, name: group.name })
    },
  )
  .post(
    '/group/rename',
    zv('json', z.object({
      projectId: projectRef,
      groupId: z.string().min(1),
      name: z.string().min(1).max(MAX_TITLE_LENGTH),
    })),
    async (c) => {
      const { projectId, groupId, name } = c.req.valid('json')
      await authorizeProject(c.get('principal'), projectId)
      await renameWorkspaceGroup(projectId, groupId, name)
      return c.body(null, 204)
    },
  )
  .post(
    '/group/set-pinned',
    zv('json', z.object({
      projectId: projectRef,
      groupId: z.string().min(1),
      pinned: z.boolean(),
    })),
    async (c) => {
      const { projectId, groupId, pinned } = c.req.valid('json')
      await authorizeProject(c.get('principal'), projectId)
      await setWorkspaceGroupPinned(projectId, groupId, pinned)
      return c.body(null, 204)
    },
  )
  .post(
    '/group/delete',
    zv('json', z.object({
      projectId: projectRef,
      groupId: z.string().min(1),
    })),
    async (c) => {
      const { projectId, groupId } = c.req.valid('json')
      await authorizeProject(c.get('principal'), projectId)
      await removeWorkspaceGroup(projectId, groupId)
      return c.body(null, 204)
    },
  )
  // Set or clear (null) how many live workspaces a group may hold
  // (docs/workspace-groups.md).
  .post(
    '/group/set-limit',
    zv('json', z.object({
      projectId: projectRef,
      groupId: z.string().min(1),
      workspaceLimit: z.number().int().positive().nullable(),
    })),
    async (c) => {
      const { projectId, groupId, workspaceLimit } = c.req.valid('json')
      await authorizeProject(c.get('principal'), projectId)
      await setGroupWorkspaceLimit(projectId, groupId, workspaceLimit)
      return c.body(null, 204)
    },
  )
  // File a workspace under a group given by id or name (`yaac group move`,
  // the sidebar). Only `create` makes a group a name matches none of, so a
  // sidebar drag onto a since-deleted group fails rather than recreating it.
  .post(
    '/group/move',
    zv('json', z.object({
      projectId: projectRef,
      workspaceId: z.string().min(1),
      // A group id or name; null makes the workspace ungrouped.
      group: z.string().min(1).max(MAX_TITLE_LENGTH).nullable(),
      // Create the group when no group has this name.
      create: z.boolean().optional(),
    })),
    async (c) => {
      const { projectId, workspaceId, group, create } = c.req.valid('json')
      await authorizeProject(c.get('principal'), projectId)
      // Accept an id or unique prefix (what every surface prints). The
      // membership write matches exactly, so an unresolved prefix would
      // silently file nothing.
      const resolved = await resolveProjectWorkspace(workspaceId, projectId)
      const target = group === null
        ? null
        : await resolveGroup(projectId, group, { create: create ?? false })
      await moveWorkspaceToGroup(projectId, resolved, target?.groupId ?? null)
      // Include the name, since the caller may have passed an id.
      return c.json({ groupId: target?.groupId ?? null, name: target?.name ?? null })
    },
  )
  // Drop a failed provisioning entry (successful ones clear themselves).
  .post('/provisioning/:id/dismiss', async (c) => {
    await dismissProvisioning(c.get('principal'), c.req.param('id'))
    return c.body(null, 204)
  })
  // Base one of the workspace's checkouts on another branch on its origin,
  // from the Commits pane: the one `repo` names by its path under the
  // workspace root or its repo's id, or the workspace's only one.
  .post(
    '/:id/base',
    zv('json', z.object({ branch: z.string().max(500), repo: z.string().max(255).optional() })),
    async (c) => {
      const { branch, repo } = c.req.valid('json')
      return c.json(await setWorkspaceBase(c.get('principal'), c.req.param('id'), branch, repo))
    },
  )
  .post(
    '/:id/title',
    zv('json', z.object({ title: z.string().max(500) })),
    async (c) => {
      // From the row alone, so a stopped or dead workspace can be renamed
      // too, and the runtime is never asked before the owner check.
      const row = await findWorkspaceRow(await resolveWorkspaceId(c.req.param('id')))
      if (!row) throw new ServerError('NOT_FOUND', `workspace ${c.req.param('id')} not found`)
      const { projectId, workspaceId } = row
      await authorizeProject(c.get('principal'), projectId)
      await setWorkspaceTitle(projectId, workspaceId, c.req.valid('json').title)
      return c.body(null, 204)
    },
  )
  // Keep scratch dirs git tracks in the workspace's checkout: the badge's
  // answer, before it restarts the workspace (docs/project-config.md).
  .post(
    '/:id/keep-scratch-dirs',
    zv('json', z.object({ paths: z.array(z.string()) })),
    async (c) => {
      await keepScratchDirsInCheckout(c.get('principal'), await resolveWorkspaceId(c.req.param('id')), c.req.valid('json').paths)
      return c.body(null, 204)
    },
  )
  // Open a session in a running workspace (docs/sessions.md). Unnamed
  // settings resolve as a create's, and named ones become the project's
  // next defaults. Answers once its window is launched.
  .post(
    '/:id/sessions',
    interactiveOnly,
    zv('json', z.object({
      tool: queuedSettings.tool,
      model: queuedSettings.model,
      mode: queuedSettings.mode,
      permissionMode: queuedSettings.permissionMode,
      effort: queuedSettings.effort,
      agentOptions: queuedSettings.agentOptions,
      prompt: queuedSettings.prompt.optional(),
      title: queuedSettings.title,
      // Where its agent runs: `.` for the workspace root, or one of the
      // workspace's checkouts by path or repo id. Unnamed is the
      // workspace's cwd.
      cwd: queuedSettings.cwd,
      // One of the workspace's earlier conversations to resume.
      resume: z.string().min(1).max(256).optional(),
    })),
    async (c) => {
      const body = c.req.valid('json')
      const session = await openSession(c.get('principal'), c.req.param('id'), {
        ...(body.tool !== undefined ? { tool: body.tool } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.mode !== undefined ? { mode: body.mode } : {}),
        ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
        ...(body.effort !== undefined ? { effort: body.effort } : {}),
        ...(body.agentOptions !== undefined ? { agentOptions: body.agentOptions } : {}),
        ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
        ...(body.resume !== undefined ? { resume: body.resume } : {}),
        rememberDefaults: true,
      })
      return c.json({ sessionId: session.id, workspaceId: session.workspaceId }, 201)
    },
  )
  // Close a session: its agent stops, its conversations stay as history, and
  // the workspace keeps running.
  .post('/:id/sessions/:sessionId/close', async (c) => {
    await closeSession(c.get('principal'), await sessionOf(c.req.param('id'), c.req.param('sessionId')))
    return c.body(null, 204)
  })
  // Relaunch a session whose agent exited, on its conversation.
  .post('/:id/sessions/:sessionId/resume', async (c) => {
    await resumeSession(c.get('principal'), await sessionOf(c.req.param('id'), c.req.param('sessionId')))
    return c.body(null, 204)
  })
  // Change a running session's agent options; the ones not named are kept.
  .post(
    '/:id/sessions/:sessionId/agent-options',
    zv('json', agentOptionsSchema),
    async (c) => {
      const sessionId = await sessionOf(c.req.param('id'), c.req.param('sessionId'))
      await changeSessionAgentOptions(c.get('principal'), sessionId, c.req.valid('json'))
      return c.body(null, 204)
    },
  )
  // Name a session; blank clears the name.
  .post(
    '/:id/sessions/:sessionId/title',
    zv('json', z.object({ title: z.string().max(MAX_TITLE_LENGTH) })),
    async (c) => {
      const sessionId = await sessionOf(c.req.param('id'), c.req.param('sessionId'))
      await renameSession(c.get('principal'), sessionId, c.req.valid('json').title)
      return c.body(null, 204)
    },
  )
  // A workspace's conversations, in the order it first saw them
  // (`yaac workspace conversations <id>` and the webapp's history list).
  .get('/:id/conversations', async (c) => {
    // Resolved from the record, so a stopped workspace works too.
    const { projectId, workspaceId } = await resolveWorkspaceRecord(c.req.param('id'))
    const links = await listWorkspaceConversations(projectId, workspaceId)
    return c.json(links.map((l) => toConversationEntry(l)))
  })
  // One page of a conversation's history as chat-pane events: `page`, or
  // the last. Resolved from the record so the stopped-workspaces view can
  // read it.
  .get(
    '/:id/conversations/:conversationId/transcript',
    // An empty `page` is a missing one, not page 0.
    zv('query', z.object({ page: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().nonnegative().optional()) })),
    async (c) => {
      const { projectId, workspaceId } = await resolveWorkspaceRecord(c.req.param('id'))
      return c.json(await getConversationTranscript(
        projectId, workspaceId, c.req.param('conversationId'), c.req.valid('query').page,
      ))
    },
  )
  // An image a chat transcript names by hash (`AcpStoredImage`). The bytes
  // never change for a hash, so the browser may keep them.
  .get('/:id/acp-images/:hash', async (c) => {
    const { projectId, workspaceId } = await resolveWorkspaceRecord(c.req.param('id'))
    const { bytes, mimeType } = await getAcpStoredImage(projectId, workspaceId, c.req.param('hash'))
    c.header('Content-Type', mimeType)
    c.header('Cache-Control', 'private, max-age=31536000, immutable')
    c.header('X-Content-Type-Options', 'nosniff')
    return c.body(new Uint8Array(bytes))
  })
  // Everything the webapp polls about a running workspace
  // (docs/file-editor.md): the review diff of one checkout against its base
  // branch, how far its HEAD is from that branch, and with `listing` the
  // explorer's paths for the whole workspace (`full` adds ignored entries
  // and empty folders). `repo` names the checkout by its path under the
  // workspace root or its repo's id, which a workspace with one checkout
  // needs not. `base` overrides the branch; `diff=0` leaves out the diff
  // body; `known` omits a listing the caller already holds. A client that
  // hangs up leaves the read, which stops once no request wants it.
  .get(
    '/:id/changes',
    zv('query', z.object({
      repo: z.string().max(255).optional(),
      base: z.string().min(1).max(255).optional(),
      diff: z.enum(['0', '1']).optional(),
      listing: z.enum(['paths', 'full']).optional(),
      known: z.string().max(128).optional(),
    })),
    async (c) => {
      const { repo, base, diff, listing, known } = c.req.valid('query')
      return c.json(await getWorkspaceChanges(c.req.param('id'), base, {
        repo, diff: diff !== '0', listing, known, signal: c.req.raw.signal,
      }))
    },
  )
  // More of a diff the changes poll left out, from the reading it names by
  // its `base` and `work` trees: the parts of `files`, or with `skip` the
  // rest of one file's part. A POST, since a batch of paths can outgrow a
  // URL.
  .post(
    '/:id/changes/diff',
    jsonBodyLimit(256 * 1024, 'too many paths in one request'),
    zv('json', z.object({
      base: z.string().regex(GIT_OID),
      work: z.string().regex(GIT_OID),
      files: z.array(z.object({ path: z.string().min(1).max(4096), oldPath: z.string().min(1).max(4096).optional() }))
        .min(1).max(200),
      skip: z.number().int().min(1).optional(),
      /** The checkout the reading was of, as `/changes` takes it. */
      repo: z.string().max(255).optional(),
    }).refine((r) => r.skip === undefined || r.files.length === 1, 'skip reads one file')),
    async (c) => c.json(await getWorkspaceChangeDiffs(c.req.param('id'), c.req.valid('json'))),
  )
  // The diff between two refs of one checkout (`repo`, as `/changes` takes
  // it), for a Changes pane showing a range or, with no `from`, one commit.
  .get(
    '/:id/compare',
    zv('query', z.object({
      from: z.string().min(1).max(255).optional(),
      to: z.string().min(1).max(255),
      repo: z.string().max(255).optional(),
    })),
    async (c) => c.json(await getWorkspaceComparison(c.req.param('id'), c.req.valid('query'))),
  )
  // The Commits pane's history of one checkout (`repo`, as `/changes` takes
  // it): HEAD's commits and the base branch's, newest `limit` of them.
  .get(
    '/:id/commits',
    zv('query', z.object({
      limit: z.coerce.number().int().min(1).max(MAX_LOG_COMMITS).optional(),
      repo: z.string().max(255).optional(),
    })),
    async (c) => {
      const { limit, repo } = c.req.valid('query')
      return c.json(await getWorkspaceGitLog(c.req.param('id'), limit ?? 200, repo))
    },
  )
  // The file editor (docs/file-editor.md). Served from inside a running k8s
  // workspace, and from the server's view of the checkout otherwise, so
  // stopped workspaces work too.
  .get(
    '/:id/dir',
    zv('query', z.object({ path: z.string().min(1) })),
    async (c) => c.json(await listWorkspaceDir(c.req.param('id'), c.req.valid('query').path)),
  )
  .get(
    '/:id/file',
    zv('query', z.object({ path: z.string().min(1), known: z.string().optional() })),
    async (c) => {
      const { path, known } = c.req.valid('query')
      return c.json(await readWorkspaceFile(c.req.param('id'), path, known))
    },
  )
  // An image, video, audio or PDF file's bytes for the file pane's media
  // view and the images its previews inline. One byte range is honored, so
  // a video can seek. The bytes are the workspace's, so a response rendered
  // as a page anyway (opened in a tab, or the PDF iframe) is sandboxed into
  // an opaque origin with no script, away from the API; Chromium's PDF
  // viewer still runs under it.
  .get(
    '/:id/raw',
    zv('query', z.object({ path: z.string().min(1) })),
    async (c) => {
      const media = await readWorkspaceMedia(c.req.param('id'), c.req.valid('query').path, c.req.header('range'))
      const { start, end } = media.range ?? { start: 0, end: media.size - 1 }
      c.header('Content-Type', media.type)
      c.header('Content-Length', String(end - start + 1))
      c.header('Accept-Ranges', 'bytes')
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'self'")
      c.header('Cache-Control', 'no-cache')
      if (media.range) c.header('Content-Range', `bytes ${start}-${end}/${media.size}`)
      return c.body(media.body, media.range ? 206 : 200)
    },
  )
  // A file as it was at a commit, for the editor's diff against the fork
  // base. Runs git inside the workspace, so it needs it running.
  .get(
    '/:id/file-at',
    zv('query', z.object({ path: z.string().min(1), rev: z.string().min(1) })),
    async (c) => {
      const { path, rev } = c.req.valid('query')
      return c.json(await readWorkspaceFileAtRev(c.req.param('id'), path, rev))
    },
  )
  // A null `baseVersion` creates the file. A save against a stale version is
  // refused with the file's current version (null if deleted), which the
  // editor saves against next.
  .put(
    '/:id/file',
    interactiveOnly,
    // Refuse oversized bodies before buffering. Twice the editable size
    // allows for JSON escaping; the domain enforces the exact limit.
    jsonBodyLimit(2 * MAX_TEXT_FILE_BYTES + 64 * 1024, 'the file is over the editable size'),
    zv('json', z.object({
      path: z.string().min(1),
      content: z.string(),
      baseVersion: z.string().nullable(),
    })),
    async (c) => {
      const { path, content, baseVersion } = c.req.valid('json')
      const result = await writeWorkspaceFile(c.get('principal'), c.req.param('id'), path, content, baseVersion)
      if ('conflict' in result) {
        const message = result.conflict === null
          ? `${path} no longer exists`
          : `${path} changed since it was read`
        return c.json({ error: { code: 'CONFLICT' as const, message }, version: result.conflict }, 409)
      }
      return c.json(result.saved)
    },
  )
  // A file dropped or picked in the explorer: the body is its raw bytes,
  // streamed to disk. `replace=1` overwrites a file already there.
  .put(
    '/:id/upload',
    interactiveOnly,
    zv('query', z.object({ path: z.string().min(1), replace: z.enum(['0', '1']).optional() })),
    async (c) => {
      const { path, replace } = c.req.valid('query')
      return c.json(await uploadWorkspaceFile(
        c.get('principal'), c.req.param('id'), path, c.req.raw.body, replace === '1',
      ))
    },
  )
  // An image pasted into a terminal pane: takes raw bytes, returns the path
  // to paste instead.
  .post(
    '/:id/attachments',
    interactiveOnly,
    bodyLimit({
      maxSize: MAX_ATTACHMENT_BYTES,
      onError: () => { throw new ServerError('TOO_LARGE', 'the image is over the 5 MB limit') },
    }),
    async (c) => c.json(
      await saveWorkspaceAttachment(c.get('principal'), c.req.param('id'), new Uint8Array(await c.req.arrayBuffer())),
    ),
  )
  .delete(
    '/:id/file',
    interactiveOnly,
    zv('query', z.object({ path: z.string().min(1) })),
    async (c) => {
      await deleteWorkspaceEntry(c.get('principal'), c.req.param('id'), c.req.valid('query').path)
      return c.body(null, 204)
    },
  )
  .post(
    '/:id/folder',
    interactiveOnly,
    zv('json', z.object({ path: z.string().min(1) })),
    async (c) => c.json(await createWorkspaceFolder(c.get('principal'), c.req.param('id'), c.req.valid('json').path)),
  )
  .post(
    '/:id/rename',
    interactiveOnly,
    zv('json', z.object({ from: z.string().min(1), to: z.string().min(1) })),
    async (c) => {
      const { from, to } = c.req.valid('json')
      return c.json(await renameWorkspaceEntry(c.get('principal'), c.req.param('id'), from, to))
    },
  )
  // Create a scratch-shell window in the session's `yaac` tmux session,
  // returning its entry so the client can focus the pane the snapshot
  // brings. Both terminal routes act inside the workspace, so only its owner
  // may call them.
  .post('/:id/terminals', interactiveOnly, async (c) => {
    const { jobName } = await resolveWorkspaceContainer(c.req.param('id'), { requireRunning: true, owner: c.get('principal') })
    return c.json(await createShellWindow(jobName))
  })
  .post(
    '/:id/terminals/close',
    interactiveOnly,
    zv('json', z.object({ target: z.string().min(1) })),
    async (c) => {
      const { jobName } = await resolveWorkspaceContainer(c.req.param('id'), { requireRunning: true, owner: c.get('principal') })
      const { target } = c.req.valid('json')
      try {
        await killWindowTerminal(jobName, target)
      } catch (err) {
        throw new ServerError('VALIDATION', err instanceof Error ? err.message : String(err))
      }
      return c.body(null, 204)
    },
  )
  .get('/:id', async (c) => c.json(await getWorkspaceDetail(c.req.param('id'))))
  // The egress and port-relay routes below refuse on a runtime without those
  // features, checked before the id is resolved (see `requireDriverFeature`).
  .get('/:id/blocked-hosts', async (c) => {
    requireDriverFeature('egress')
    return c.json(await getWorkspaceBlockedHosts(c.req.param('id')))
  })
  // Allow a previously blocked host (webapp click-to-allow). The proxy drops
  // it from its blocked set, which clears the badge in the next snapshot.
  .post(
    '/:id/allow-host',
    interactiveOnly,
    zv('json', z.object({
      // A bare hostname or wildcard pattern as hostMatchesPattern
      // (@yaac/shared/allowed-hosts) understands it; no scheme, path or port.
      host: z.string().regex(/^[A-Za-z0-9*._-]+$/, 'host must be a bare hostname or wildcard pattern'),
      persist: z.boolean().optional(),
    })),
    async (c) => {
      requireDriverFeature('egress')
      const { host, persist } = c.req.valid('json')
      await allowWorkspaceHost(c.get('principal'), c.req.param('id'), host, { persist: persist ?? false })
      return c.body(null, 204)
    },
  )
  // Forward a detected, unforwarded port (webapp click-to-forward). The
  // runtime rejects any port not in that detected set, so this can't open an
  // arbitrary port.
  .post(
    '/:id/forward-port',
    interactiveOnly,
    zv('json', z.object({
      containerPort: z.number().int().min(1).max(65535),
      persist: z.boolean().optional(),
    })),
    async (c) => {
      requireDriverFeature('portRelay')
      const { containerPort, persist } = c.req.valid('json')
      const mapping = await forwardWorkspacePort(
        c.get('principal'), c.req.param('id'), containerPort, { persist: persist ?? false },
      )
      return c.json(mapping)
    },
  )
  // Stop forwarding a port for this workspace (in memory; a config-declared
  // port comes back when the server restarts).
  .post(
    '/:id/unforward-port',
    zv('json', z.object({ containerPort: z.number().int().min(1).max(65535) })),
    async (c) => {
      requireDriverFeature('portRelay')
      await unforwardWorkspacePort(c.get('principal'), c.req.param('id'), c.req.valid('json').containerPort)
      return c.body(null, 204)
    },
  )
  // Hide a detected port (in memory; resets with the server). As with
  // forward-port, only a currently detected port can be dismissed.
  .post(
    '/:id/dismiss-port',
    zv('json', z.object({ containerPort: z.number().int().min(1).max(65535) })),
    async (c) => {
      requireDriverFeature('portRelay')
      await dismissWorkspacePort(c.get('principal'), c.req.param('id'), c.req.valid('json').containerPort)
      return c.body(null, 204)
    },
  )
  // Steps added to a running workspace (docs/workspace-steps.md): a graph,
  // run in the checkout of the repos it names, or a named workflow's
  // (docs/workflows.md). Their `needs` may name its steps. A
  // non-interactive one refuses.
  .post(
    '/:id/steps',
    zv('json', z.union([
      z.object({ steps: z.unknown(), repos: z.array(z.string().min(1).max(255)).optional() }),
      z.object({ workflow: z.string().min(1) }),
    ])),
    async (c) => c.json(await addSteps(c.get('principal'), c.req.param('id'), c.req.valid('json'))),
  )
  .post('/:id/steps/:name/rerun', async (c) =>
    c.json(await rerunStep(c.get('principal'), c.req.param('id'), c.req.param('name'))))
  .post('/:id/steps/:name/cancel', async (c) => {
    await cancelStep(c.get('principal'), c.req.param('id'), c.req.param('name'))
    return c.body(null, 204)
  })
  // Each life's terminal logs, newest first; then one file's bytes from
  // `offset`, with where to ask from next, so a client follows a log still
  // being written. Kept after a stop, so a stopped workspace answers too.
  .get('/:id/logs', async (c) => c.json(await listWorkspaceLogs(c.get('principal'), c.req.param('id'))))
  .get(
    '/:id/logs/:life/:file',
    zv('query', z.object({ offset: z.coerce.number().int().min(0).optional() })),
    async (c) => {
      const { data, next, size } = await readWorkspaceLog(
        c.get('principal'), c.req.param('id'), c.req.param('life'), c.req.param('file'), c.req.valid('query').offset,
      )
      return c.body(new Uint8Array(data), 200, {
        'content-type': 'application/octet-stream',
        'x-log-next': String(next),
        'x-log-size': String(size),
      })
    },
  )
