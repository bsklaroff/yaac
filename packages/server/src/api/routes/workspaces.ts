import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { jsonBodyLimit, zv } from '#routes/validator'
import { z } from 'zod'
import {
  allowWorkspaceHost,
  createWorkspaceFolder,
  deleteWorkspaceEntry,
  dismissWorkspacePort,
  forwardWorkspacePort,
  getAgentSessionTranscript,
  getWorkspaceBlockedHosts,
  getWorkspaceChanges,
  getWorkspaceDetail,
  getWorkspaceGitStatus,
  getWorkspacePrompt,
  listActiveWorkspaces,
  listStoppedWorkspaces,
  listWorkspaceDir,
  listWorkspaceFiles,
  listWorkspaceGroups,
  readWorkspaceFile,
  registerProvisioning,
  removeProvisioning,
  renameWorkspaceEntry,
  resolveGroup,
  resolveWorkspace,
  resolveWorkspaceContainer,
  resolveWorkspaceRecord,
  resolveRestartTarget,
  restartWorkspace,
  runMamaCommand,
  saveWorkspaceAttachment,
  toAgentSessionEntry,
  writeWorkspaceFile,
} from '#domain/workspaces'
import {
  discardDraftWorkspace,
  discardQueuedWorkspace,
  draftGeneratedTitle,
  queueWorkspace,
  runFromDraft,
  runQueuedWorkspace,
  saveDraftWorkspace,
  startWorkspace,
  stopWorkspace,
  updateQueuedWorkspace,
} from '#domain/workspaces'
import { createShellWindow, killWindowTerminal } from '#runtime/terminals'
import {
  createWorkspaceGroup,
  deleteWorkspaceGroup,
  findWorkspaceByMamaToken,
  findWorkspaceRow,
  listWorkspaceAgentSessions,
  recordAllDeathsSeen,
  recordDeathSeen,
  renameWorkspaceGroup,
  setWorkspaceGroup,
  setWorkspaceGroupPinned,
  setWorkspaceTitle,
} from '#db'
import { streamProvisioned } from '#routes/provisioned-stream'
import { requireDriverFeature } from '#http'
import { workspaceDriver } from '#drivers/driver'
import { ServerError } from '@yaac/shared/errors'
import { MAX_TEXT_FILE_BYTES } from '#lib/text-file'
import { MAX_ATTACHMENT_BYTES } from '@yaac/shared/attachments'
// Group names are stored through `normalizeTitle`, which truncates at
// MAX_TITLE_LENGTH, so routes accept no longer. Otherwise two long names
// sharing a prefix would resolve to one group.
import { MAX_TITLE_LENGTH, normalizeTitle } from '@yaac/shared/titles'
import {
  draftWorkspaceSettingsSchema,
  MAX_PROMPT_LENGTH,
  queuedWorkspaceSettingsSchema,
} from '@yaac/shared/types'

const queuedSettings = queuedWorkspaceSettingsSchema.shape

// The group a queued workspace launches into, by id or name (an unknown name
// creates the group); null means ungrouped. If omitted, a queue takes its
// parent's group and an update keeps the entry's.
const queuedGroup = z.string().min(1).max(MAX_TITLE_LENGTH).nullable().optional()

// The draft a create or queue was made from (docs/draft-workspaces.md). It is
// hidden while the request runs and deleted only after success, so a failure
// keeps the draft.
const draftId = z.string().min(1).optional()

/** The calling workspace a `yaac-mama` request is answered for. */
type MamaCaller = { workspaceId: string; projectSlug: string }

/**
 * The `yaac-mama` endpoint. Both ways in end in `runMamaCommand`, which holds
 * the command allowlist; they differ only in how the caller is identified.
 * Answers are JSON, except `fetch`'s git bundle, sent as the body with the
 * fetched workspace's id in `x-yaac-workspace-id`.
 */
function mamaRoute(identifyCaller: (bearer: string, header: (name: string) => string | undefined)
  => Promise<MamaCaller | undefined>) {
  return new Hono().post(
    '/mama',
    // Bounds what is parsed; the envelope below is far smaller.
    jsonBodyLimit(64 * 1024, 'the yaac-mama request is too large'),
    zv('json', z.object({
      command: z.string().min(1).max(32),
      args: z.record(z.string(), z.string()).optional(),
      body: z.string().max(MAX_PROMPT_LENGTH).optional(),
    })),
    async (c) => {
      const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
      const caller = await identifyCaller(bearer, (name) => c.req.header(name))
      if (!caller) throw new ServerError('UNAUTHENTICATED', 'unknown or revoked yaac-mama credential')

      const { command, args, body } = c.req.valid('json')
      // Take the caller's tool from the runtime, not the request, which could
      // claim any.
      const handle = await workspaceDriver().find(caller.workspaceId).catch(() => null)
      const outcome = await runMamaCommand(
        {
          workspaceId: caller.workspaceId,
          projectSlug: caller.projectSlug,
          ...(handle?.declaredTool !== undefined ? { tool: handle.declaredTool } : {}),
        },
        { command, args: args ?? {}, body: body ?? '' },
      )
      if (!outcome.ok) return c.json({ error: outcome.error }, 422)
      if ('output' in outcome) return c.json({ output: outcome.output })
      return c.body(outcome.bundle, 200, {
        'content-type': 'application/x-git-bundle',
        'x-yaac-workspace-id': outcome.workspaceId,
      })
    },
  )
}

/**
 * Containerless workspaces call the API directly, identified by the bearer
 * token minted at create, so a request cannot claim to be another workspace.
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

export const workspaceApp = new Hono()
  .get(
    '/list',
    zv('query', z.object({ project: z.string().optional() })),
    async (c) => {
      const { project } = c.req.valid('query')
      return c.json(await listActiveWorkspaces(project || undefined))
    },
  )
  .get(
    '/list-stopped',
    zv('query', z.object({
      project: z.string().optional(),
      limit: z.coerce.number().int().positive().optional(),
    })),
    async (c) => {
      const { project, limit } = c.req.valid('query')
      return c.json(await listStoppedWorkspaces(project || undefined, limit))
    },
  )
  .post(
    '/create',
    zv('json', z.object({
      project: z.string().min(1),
      // Pre-generated by the webapp so the provisioning row is usable before
      // any round-trip; the CLI omits it and the server mints one.
      workspaceId: z.string().uuid().optional(),
      // The queue's settings, with the prompt optional and typed into the
      // agent pane once it's up. `acp` with a tool that has no adapter, or a
      // permission mode the tool lacks, is a 400 rather than a downgrade. A
      // permission mode given here becomes the project's next default.
      ...queuedSettings,
      prompt: queuedSettings.prompt.optional(),
      // Sidebar group by id or name; an unknown name creates the group.
      group: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
      draftId,
    })),
    async (c) => {
      const body = c.req.valid('json')
      const workspaceId = body.workspaceId ?? randomUUID()
      // A client-chosen id already in use is a plain 409 before the stream
      // opens. The row insert inside the create guards against races.
      if (body.workspaceId !== undefined && await findWorkspaceRow(workspaceId)) {
        throw new ServerError('CONFLICT', `workspace id ${workspaceId} is already in use`)
      }
      // Without a title, keep the one its draft was shown under.
      const title = normalizeTitle(body.title ?? '')
        || await draftGeneratedTitle(body.project, body.draftId, body.prompt)
      // Reserve the id before streaming, so a second create on an id still
      // provisioning is refused. If the create fails before taking over the
      // reservation (bad group or model), it is dropped rather than left
      // failed; the error is already in the stream.
      registerProvisioning({
        workspaceId,
        projectSlug: body.project,
        tool: body.tool ?? 'claude',
        kind: 'create',
        ...(title ? { title } : {}),
        reserved: true,
      })
      return streamProvisioned(c, workspaceId, (onProgress) => runFromDraft(body.draftId, async () => {
        // Resolve first so a typo'd group doesn't leave a half-built workspace.
        const groupId = body.group === undefined
          ? undefined
          : (await resolveGroup(body.project, body.group, { create: true })).groupId
        return await startWorkspace({
          projectSlug: body.project,
          workspaceId,
          ...(body.tool !== undefined ? { tool: body.tool } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
          ...(body.mode !== undefined ? { mode: body.mode } : {}),
          ...(body.branch !== undefined ? { branch: body.branch } : {}),
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
          ...(title ? { title } : {}),
          ...(groupId !== undefined ? { groupId } : {}),
          // A user request, so its settings become the project's defaults.
          rememberDefaults: true,
          claimSpare: true,
        }, onProgress)
      }))
    },
  )
  .post(
    '/restart',
    zv('json', z.object({
      // An id or its unique prefix.
      workspaceId: z.string().min(1),
      // No `mode`: a workspace restarts in the mode it had, read from
      // `agent_sessions`. No `gitUser`: the commit identity is a server
      // setting.
    })),
    async (c) => {
      const body = c.req.valid('json')
      // Resolve the prefix first so the row, stream and restart all use the
      // exact id.
      const target = await resolveRestartTarget(body.workspaceId)
      // Registered here rather than by restartWorkspace's own `ensure`, so a
      // restart of a workspace already provisioning is a plain 409, and the
      // row is filed under the workspace's group instead of the sidebar top.
      registerProvisioning({
        workspaceId: target.workspaceId,
        projectSlug: target.projectSlug,
        tool: target.tool,
        kind: 'restart',
        ...(target.groupId !== undefined ? { groupId: target.groupId } : {}),
      })
      return streamProvisioned(c, target.workspaceId, (onProgress) =>
        restartWorkspace(target.workspaceId, { onProgress }))
    },
  )
  .post(
    '/stop',
    zv('json', z.object({ workspaceId: z.string().min(1) })),
    async (c) => {
      const { workspaceId } = c.req.valid('json')
      const info = await stopWorkspace(workspaceId)
      return c.json(info)
    },
  )
  // Record that the user viewed an abnormal death's detail, clearing the
  // "Stopped workspaces" dot and row highlight. Stored on the workspace row,
  // so it is shared across clients.
  .post(
    '/mark-death-seen',
    zv('json', z.object({
      projectSlug: z.string().min(1),
      workspaceId: z.string().min(1),
    })),
    async (c) => {
      const { projectSlug, workspaceId } = c.req.valid('json')
      await recordDeathSeen(projectSlug, workspaceId)
      return c.body(null, 204)
    },
  )
  // The same for every workspace in a project ("mark all as read").
  .post(
    '/mark-all-deaths-seen',
    zv('json', z.object({ projectSlug: z.string().min(1) })),
    async (c) => {
      await recordAllDeathsSeen(c.req.valid('json').projectSlug)
      return c.body(null, 204)
    },
  )
  // Queued workspaces (docs/queued-workspaces.md): create requests that run
  // when their parent (a workspace or another entry) stops naturally. Plain
  // JSON rather than a provisioning stream, since queueing is fast and a "Run
  // now" reports progress through its provisioning row. No permission ceiling
  // applies here; that only limits agents (`yaac-mama queue`).
  .post(
    '/queue/create',
    zv('json', z.object({
      project: z.string().min(1),
      // A workspace id or queued entry id, or a unique prefix of either.
      parent: z.string().min(1),
      ...queuedSettings,
      group: queuedGroup,
      draftId,
    })),
    async (c) => {
      const { project, draftId: fromDraft, ...request } = c.req.valid('json')
      return c.json(await runFromDraft(fromDraft, async () => await queueWorkspace(
        project, request, 'user', await draftGeneratedTitle(project, fromDraft, request.prompt))))
    },
  )
  .post(
    '/queue/update',
    zv('json', z.object({
      id: z.string().min(1),
      parent: z.string().min(1).optional(),
      ...queuedSettings,
      prompt: queuedSettings.prompt.optional(),
      group: queuedGroup,
    })),
    async (c) => {
      const { id, ...patch } = c.req.valid('json')
      return c.json(await updateQueuedWorkspace(id, patch, 'user'))
    },
  )
  .post(
    '/queue/discard',
    zv('json', z.object({ id: z.string().min(1) })),
    async (c) => {
      await discardQueuedWorkspace(c.req.valid('json').id)
      return c.body(null, 204)
    },
  )
  .post(
    '/queue/run',
    zv('json', z.object({ id: z.string().min(1) })),
    async (c) => c.json(await runQueuedWorkspace(c.req.valid('json').id)),
  )
  // Draft workspaces (docs/draft-workspaces.md): saved create-dialog contents.
  // A save without an id creates a draft; with one it replaces all fields.
  .post(
    '/draft/save',
    zv('json', draftWorkspaceSettingsSchema.extend({
      id: z.string().min(1).optional(),
      project: z.string().min(1),
    })),
    async (c) => {
      const { id, project, ...settings } = c.req.valid('json')
      return c.json(await saveDraftWorkspace(project, settings, id))
    },
  )
  .post(
    '/draft/discard',
    zv('json', z.object({ id: z.string().min(1) })),
    async (c) => {
      await discardDraftWorkspace(c.req.valid('json').id)
      return c.body(null, 204)
    },
  )
  .route('/', mamaApp)
  // Sidebar-group routes. All take an explicit projectSlug rather than
  // resolving a container, since members may be stopped workspaces.
  // The list is for clients without a snapshot (`yaac group list`); the
  // webapp reads the same rows from `/events`.
  .get(
    '/group/list',
    zv('query', z.object({ project: z.string().optional() })),
    async (c) => {
      const { project } = c.req.valid('query')
      return c.json({ groups: await listWorkspaceGroups(project || undefined) })
    },
  )
  .post(
    '/group/create',
    zv('json', z.object({
      projectSlug: z.string().min(1),
      // The first member ("new group from this workspace"). If omitted, the
      // group starts empty and pinned (as with `yaac group create`).
      workspaceId: z.string().min(1).optional(),
      name: z.string().min(1).max(MAX_TITLE_LENGTH),
    })),
    async (c) => {
      const { projectSlug, workspaceId, name } = c.req.valid('json')
      const group = await createWorkspaceGroup(projectSlug, name, workspaceId ?? null)
      // Return the stored name, which the store normalizes (whitespace
      // collapsed, length capped).
      return c.json({ groupId: group.groupId, name: group.name })
    },
  )
  .post(
    '/group/rename',
    zv('json', z.object({
      projectSlug: z.string().min(1),
      groupId: z.string().min(1),
      name: z.string().min(1).max(MAX_TITLE_LENGTH),
    })),
    async (c) => {
      const { projectSlug, groupId, name } = c.req.valid('json')
      await renameWorkspaceGroup(projectSlug, groupId, name)
      return c.body(null, 204)
    },
  )
  .post(
    '/group/set-pinned',
    zv('json', z.object({
      projectSlug: z.string().min(1),
      groupId: z.string().min(1),
      pinned: z.boolean(),
    })),
    async (c) => {
      const { projectSlug, groupId, pinned } = c.req.valid('json')
      await setWorkspaceGroupPinned(projectSlug, groupId, pinned)
      return c.body(null, 204)
    },
  )
  .post(
    '/group/delete',
    zv('json', z.object({
      projectSlug: z.string().min(1),
      groupId: z.string().min(1),
    })),
    async (c) => {
      const { projectSlug, groupId } = c.req.valid('json')
      await deleteWorkspaceGroup(projectSlug, groupId)
      return c.body(null, 204)
    },
  )
  // File a workspace under a group given by name or id (`yaac group move`,
  // `yaac-mama group move`). The sidebar uses `/set-group` instead, where a
  // drag onto a since-deleted group must fail rather than recreate it by name.
  .post(
    '/group/move',
    zv('json', z.object({
      projectSlug: z.string().min(1),
      workspaceId: z.string().min(1),
      // A group id or name; null makes the workspace ungrouped.
      group: z.string().min(1).max(MAX_TITLE_LENGTH).nullable(),
      // Create the group when no group has this name.
      create: z.boolean().optional(),
    })),
    async (c) => {
      const { projectSlug, workspaceId, group, create } = c.req.valid('json')
      // Accept an id or unique prefix (what every surface prints). The
      // membership write matches exactly, so an unresolved prefix would
      // silently file nothing.
      const found = await resolveWorkspace(workspaceId, { projectSlug })
      if (!found.ok) {
        // An ambiguous prefix is a validation error, not a missing workspace.
        throw found.reason === 'ambiguous'
          ? new ServerError(
            'VALIDATION',
            `Ambiguous workspace prefix in ${projectSlug}: ${workspaceId} — use a longer prefix`,
          )
          : new ServerError('NOT_FOUND', `No such workspace in ${projectSlug}: ${workspaceId}`)
      }
      const resolved = found.workspaceId
      const target = group === null
        ? null
        : await resolveGroup(projectSlug, group, { create: create ?? false })
      await setWorkspaceGroup(projectSlug, resolved, target?.groupId ?? null)
      // Include the name, since the caller may have passed an id.
      return c.json({ groupId: target?.groupId ?? null, name: target?.name ?? null })
    },
  )
  // File a workspace under a group by id, or ungroup it (null).
  .post(
    '/set-group',
    zv('json', z.object({
      projectSlug: z.string().min(1),
      workspaceId: z.string().min(1),
      groupId: z.string().min(1).nullable(),
    })),
    async (c) => {
      const { projectSlug, workspaceId, groupId } = c.req.valid('json')
      await setWorkspaceGroup(projectSlug, workspaceId, groupId)
      return c.body(null, 204)
    },
  )
  .post('/provisioning/:id/dismiss', (c) => {
    // Drop a failed provisioning entry (successful ones clear themselves).
    // Idempotent for any id.
    removeProvisioning(c.req.param('id'))
    return c.body(null, 204)
  })
  .post(
    '/:id/title',
    zv('json', z.object({ title: z.string().max(500) })),
    async (c) => {
      // Resolve the record, not a container, so a stopped or dead workspace
      // can be renamed too.
      const { projectSlug, workspaceId } = await resolveWorkspaceRecord(c.req.param('id'))
      await setWorkspaceTitle(projectSlug, workspaceId, c.req.valid('json').title)
      return c.body(null, 204)
    },
  )
  // A workspace's conversations, active first (`yaac workspace agents <id>`
  // and the webapp's history list).
  .get('/:id/agent-sessions', async (c) => {
    // Resolved from the record, so a stopped workspace works too.
    const { projectSlug, workspaceId } = await resolveWorkspaceRecord(c.req.param('id'))
    const links = await listWorkspaceAgentSessions(projectSlug, workspaceId)
    return c.json(links.map((l) => toAgentSessionEntry(l)))
  })
  // One conversation's history as chat-pane events. Resolved from the record
  // so the stopped-workspaces view can read it. A tool that leaves no host
  // transcript gets a 501.
  .get('/:id/agent-sessions/:sessionId/transcript', async (c) => {
    const { projectSlug, workspaceId } = await resolveWorkspaceRecord(c.req.param('id'))
    const events = await getAgentSessionTranscript(
      projectSlug, workspaceId, c.req.param('sessionId'),
    )
    return c.json({ events })
  })
  // The review diff: everything changed since the workspace forked from its
  // base branch (committed, working and untracked). `base` overrides the
  // branch it is diffed against.
  .get(
    '/:id/changes',
    zv('query', z.object({ base: z.string().min(1).max(255).optional() })),
    async (c) => c.json(await getWorkspaceChanges(c.req.param('id'), c.req.valid('query').base)),
  )
  // Ahead/behind for the status bar, read from the server's own refs so a
  // stopped workspace answers too.
  .get(
    '/:id/git-status',
    zv('query', z.object({ base: z.string().min(1).max(255).optional() })),
    async (c) => c.json(await getWorkspaceGitStatus(c.req.param('id'), c.req.valid('query').base)),
  )
  // The file editor (docs/file-editor.md). Served from the server's view of
  // the checkout, so stopped workspaces work too, under either driver.
  .get('/:id/files', async (c) => c.json(await listWorkspaceFiles(c.req.param('id'))))
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
  // A null `baseVersion` creates the file. A save against a stale version is
  // refused with the file's current version (null if deleted), which the
  // editor saves against next.
  .put(
    '/:id/file',
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
      const result = await writeWorkspaceFile(c.req.param('id'), path, content, baseVersion)
      if ('conflict' in result) {
        const message = result.conflict === null
          ? `${path} no longer exists`
          : `${path} changed since it was read`
        return c.json({ error: { code: 'CONFLICT' as const, message }, version: result.conflict }, 409)
      }
      return c.json(result.saved)
    },
  )
  // An image pasted into a terminal pane: takes raw bytes, returns the path
  // to paste instead.
  .post(
    '/:id/attachments',
    bodyLimit({
      maxSize: MAX_ATTACHMENT_BYTES,
      onError: () => { throw new ServerError('TOO_LARGE', 'the image is over the 5 MB limit') },
    }),
    async (c) => c.json(
      await saveWorkspaceAttachment(c.req.param('id'), new Uint8Array(await c.req.arrayBuffer())),
    ),
  )
  .delete(
    '/:id/file',
    zv('query', z.object({ path: z.string().min(1) })),
    async (c) => {
      await deleteWorkspaceEntry(c.req.param('id'), c.req.valid('query').path)
      return c.body(null, 204)
    },
  )
  .post(
    '/:id/folder',
    zv('json', z.object({ path: z.string().min(1) })),
    async (c) => c.json(await createWorkspaceFolder(c.req.param('id'), c.req.valid('json').path)),
  )
  .post(
    '/:id/rename',
    zv('json', z.object({ from: z.string().min(1), to: z.string().min(1) })),
    async (c) => {
      const { from, to } = c.req.valid('json')
      return c.json(await renameWorkspaceEntry(c.req.param('id'), from, to))
    },
  )
  // Create a scratch-shell window in the session's `yaac` tmux session,
  // returning its entry so the client can focus the pane the snapshot
  // brings.
  .post('/:id/terminals', async (c) => {
    const { jobName } = await resolveWorkspaceContainer(c.req.param('id'), { requireRunning: true })
    return c.json(await createShellWindow(jobName))
  })
  .post(
    '/:id/terminals/close',
    zv('json', z.object({ target: z.string().min(1) })),
    async (c) => {
      const { jobName } = await resolveWorkspaceContainer(c.req.param('id'), { requireRunning: true })
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
    zv('json', z.object({
      // A bare hostname or wildcard pattern as hostMatchesPattern
      // (#lib/allowed-hosts) understands it; no scheme, path or port.
      host: z.string().regex(/^[A-Za-z0-9*._-]+$/, 'host must be a bare hostname or *.wildcard pattern'),
      persist: z.boolean().optional(),
    })),
    async (c) => {
      requireDriverFeature('egress')
      const { host, persist } = c.req.valid('json')
      await allowWorkspaceHost(c.req.param('id'), host, { persist: persist ?? false })
      return c.body(null, 204)
    },
  )
  // Forward a detected, unforwarded port (webapp click-to-forward). The
  // runtime rejects any port not in that detected set, so this can't open an
  // arbitrary port.
  .post(
    '/:id/forward-port',
    zv('json', z.object({
      containerPort: z.number().int().min(1).max(65535),
      persist: z.boolean().optional(),
    })),
    async (c) => {
      requireDriverFeature('portRelay')
      const { containerPort, persist } = c.req.valid('json')
      const mapping = await forwardWorkspacePort(
        c.req.param('id'), containerPort, { persist: persist ?? false },
      )
      return c.json(mapping)
    },
  )
  // Hide a detected port (in memory; resets with the server). As with
  // forward-port, only a currently detected port can be dismissed.
  .post(
    '/:id/dismiss-port',
    zv('json', z.object({ containerPort: z.number().int().min(1).max(65535) })),
    async (c) => {
      requireDriverFeature('portRelay')
      await dismissWorkspacePort(c.req.param('id'), c.req.valid('json').containerPort)
      return c.body(null, 204)
    },
  )
  .get('/:id/prompt', async (c) => {
    const prompt = await getWorkspacePrompt(c.req.param('id'))
    return c.json({ prompt: prompt ?? '' })
  })
