import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTestGitIdentity, runYaac, type RunYaacOptions } from '#support/cli'
import { KEEPER_WINDOW } from '@yaac/server/drivers/contract'
import { assignTestGitCredential } from '@yaac/test-utils/api'
import { createTestRepo } from '@yaac/test-utils/setup'
import { addTestProject } from '#support/cluster'
import { collectSnapshots } from '@yaac/test-utils/events-ws'
import { defaultModelFor } from '@yaac/server/domain/auth'
import { AGENT_PACKAGES } from '@yaac/shared/tool-install'
import { MAX_PROMPT_BYTES, promptFits } from '@yaac/shared/types'
import { lifeDirName } from '@yaac/shared/steps'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { FALLBACK_MODELS, PI_DEFAULT_PROVIDER, piProviderInfo } from '@yaac/shared/tool-providers'
import type {
  ConversationEntry,
  AgentTool,
  ServerSnapshot,
  SessionEntry,
  WorkspaceChanges,
} from '@yaac/shared/types'

const execFileAsync = promisify(execFile)
import {
  ACP_ADAPTER_DIES,
  agentEnvDir,
  CAN_RUN,
  CAN_RUN_ACP,
  ENTER_PLAN_MODE,
  NAME,
  STARTING_GRACE_MS,
  cliEnv,
  createWorkspace,
  createWorkspaceFrom,
  createWorkspaceWith,
  firstSession,
  listWorkspaces,
  mainClone,
  managedBin,
  origin,
  paneEnv,
  processEnv,
  projectId,
  restartServer,
  server,
  serverEnv,
  startRig,
  startedId,
  stopRig,
  testEnv,
  tmux,
  userHome,
  workspaceEnvVar,
} from '#support/containerless-rig'

/**
 * The ways a containerless workspace starts, on the rig in
 * test/support/containerless-rig.ts: in acp mode, re-adopted by a restarted
 * server, into a group, with an agent or a create that fails, with the
 * repos a create picks, and queued behind another or for room in a group.
 * Each case creates the workspaces it needs and stops them.
 */

beforeAll(async () => {
  await startRig()
  if (CAN_RUN) await setTestGitIdentity(serverEnv)
})
afterAll(stopRig)

/**
 * `--mode acp` on a host: acpd supervises the adapter as a host process,
 * reached over a UNIX socket. What can go wrong is host-specific (the
 * adapter's cwd, `socat`, the handshake), and shows up as a workspace that
 * dies right after create or a pane that stays empty. Missing adapters or
 * socat are unit-tested, since the server's PATH is fixed at spawn.
 */
describe.skipIf(!CAN_RUN_ACP)('containerless workspaces in acp mode', () => {
  /**
   * One case per tool: the binary acpd runs, the launch command, and the
   * posture sent over the protocol differ. The shared path (socket, record,
   * row) is checked for each.
   */
  const CASES: Array<{
    tool: AgentTool
    posture: string
    /** The mode id the adapter should be sent, if the posture is sent as one. */
    modeId?: string
    /** Fragments the tmux window's command must carry. */
    launch: string[]
    /** The model the row should show: the handshake's, unless changed after. */
    model: string | undefined
    /** Created with no `--mode`, so it is chat only by default. */
    bare?: true
  }> = [
    {
      // The adapter takes no flags, so the model goes in its environment.
      // It reports a picker alias, recorded as the matching catalog id.
      tool: 'claude',
      posture: 'accept-edits',
      modeId: 'acceptEdits',
      launch: [`ANTHROPIC_MODEL=${FALLBACK_MODELS.claude}`, '-- claude-agent-acp'],
      model: 'claude-opus-5-5',
    },
    {
      // codex's strictest posture, a real read-only sandbox in codex-acp.
      // It is a switch away from the adapter's `agent` default, where
      // failing would leave the conversation looser than asked.
      // (`accept-edits` → `workspace-write` is pinned in drivers.test.ts.)
      tool: 'codex',
      posture: 'read-only',
      modeId: 'read-only',
      launch: ['NO_BROWSER=1', 'CODEX_PATH=codex', '-- codex-acp'],
      model: 'e2e-model',
    },
    {
      // `plan` is the only opencode posture sent as a mode (in v2's
      // `mode` config option); the rest travel in the launch config.
      tool: 'opencode',
      posture: 'plan',
      modeId: 'plan',
      launch: ['OPENCODE_CONFIG_CONTENT=', '-- opencode acp'],
      // The model is sent after the handshake, so the row shows the
      // create's model, not the handshake's.
      model: defaultModelFor('opencode', undefined),
    },
    {
      // pi takes no model at launch; the provider default is sent as the
      // `model` config option after the handshake, and the row shows it.
      // Nothing in this file creates pi otherwise, so no mode is remembered
      // for it and a create naming none is chat.
      tool: 'pi',
      posture: 'bypass',
      launch: ['-- pi-acp'],
      model: piProviderInfo(PI_DEFAULT_PROVIDER).defaultModel,
      bare: true,
    },
    {
      // omp's approval mode and model are launch flags; only `plan` is a
      // mode. tmux shows the command's quotes escaped, so fragments avoid
      // them.
      tool: 'omp',
      posture: 'plan',
      modeId: 'plan',
      launch: ['-- omp acp --config ', `--approval-mode always-ask --model ${defaultModelFor('omp', undefined)}`],
      model: 'e2e-model',
    },
  ]

  /** The workspace each adapter case ran in, which holds the conversation
   *  the fake adapter names for that tool. */
  const adapterCase = new Map<AgentTool, string>()

  it.each(CASES)('supervises $tool\'s adapter under acpd and handshakes a conversation',
    async ({ tool, posture, modeId, launch, model, bare }) => {
      const { workspaceId: id, stdout } = await createWorkspaceFrom(
        '--tool', tool, ...(bare ? [] : ['--mode', 'acp']), '--permission-mode', posture,
      )
      adapterCase.set(tool, id)
      // The CLI cannot show a chat, so it points at the web app instead.
      expect(stdout).toContain(`Workspace ${id} is running in ACP mode — open it in the web app`)

      // The create returns before the agent names its conversation. The
      // registry records it then, with no pod events here to prompt it.
      // acpd's window is logged in the life's dir, where the exited bar's
      // Show log and `yaac workspace logs` read it by name, though the
      // listing leaves it out.
      let window = ''
      await vi.waitFor(async () => {
        const res = await fetch(`${origin()}/api/workspace/list`)
        const { workspaces } = await res.json() as {
          workspaces: Array<{ workspaceId: string; life?: string; sessions: SessionEntry[]; conversations: ConversationEntry[] }>
        }
        const row = workspaces.find((w) => w.workspaceId === id)
        expect(row?.sessions[0]?.mode).toBe('acp')
        expect(row?.conversations.map((s) => s.conversationId)).toContain(`e2e-acp-${tool}`)
        expect(row?.conversations[0]?.mode).toBe('acp')
        // From the record; most tools leave no transcript to read.
        expect(row?.conversations[0]?.model).toBe(model)
        window = row?.sessions[0]?.window ?? ''
        const log = await fetch(`${origin()}/api/workspace/${id}/logs/${lifeDirName(row?.life ?? '')}/${window}.log`)
        expect(await log.text()).toContain('[acpd] listening on')
      }, { timeout: 30_000, interval: 250 })
      expect((await runYaac(cliEnv(), 'workspace', 'logs', id, window)).stdout).toContain('[acpd] listening on')
      expect((await runYaac(cliEnv(), 'workspace', 'logs', id)).stdout).not.toContain(window)

      // acpd records both directions, under the session id once
      // `session/new` answers. The handshake is done once the posture is
      // sent, where it is sent as a mode.
      const record = path.join(
        testEnv.dataDir, 'global', 'projects', projectId, 'acp', id, `e2e-acp-${tool}.jsonl`,
      )
      const readRecord = async (): Promise<Array<{
        method?: string
        params?: { modeId?: string }
        result?: { sessionId?: string; cwd?: string }
      }>> => (await fs.readFile(record, 'utf8').catch(() => '')).trim().split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as { method?: string; params?: { modeId?: string }; result?: { sessionId?: string; cwd?: string } }]
          } catch {
            return []
          }
        })
      await vi.waitFor(async () => {
        const lines = await readRecord()
        expect(lines.some((m) => m.result?.sessionId === `e2e-acp-${tool}`)).toBe(true)
        if (modeId !== undefined) expect(lines.some((m) => m.method === 'session/set_mode')).toBe(true)
      }, { timeout: 30_000, interval: 250 })
      const relayed = await readRecord()

      // The adapter's own cwd must be the checkout; a nonexistent directory
      // (e.g. a container path) fails the spawn like a missing binary.
      const created = relayed.find((m) => m.result?.sessionId === `e2e-acp-${tool}`)
      // `process.cwd()` resolves symlinks, so compare resolved paths.
      expect(created?.result?.cwd).toBe(
        await fs.realpath(path.join(testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', id)),
      )

      // The posture is sent over the protocol, only where the adapter
      // advertises a matching mode.
      const setMode = relayed.find((m) => m.method === 'session/set_mode')
      expect(setMode?.params?.modeId).toBe(modeId)
      // The row keeps the posture asked for; a refused switch would record
      // the adapter's looser default instead.
      expect((await firstSession(id)).permissionMode).toBe(posture)

      // Check the launch command; a wrong variable would be silently ignored.
      const startCmd = await tmux(id, 'display', '-p', '-t', `yaac:${tool}`, '#{pane_start_command}')
      for (const fragment of launch) expect(startCmd).toContain(fragment)

      // A dead adapter would take the window down with it.
      const windows = await tmux(id, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')
      expect(windows).toContain(tool)

      await runYaac(serverEnv, 'workspace', 'stop', id)
    }, 180_000)

  it('reads an opencode conversation out of its live database, its subagent\'s included', async () => {
    // A host opencode's database is its working copy, here held open by a
    // writer whose rows are still only in the WAL. The script reads it as
    // JSONL, the subagent's session after its parent's.
    //
    // A conversation belongs to the workspace that first recorded it, and
    // the fake adapter names every opencode conversation alike, so the
    // adapter case's stopped workspace goes first.
    const earlier = adapterCase.get('opencode')
    if (earlier !== undefined) {
      await vi.waitFor(async () => {
        expect((await runYaac(serverEnv, 'workspace', 'delete', earlier, '--yes')).exitCode).toBe(0)
      }, { timeout: 60_000, interval: 2000 })
    }
    const id = await createWorkspaceWith('opencode', '--mode', 'acp')
    const short = id.slice(0, 8)
    const db = new DatabaseSync(path.join(testEnv.dataDir, 'global', 'projects', projectId, 'opencode-data', id, 'opencode.db'))
    try {
      db.exec(`pragma journal_mode = wal; pragma wal_autocheckpoint = 0;
        create table session_v2 (id text primary key, parent_id text, time_created integer);
        create table session_message (id text primary key, session_id text, type text, seq integer,
          time_created integer, data text);
        insert into session_v2 values ('e2e-acp-opencode', null, 1), ('ses_child', 'e2e-acp-opencode', 2);
        insert into session_message values ('m1', 'e2e-acp-opencode', 'user', 1, 1, '{"text":"parent ask"}'),
          ('m2', 'ses_child', 'user', 1, 2, '{"text":"child ask"}')`)
      const env = {
        ...process.env,
        YAAC_MAMA_URL: await workspaceEnvVar(id, 'YAAC_MAMA_URL'),
        YAAC_MAMA_TOKEN: await workspaceEnvVar(id, 'YAAC_MAMA_TOKEN'),
      }
      const mama = (...args: string[]) =>
        execFileAsync(path.join(process.cwd(), 'workspace-bin', 'yaac-mama'), args, { env })

      // Listed once the registry records the conversation, after the create.
      await vi.waitFor(async () => {
        expect((await mama('history', short)).stdout).toMatch(/e2e-acp-opencode\s+opencode\s+acp/)
      }, { timeout: 30_000, interval: 250 })
      const printed = (await mama('history', short, 'e2e-acp')).stdout.trim().split('\n')
        .map((line) => JSON.parse(line) as { session: string; data: { text: string } })
      expect(printed.map((l) => [l.session, l.data.text]))
        .toEqual([['e2e-acp-opencode', 'parent ask'], ['ses_child', 'child ask']])

      const saved = path.join(testEnv.scratchDir, `opencode-history-${short}`)
      const written = (await mama('history', short, '-o', saved)).stdout.trim().split('\n')
      const conversation = path.join(saved, 'e2e-acp-opencode')
      expect(written).toEqual(expect.arrayContaining([
        path.join(conversation, 'opencode.db'),
        path.join(conversation, 'acpd.jsonl'),
        path.join(conversation, 'e2e-acp-opencode.jsonl'),
        path.join(conversation, 'subagents', 'ses_child.jsonl'),
      ]))
      expect(await fs.readFile(path.join(conversation, 'subagents', 'ses_child.jsonl'), 'utf8')).toContain('child ask')
    } finally {
      db.close()
    }
    await runYaac(serverEnv, 'workspace', 'stop', id)
  }, 180_000)

  it('records a mode the agent moves itself to, and restarts the conversation in it', async () => {
    // The agent moves itself into plan mode mid-turn (as EnterPlanMode
    // does); a restart must relaunch in plan, not the created posture.
    const id = await createWorkspaceWith(
      'claude', '--mode', 'acp', '--permission-mode', 'accept-edits', '--prompt', ENTER_PLAN_MODE,
    )
    const record = path.join(
      testEnv.dataDir, 'global', 'projects', projectId, 'acp', id, 'e2e-acp-claude.jsonl',
    )
    const relayed = async (): Promise<Array<{
      id?: unknown; method?: string; params?: { modeId?: string }; result?: unknown
    }>> => (await fs.readFile(record, 'utf8').catch(() => '')).split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line) as { id?: unknown; method?: string; params?: { modeId?: string } }]
      } catch {
        return []
      }
    })
    const setModes = async (): Promise<Array<string | undefined>> =>
      (await relayed()).filter((m) => m.method === 'session/set_mode').map((m) => m.params?.modeId)

    // The turn is done once its reply is recorded.
    await vi.waitFor(async () => {
      const lines = await relayed()
      const prompt = lines.find((m) => m.method === 'session/prompt')
      expect(prompt).toBeDefined()
      expect(lines.some((m) => m.method === undefined && m.id === prompt?.id)).toBe(true)
    }, { timeout: 30_000, interval: 250 })
    expect(await setModes()).toEqual(['acceptEdits'])

    expect((await runYaac(serverEnv, 'workspace', 'stop', id)).exitCode).toBe(0)
    expect((await runYaac(serverEnv, 'workspace', 'restart', id)).exitCode).toBe(0)
    // acpd starts a new record, so the only set_mode is the restart's.
    await vi.waitFor(async () => {
      expect(await setModes()).toEqual(['plan'])
    }, { timeout: 30_000, interval: 250 })

    await runYaac(serverEnv, 'workspace', 'stop', id)
  }, 180_000)

  // A move up (as a "yes, and bypass permissions" plan exit does) is
  // followed too.
  it('records a mode the agent moves itself up to, and restarts the conversation in it', async () => {
    const id = await createWorkspaceWith(
      'claude', '--mode', 'acp', '--permission-mode', 'plan', '--prompt', 'enter bypassPermissions mode',
    )
    const record = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'acp', id, 'e2e-acp-claude.jsonl')
    const relayed = async (): Promise<Array<{
      id?: unknown; method?: string; params?: { modeId?: string; id?: string }
    }>> => (await fs.readFile(record, 'utf8').catch(() => '')).split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line) as { id?: unknown; method?: string; params?: { modeId?: string; id?: string } }]
      } catch {
        return []
      }
    })
    const life = async (): Promise<string | undefined> =>
      (await relayed()).find((m) => m.method === '_acpd/life')?.params?.id
    await vi.waitFor(async () => {
      const lines = await relayed()
      const prompt = lines.find((m) => m.method === 'session/prompt')
      expect(prompt).toBeDefined()
      expect(lines.some((m) => m.method === undefined && m.id === prompt?.id)).toBe(true)
    }, { timeout: 30_000, interval: 250 })
    const before = await life()

    expect((await runYaac(serverEnv, 'workspace', 'stop', id)).exitCode).toBe(0)
    expect((await runYaac(serverEnv, 'workspace', 'restart', id)).exitCode).toBe(0)
    await vi.waitFor(async () => {
      expect(await life()).not.toBe(before)
      expect((await relayed()).filter((m) => m.method === 'session/set_mode').map((m) => m.params?.modeId))
        .toEqual(['bypassPermissions'])
    }, { timeout: 30_000, interval: 250 })

    await runYaac(serverEnv, 'workspace', 'stop', id)
  }, 180_000)

  it('hands a pasted image to the agent: a file for the terminal, a block for the chat', async () => {
    const id = await createWorkspaceWith('claude', '--mode', 'acp', '--permission-mode', 'accept-edits')
    const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('e2e pixels')])

    // A terminal paste returns a host path, which the agent reads as it is.
    const res = await fetch(`${origin()}/api/workspace/${id}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    })
    expect(res.status).toBe(200)
    const { path: pasted } = await res.json() as { path: string }
    expect(await fs.readFile(pasted)).toEqual(png)

    // A chat message carries its images inline to the agent, and they show
    // in the history a later attach receives. acpd keeps a large one out of
    // the record, which names it by hash, and the server serves it from
    // there.
    const attach = async (): Promise<{ ws: WebSocket; hello: { events: Array<{ type: string; content?: unknown[] }> } }> => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${String(server.lock.port)}/api/acp/attach?id=${id}&session=e2e-acp-claude`,
      )
      const hello = await new Promise<{ events: Array<{ type: string; content?: unknown[] }> }>((resolve, reject) => {
        ws.on('message', (data) => {
          const msg = JSON.parse((data as Buffer).toString('utf8')) as { type: string; events: Array<{ type: string }> }
          if (msg.type === 'hello') resolve(msg)
        })
        ws.once('close', () => reject(new Error('closed before hello')))
        ws.once('error', reject)
      })
      return { ws, hello }
    }
    const first = await vi.waitFor(attach, { timeout: 30_000, interval: 500 })
    const image = { type: 'image', mimeType: 'image/png', data: png.toString('base64') }
    const screenshot = Buffer.concat([png, Buffer.alloc(64 * 1024, 1)])
    const hash = createHash('sha256').update(screenshot).digest('hex')
    first.ws.send(JSON.stringify({
      type: 'prompt',
      text: 'what is this?',
      images: [image, { type: 'image', mimeType: 'image/png', data: screenshot.toString('base64') }],
    }))
    const record = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'acp', id, 'e2e-acp-claude.jsonl')
    await vi.waitFor(async () => {
      const prompt = (await fs.readFile(record, 'utf8')).split('\n')
        .map((l) => { try { return JSON.parse(l) as { method?: string; params?: { prompt?: unknown } } } catch { return {} } })
        .find((m) => m.method === 'session/prompt')
      expect(prompt?.params?.prompt).toEqual([
        { type: 'text', text: 'what is this?' }, image, { type: 'image', mimeType: 'image/png', data: `yaac-image:${hash}` },
      ])
    }, { timeout: 30_000, interval: 250 })
    first.ws.close()

    const second = await attach()
    second.ws.close()
    expect(second.hello.events.find((e) => e.type === 'user')?.content)
      .toEqual([{ type: 'text', text: 'what is this?' }, image, { type: 'image', mimeType: 'image/png', hash }])
    const served = await fetch(`${origin()}/api/workspace/${id}/acp-images/${hash}`)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await served.arrayBuffer())).toEqual(screenshot)

    await runYaac(serverEnv, 'workspace', 'stop', id)
  }, 180_000)

  // The create returns before the handshake, so an adapter that dies first
  // is reported afterwards, as a failed create naming the adapter, with the
  // prompt beside it to reuse.
  it('reports a create whose adapter died before its handshake', async () => {
    const marker = path.join(path.dirname(managedBin('claude-agent-acp')), ACP_ADAPTER_DIES)
    await fs.writeFile(marker, '')
    const watch = collectSnapshots(server.lock.port)
    try {
      await watch.opened
      const { exitCode, stdout, stderr } = await runYaac(
        serverEnv, 'workspace', 'create', NAME, '--tool', 'claude', '--mode', 'acp', '--prompt', 'fix the parser',
      )
      expect(exitCode, `${stdout}${stderr}`).toBe(0)
      const id = /Workspace (\S+) is running in ACP mode/.exec(stdout)?.[1]
      expect(id).toBeDefined()
      await vi.waitFor(() => {
        const failed = watch.latest()?.provisioning.find((p) => p.workspaceId === id)
        expect(failed?.error).toMatch(/before its handshake.*claude-agent-acp/)
        expect(failed?.prompt).toBe('fix the parser')
      }, { timeout: 30_000, interval: 500 })
      await fetch(`${origin()}/api/workspace/provisioning/${id!}/dismiss`, { method: 'POST' })
    } finally {
      watch.ws.close()
      await fs.rm(marker, { force: true })
    }
  }, 120_000)
})

// Replaces the shared server, so it runs after the cases above.
describe.skipIf(!CAN_RUN)('containerless recovery across a server restart', () => {
  it('re-adopts a workspace whose tmux server outlived the server that made it', async () => {
    const id = await createWorkspace()

    // A real restart on the same data dir, via the fixture so `server`
    // stays the process afterAll stops.
    await restartServer(serverEnv)

    // Restarting the server must not stop any agent.
    await expect(tmux(id, 'has-session', '-t', 'yaac')).resolves.toBeDefined()

    // The new server recovers it from the markers on disk. Polled, since
    // recovery runs after the server starts answering.
    await vi.waitFor(
      async () => expect((await listWorkspaces()).map((w) => w.workspaceId)).toContain(id),
      { timeout: 20_000, interval: 250 },
    )

    await runYaac(serverEnv, 'workspace', 'stop', id)
  }, 180_000)

  // The rest of the file skips the fetch of origin. Here the server fetches
  // for real, from a local repository standing in for the project's remote
  // and slowed by a hook, so the start cannot have waited for it.
  it('starts a workspace on the commit the main clone has, then catches it up when its slow fetch lands', async () => {
    const run = async (cwd: string, ...args: string[]): Promise<string> =>
      (await execFileAsync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd })).stdout.trim()
    // Origin as the main clone last saw it, plus one commit.
    const main = path.join(testEnv.dataDir, 'global', 'repos', projectId)
    const branch = (await run(main, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).replace(/^origin\//, '')
    const remote = path.join(testEnv.scratchDir, 'catch-up-origin.git')
    await run(testEnv.scratchDir, 'init', '-q', '--bare', '-b', branch, remote)
    await run(main, 'push', '-q', remote, `refs/remotes/origin/${branch}:refs/heads/${branch}`)
    const work = path.join(testEnv.scratchDir, 'catch-up-push')
    await run(testEnv.scratchDir, 'clone', '-q', remote, work)
    await fs.writeFile(path.join(work, 'late.txt'), 'pushed after the main clone was made\n')
    await run(work, 'add', '-A')
    await run(work, 'commit', '-q', '-m', 'late')
    await run(work, 'push', '-q', 'origin', 'HEAD')
    const tip = await run(work, 'rev-parse', 'HEAD')

    // The server's git reads its remote from this config: the URL is
    // rewritten to the local repository, and packing what the fetch asks
    // for takes three seconds.
    const hook = path.join(testEnv.scratchDir, 'slow-pack.sh')
    await fs.writeFile(hook, '#!/bin/sh\nsleep 3\nexec "$@"\n', { mode: 0o755 })
    const gitConfig = serverEnv.GIT_CONFIG_GLOBAL as string
    const before = await fs.readFile(gitConfig, 'utf8')
    await fs.appendFile(gitConfig, [
      `[url "${remote}"]`, `\tinsteadOf = https://github.com/test/${NAME}.git`,
      '[protocol "file"]', '\tallow = always',
      '[uploadpack]', `\tpackObjectsHook = ${hook}`, '',
    ].join('\n'))
    // A restarted server recovers the workspaces still running after it
    // starts answering. `createWorkspace` finds its workspace as the one
    // newly listed, so every restart here waits for them to be listed.
    const restart = async (env: NodeJS.ProcessEnv): Promise<void> => {
      const running = (await listWorkspaces()).map((w) => w.workspaceId)
      await restartServer(env)
      await vi.waitFor(
        async () => expect((await listWorkspaces()).map((w) => w.workspaceId)).toEqual(expect.arrayContaining(running)),
        { timeout: 30_000, interval: 250 },
      )
    }
    await restart({ ...serverEnv, YAAC_E2E_SKIP_FETCH: '0' })
    try {
      const id = await createWorkspace()
      const checkout = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', id)
      await vi.waitFor(async () => { expect(await run(checkout, 'rev-parse', 'HEAD')).toBe(tip) }, { timeout: 30_000, interval: 250 })
      expect(await fs.readFile(path.join(checkout, 'late.txt'), 'utf8')).toBe('pushed after the main clone was made\n')
      expect(await run(checkout, 'rev-parse', 'origin/HEAD')).toBe(tip)
      expect(await run(checkout, 'status', '--porcelain')).toBe('')
      await vi.waitFor(async () => {
        const listed = await (await fetch(`${origin()}/api/workspace/list`)).json() as {
          workspaces: Array<{ workspaceId: string; repos: Array<{ startCommit?: string }> }>
        }
        expect(listed.workspaces.find((w) => w.workspaceId === id)?.repos[0]?.startCommit).toBe(tip)
      }, { timeout: 15_000, interval: 250 })
      await runYaac(serverEnv, 'workspace', 'stop', id)
    } finally {
      await fs.writeFile(gitConfig, before)
      await restart(serverEnv)
    }
  }, 240_000)
})

describe.skipIf(!CAN_RUN)('yaac forward against a containerless server on this machine', () => {
  it('refuses, because the workspace already binds the host port itself', async () => {
    // Workspace ports are already this host's ports, so a forwarder here
    // would fight the dev servers for them (docs/port-forward-tunnel.md).
    // The refusal depends only on the server, so no workspace is named.
    const { exitCode, stderr } = await runYaac(serverEnv, 'forward')
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/containerless driver/)
    expect(stderr).toMatch(/nothing to tunnel/)
  })

  // Past the refusal (`--bind`), a workspace it cannot resolve fails now,
  // rather than forwarding nothing forever.
  it('refuses a workspace it cannot resolve', async () => {
    const { exitCode, stderr } = await runYaac(serverEnv, 'forward', 'no-such-session', '--bind', '127.0.0.1')
    expect(exitCode).toBe(1)
    expect(stderr).toContain('workspace no-such-session not found')
  })
})

/**
 * The `--group` flag of `yaac workspace create`, and the project refs
 * `yaac workspace list` accepts. The k8s suite covers the same server code
 * through `yaac-mama create --group`.
 */
describe.skipIf(!CAN_RUN)('yaac workspace create --group', () => {
  it('creates the named group and files the new workspace into it, listed by any project ref', async () => {
    const { stdout, stderr, exitCode } = await runYaac(
      serverEnv, 'workspace', 'create', NAME, '--tool', 'claude', '--group', 'friday batch',
    )
    if (exitCode !== 0) {
      throw new Error(`create failed (exit ${String(exitCode)})\n${stdout}\n${stderr}`)
    }
    const freshId = startedId(stdout)

    // The group is created by name.
    const res = await fetch(`${origin()}/api/workspace/group/list?project=${NAME}`)
    const { groups } = await res.json() as { groups: Array<{ groupId: string; name: string }> }
    const made = groups.find((g) => g.name === 'friday batch')
    expect(made).toBeDefined()

    // And the workspace is filed in it, found by the project's name, full
    // id or id prefix alike.
    for (const ref of [NAME, projectId, projectId.slice(0, 8)]) {
      const listed = await runYaac(serverEnv, 'workspace', 'list', ref)
      expect(listed.stdout, ref).toMatch(new RegExp(`${freshId.slice(0, 8)}[^\\n]*friday batch`))
      expect(listed.stdout, ref).toContain(NAME)
    }

    // A second project from the same remote shares the name, so the name
    // alone is refused with both candidates; the twin is removed after.
    const twinRepo = await createTestRepo(path.join(testEnv.scratchDir, 'twin', NAME))
    const twin = await addTestProject(server, twinRepo, { remoteUrl: `https://github.com/test/${NAME}.git` })
    try {
      const ambiguous = await runYaac(serverEnv, 'workspace', 'list', NAME)
      expect(ambiguous.exitCode).not.toBe(0)
      expect(ambiguous.stderr).toContain(projectId)
      expect(ambiguous.stderr).toContain(twin)
    } finally {
      const removed = await fetch(`${origin()}/api/project/${twin}`, { method: 'DELETE' })
      expect(removed.status).toBe(204)
    }

    await runYaac(serverEnv, 'workspace', 'stop', freshId)
  }, 180_000)
})

/** An agent that is installed but exits as soon as it launches. */
describe.skipIf(!CAN_RUN)('an agent that dies the moment it launches', () => {
  it('reports it as a failed provisioning row instead of a workspace that vanishes', async () => {
    const watch = collectSnapshots(server.lock.port)
    await watch.opened
    try {
      // The fake codex exits 127 with `--model sick`, so tmux closes the
      // window, though `respawn-window` reports success.
      const { exitCode } = await runYaac(
        serverEnv, 'workspace', 'create', NAME, '--tool', 'codex', '--mode', 'tui', '--model', 'sick',
      )
      // Create succeeds: the launch check runs afterwards, so it never
      // slows a create down.
      expect(exitCode).toBe(0)

      await vi.waitFor(() => {
        const row = watch.latest()?.provisioning.find((p) => p.tool === 'codex' && p.error)
        expect(row?.error).toMatch(/exited right after launch/)
        // Containerless rows also name the package to check.
        expect(row?.error).toContain(`@openai/codex@${AGENT_PACKAGES.codex.version}`)
      }, { timeout: 30_000, interval: 250 })
    } finally {
      watch.ws.close()
    }
  }, 180_000)
})

/**
 * A create that fails shows its prompt with the failure. The webapp's
 * creates keep it as a draft too; the CLI's do not, since a CLI retry could
 * only add another draft.
 */
describe.skipIf(!CAN_RUN)('a create that fails', () => {
  it('shows its prompt with the failure, and keeps it as a draft only for the webapp', async () => {
    const watch = collectSnapshots(server.lock.port)
    await watch.opened
    try {
      const cliPrompt = 'a cli prompt'
      const bad = await runYaac(serverEnv, 'workspace', 'create', NAME, '--branch', 'ghost', '--prompt', cliPrompt)
      expect(bad.exitCode).not.toBe(0)
      expect(bad.stdout + bad.stderr).toContain('branch "ghost" not found on origin')
      await vi.waitFor(() => {
        expect(watch.latest()?.provisioning.find((p) => p.prompt === cliPrompt)?.error).toBeDefined()
      }, { timeout: 30_000, interval: 250 })
      expect(watch.latest()!.draftWorkspaces.some((d) => d.prompt === cliPrompt)).toBe(false)

      const webPrompt = 'a webapp prompt'
      const res = await fetch(`${origin()}/api/workspace/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: NAME, tool: 'claude', mode: 'tui', branch: 'ghost', prompt: webPrompt, draftOnFailure: true }),
      })
      await expect(consumeNdjsonStream(res, () => {})).rejects.toThrow(
        /branch "ghost" not found on origin.*; its prompt is kept as a draft/)
      await vi.waitFor(() => {
        expect(watch.latest()?.draftWorkspaces.find((d) => d.prompt === webPrompt))
          .toMatchObject({ projectId, repos: [{ repo: projectId, branch: 'ghost' }] })
      }, { timeout: 30_000, interval: 250 })
      const draft = watch.latest()!.draftWorkspaces.find((d) => d.prompt === webPrompt)!
      const discarded = await fetch(`${origin()}/api/workspace/draft/discard`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: draft.id }),
      })
      expect(discarded.ok).toBe(true)
    } finally {
      watch.ws.close()
    }
  }, 180_000)
})

/**
 * A workspace's agents (docs/sessions.md), on one workspace that a create
 * made as the webapp makes one starts with none: agents opened in it with
 * `--workspace`, listed, stopped one at a time and resumed, by a person
 * through the CLI and by an agent of its own through yaac-mama. The cases
 * run in order on it.
 */
describe.skipIf(!CAN_RUN)('agents opened in a running workspace', () => {
  const workspaceId = randomUUID()
  const id8 = workspaceId.slice(0, 8)

  /** The workspace's open agents, oldest first. */
  const sessions = async (): Promise<SessionEntry[]> =>
    (await listWorkspaces()).find((w) => w.workspaceId === workspaceId)?.sessions ?? []
  const windows = async (): Promise<string[]> =>
    (await tmux(workspaceId, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')).trim().split('\n')
  const windowsSettle = (check: (names: string[]) => void): Promise<void> =>
    vi.waitFor(async () => check(await windows()), { timeout: 30_000, interval: 250 })
  /** The CLI's stdout, failing on a non-zero exit. */
  const yaac = async (...args: Array<string | RunYaacOptions>): Promise<string> => {
    const { stdout, stderr, exitCode } = await runYaac(cliEnv(), ...args)
    if (exitCode !== 0) throw new Error(`yaac ${args.filter((a) => typeof a === 'string').join(' ')} failed (exit ${String(exitCode)}):\n${stderr}`)
    return stdout
  }

  /** `yaac-mama` as agent `session` runs it, in the environment that agent
   *  started with; its output and exit code. */
  async function mamaAs(session: SessionEntry, ...args: string[]): Promise<{ code: number; out: string }> {
    const env = await vi.waitFor(async () => {
      const pid = (await tmux(workspaceId, 'display-message', '-p', '-t', `yaac:${session.window}`, '#{pane_pid}')).trim()
      const dumped = await processEnv(pid)
      expect(dumped.YAAC_SESSION_ID).toBe(session.sessionId)
      return dumped
    }, { timeout: 30_000, interval: 250 })
    const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
    const { stdout } = await execFileAsync('sh', ['-c',
      `${path.join(process.cwd(), 'workspace-bin', 'yaac-mama')} ${quoted} 2>&1 </dev/null; echo "EXIT:$?"`,
    ], {
      env: {
        ...process.env,
        YAAC_MAMA_URL: env.YAAC_MAMA_URL,
        YAAC_MAMA_TOKEN: env.YAAC_MAMA_TOKEN,
        YAAC_SESSION_ID: env.YAAC_SESSION_ID,
        YAAC_WORKSPACE_ID: workspaceId,
      },
    })
    const m = /EXIT:(\d+)\s*$/.exec(stdout)
    if (!m) throw new Error(`no exit marker:\n${stdout}`)
    return { code: Number(m[1]), out: stdout.slice(0, m.index) }
  }

  afterAll(() => runYaac(serverEnv, 'workspace', 'stop', workspaceId))

  // The webapp picks the id, so its provisioning row and then the workspace
  // carry it; no snapshot shows both.
  it('hands a create with a client-supplied id over to a running workspace of that id, with no agent', async () => {
    const watch = collectSnapshots(server.lock.port)
    const frames: Array<{ provisioning: boolean; listed: boolean }> = []
    watch.ws.on('message', (data, isBinary) => {
      if (isBinary) return
      const msg = JSON.parse((data as Buffer).toString('utf8')) as { type: string; data: ServerSnapshot }
      if (msg.type !== 'snapshot') return
      frames.push({
        provisioning: msg.data.provisioning.some((p) => p.workspaceId === workspaceId && p.kind === 'create' && p.projectId === projectId),
        listed: msg.data.workspaces.some((w) => w.workspaceId === workspaceId),
      })
    })
    try {
      await watch.opened
      const res = await fetch(`${origin()}/api/workspace/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: NAME, noSession: true, workspaceId }),
      })
      expect((await consumeNdjsonStream<{ workspaceId: string }>(res, () => {})).workspaceId).toBe(workspaceId)
      await vi.waitFor(() => expect(frames.at(-1)).toEqual({ provisioning: false, listed: true }), { timeout: 20_000, interval: 100 })
      expect(frames.some((f) => f.provisioning)).toBe(true)
      expect(frames.filter((f) => f.provisioning && f.listed)).toEqual([])
    } finally {
      watch.ws.close()
    }
    expect(await windows()).toEqual([KEEPER_WINDOW])
    // No tool, and an agent count of 0.
    expect(await yaac('workspace', 'list', NAME)).toMatch(new RegExp(`^${id8}\\s+${NAME}\\s+-\\s+\\S+\\s+0\\b`, 'm'))
  }, 120_000)

  it('opens agents in it with --workspace, each in a window of its own, counted and listed under AGENT', async () => {
    // Read whole from stdin: longer than a pipe holds at once.
    const prompt = `review "this" ✓\n${'a line of the brief, read from stdin\n'.repeat(2_000)}the end`
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(64 * 1024)
    expect(await yaac('workspace', 'create', '--workspace', id8, '--tool', 'claude', '--mode', 'tui', '--prompt', '-', { stdin: prompt }))
      .toMatch(/attach with `yaac workspace attach --agent [0-9a-f-]{36} [0-9a-f-]{36}`/)
    // Prompted, codex reports its conversation, which a message to it needs.
    // The model is named, since the project remembers the one an earlier
    // case made the fake codex fail on.
    await yaac('workspace', 'create', '--workspace', workspaceId, '--tool', 'codex', '--mode', 'tui', '--model', FALLBACK_MODELS.codex,
      '--prompt', 'say hi')
    const [claude, codex] = await sessions()
    expect([claude, codex]).toMatchObject([{ tool: 'claude', mode: 'tui' }, { tool: 'codex', mode: 'tui', prompt: 'say hi' }])
    await windowsSettle((names) => expect(names).toEqual(expect.arrayContaining([claude.window, codex.window])))
    // The agent is launched with the whole prompt, plus the trailing space
    // claude's gets (`openingArg`).
    await vi.waitFor(async () => {
      const argv = (await fs.readFile(path.join(agentEnvDir(), `${claude.sessionId}.argv`), 'utf8').catch(() => '')).split('\0')
      expect(argv.includes(`${prompt} `)).toBe(true)
    }, { timeout: 30_000, interval: 250 })

    const listed = await yaac('workspace', 'list', NAME)
    expect(listed).toMatch(new RegExp(`^${id8}\\s+${NAME}\\s+claude,codex\\s+\\S+\\s+2\\b`, 'm'))
    expect(listed).toMatch(/WORKSPACE\s+AGENT\s+TOOL\s+MODE\s+STATUS\s+TITLE/)
    for (const s of [claude, codex]) {
      expect(listed).toMatch(new RegExp(`^${id8}\\s+${s.sessionId.slice(0, 8)}\\s+${s.tool}`, 'm'))
    }
  }, 120_000)

  /**
   * Name a claude agent's conversation on its pane, as claude's SessionStart
   * hook would (the fake claude names none), and wait for the server to
   * link it. A fresh claude agent's conversation is its own id.
   */
  async function reportConversation(session: SessionEntry): Promise<void> {
    await tmux(workspaceId, 'set-option', '-p', '-t', `yaac:${session.window}`, '@yaac-session', `claude|${session.sessionId}|`)
    await vi.waitFor(async () => {
      expect((await sessions()).find((s) => s.sessionId === session.sessionId)?.conversationId).toBe(session.sessionId)
    }, { timeout: 30_000, interval: 250 })
  }

  // Stopped, an agent's conversation comes back as a new agent with
  // --resume.
  it('stops one agent with stop --agent, leaving the workspace running, and resumes its conversation with --resume', async () => {
    const [claude, codex] = await sessions()
    await reportConversation(claude)
    expect(await yaac('workspace', 'stop', '--agent', claude.sessionId.slice(0, 8))).toContain(
      `Agent ${claude.sessionId} stopped; its conversations stay in workspace ${workspaceId}'s history. The workspace keeps running.`,
    )
    expect((await sessions()).map((s) => s.sessionId)).toEqual([codex.sessionId])
    await windowsSettle((names) => expect(names).not.toContain(claude.window))
    expect(await windows()).toContain(KEEPER_WINDOW)
    expect(await yaac('workspace', 'conversations', workspaceId)).toMatch(new RegExp(`${claude.sessionId}\\s+claude\\s+ended`))

    await yaac('workspace', 'create', '--workspace', workspaceId, '--resume', claude.sessionId)
    const resumed = (await sessions()).find((s) => s.tool === 'claude')
    expect(resumed).toMatchObject({ tool: 'claude', conversationId: claude.sessionId })
    expect(resumed?.sessionId).not.toBe(claude.sessionId)
    await windowsSettle((names) => expect(names).toContain(resumed?.window))
  }, 90_000)

  // An agent may open only a tool its owner is signed in to, which here is
  // claude alone. The message goes to the codex a person opened, since only
  // the fake codex reads what it is sent.
  it('lets its agents open, list, message, stop and resume each other through yaac-mama, never messaging themselves', async () => {
    const [codex, caller] = await sessions()
    const opened = await mamaAs(caller, 'create', '--workspace', workspaceId, '--tool', 'claude', '--ui-mode', 'tui', 'review the README')
    expect(opened.code, opened.out).toBe(0)
    const openedId = opened.out.trim()
    expect(openedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const agent = (await sessions()).find((s) => s.sessionId === openedId)!
    expect(agent).toMatchObject({ tool: 'claude', mode: 'tui', prompt: 'review the README' })

    const listed = await mamaAs(caller, 'list')
    expect(listed.out).toMatch(/WORKSPACE\s+AGENT\s+TOOL\s+STATUS\s+TITLE/)
    expect(listed.out).toContain(openedId.slice(0, 8))
    // As that agent, it is marked as the caller.
    expect((await mamaAs(agent, 'list')).out).toContain(`${openedId.slice(0, 8)} (you)`)

    // An agent never messages itself, but may message its sibling.
    const self = await mamaAs(agent, 'send', '--agent', openedId, workspaceId, 'hello me')
    expect(self.code).toBe(1)
    expect(self.out).toContain(`no running agent '${openedId}'`)
    await vi.waitFor(async () => {
      expect((await sessions()).find((s) => s.sessionId === codex.sessionId)?.conversationId).toBeDefined()
    }, { timeout: 30_000, interval: 250 })
    const sent = await mamaAs(agent, 'send', '--agent', codex.sessionId.slice(0, 8), workspaceId, 'from your sibling')
    expect(sent.code, sent.out).toBe(0)
    expect(sent.out).toContain(`Sent to ${id8}'s codex agent ${codex.sessionId.slice(0, 8)}`)
    const inbox = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'codex', `sent-${workspaceId}`)
    await vi.waitFor(async () => expect(await fs.readFile(inbox, 'utf8').catch(() => '')).toContain('from your sibling'),
      { timeout: 30_000, interval: 500 })

    // Bare, stop --agent stops the asking agent; the workspace runs on.
    await reportConversation(agent)
    const closed = await mamaAs(agent, 'stop', '--agent')
    expect(closed.code, closed.out).toBe(0)
    expect(closed.out).toContain(`Stopped agent ${openedId.slice(0, 8)}; its conversations stay in `)
    expect(closed.out).toContain('keeps running.')
    expect((await sessions()).map((s) => s.sessionId)).toEqual([codex.sessionId, caller.sessionId])

    const resumed = await mamaAs(caller, 'create', '--workspace', workspaceId, '--resume', openedId)
    expect(resumed.code, resumed.out).toBe(0)
    expect(resumed.out.trim()).not.toBe(openedId)
    expect((await sessions()).find((s) => s.sessionId === resumed.out.trim())).toMatchObject({ tool: 'claude', conversationId: openedId })
    const refused = await mamaAs(caller, 'create', '--resume', openedId)
    expect(refused.code).toBe(1)
    expect(refused.out).toContain('--resume needs --workspace')
  }, 120_000)
})

/**
 * A project with several repos (docs/project-repos.md): a create picks which
 * of them the workspace starts with, where each checkout sits and where its
 * agent runs, and each checkout uses its own repo's credential. One project
 * and its workspaces are shared by the cases; the last one deletes a repo.
 */
describe.skipIf(!CAN_RUN)('a project with several repos', () => {
  const MULTI = 'cl-multi'
  const LIB = 'cl-lib'
  const MULTI_TOKEN = 'ghp_multi_token'
  const LIB_TOKEN = 'ghp_lib_token'
  let multiId: string
  /** The repo the project links beside its own, in the folder `lib`. */
  let libRepo: string
  /** A workspace with both repos, and one with `lib` alone, in its folder. */
  let both: string
  let libOnly: string
  const made: string[] = []
  const wsDir = (id: string, ...rest: string[]): string =>
    path.join(testEnv.dataDir, 'global', 'projects', multiId, 'workspaces', id, ...rest)
  const real = (p: string): Promise<string> => fs.realpath(p)

  interface Listed {
    workspaceId: string
    projectId: string
    cwd: string
    repos: Array<{ repoId: string; path: string; baseBranch?: string; startCommit?: string }>
    sessions: Array<SessionEntry & { cwd: string }>
  }
  const listed = async (id: string): Promise<Listed> => {
    const { workspaces } = await (await fetch(`${origin()}/api/workspace/list`)).json() as { workspaces: Listed[] }
    const found = workspaces.find((w) => w.workspaceId === id)
    if (!found) throw new Error(`workspace ${id} is not listed`)
    return found
  }

  /** `yaac workspace create cl-multi …` with a terminal claude; the new id. */
  async function create(...args: string[]): Promise<string> {
    const res = await runYaac(cliEnv(), 'workspace', 'create', MULTI, '--tool', 'claude', '--mode', 'tui', ...args)
    expect(res.exitCode, `${args.join(' ')}\n${res.stdout}\n${res.stderr}`).toBe(0)
    const id = startedId(res.stdout)
    made.push(id)
    return id
  }

  /** The password the workspace's own git would send for a remote, read as
   *  git itself reads it, from the checkout at `dir`. */
  async function tokenFor(id: string, dir: string, remote: string): Promise<string> {
    const gitConfigGlobal = await workspaceEnvVar(id, 'GIT_CONFIG_GLOBAL')
    const filled = await new Promise<string>((resolve, reject) => {
      const child = execFile('git', ['credential', 'fill'], {
        cwd: dir,
        env: { ...process.env, HOME: userHome(), GIT_CONFIG_GLOBAL: gitConfigGlobal, GIT_TERMINAL_PROMPT: '0' },
      }, (err, stdout) => (err ? reject(err instanceof Error ? err : new Error('git credential fill failed')) : resolve(stdout)))
      child.stdin?.end(`url=${remote}\n\n`)
    })
    return /^password=(.*)$/m.exec(filled)?.[1] ?? ''
  }

  /** `yaac-mama` as workspace `id` runs it from `cwd`; its output and exit code. */
  async function mamaIn(id: string, cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
    const env = await paneEnv(id)
    const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
    const { stdout } = await execFileAsync('sh', ['-c',
      `${path.join(process.cwd(), 'workspace-bin', 'yaac-mama')} ${quoted} 2>&1 </dev/null; echo "EXIT:$?"`,
    ], {
      cwd,
      env: {
        ...process.env,
        YAAC_MAMA_URL: env.YAAC_MAMA_URL,
        YAAC_MAMA_TOKEN: env.YAAC_MAMA_TOKEN,
        YAAC_WORKSPACE_DIR: env.YAAC_WORKSPACE_DIR,
        YAAC_CHECKOUTS: env.YAAC_CHECKOUTS,
        YAAC_SESSION_ID: '',
      },
    })
    const m = /EXIT:(\d+)\s*$/.exec(stdout)
    if (!m) throw new Error(`no exit marker:\n${stdout}`)
    return { code: Number(m[1]), out: stdout.slice(0, m.index) }
  }

  beforeAll(async () => {
    multiId = await addTestProject(server, await createTestRepo(path.join(testEnv.scratchDir, MULTI)), {
      remoteUrl: `https://github.com/test/${MULTI}.git`,
    })
    // A project of its own, whose repo `cl-multi` links too: a staged
    // project's repo carries the project's id.
    libRepo = await addTestProject(server, await createTestRepo(path.join(testEnv.scratchDir, LIB)), {
      remoteUrl: `https://github.com/test/${LIB}.git`,
    })
    await assignTestGitCredential(server, MULTI, MULTI_TOKEN)
    await assignTestGitCredential(server, LIB, LIB_TOKEN)
    // A branch origin "has", planted where a fetch would put it.
    await execFileAsync('git', ['-C', mainClone(libRepo), 'update-ref', 'refs/remotes/origin/dev', 'HEAD'])
    const linked = await runYaac(cliEnv(), 'project', 'repo', 'add', MULTI, '--repo-id', libRepo.slice(0, 8), '--dir', 'lib')
    expect(linked.exitCode, linked.stderr).toBe(0)
  }, 60_000)

  afterAll(async () => {
    for (const id of made) await runYaac(serverEnv, 'workspace', 'stop', id).catch(() => {})
  }, 120_000)

  it('starts with every repo by default, each in its folder with its own credential, the agent at the root', async () => {
    both = await create()
    const { repos, cwd, sessions } = await listed(both)
    expect(repos.map((r) => [r.repoId, r.path])).toEqual([[multiId, MULTI], [libRepo, 'lib']])
    expect(cwd).toBe('')
    expect(sessions.map((s) => s.cwd)).toEqual([''])

    // Each checkout is its own clone on the workspace's branch, borrowing
    // its own repo's main clone; the workspace dir itself is no checkout.
    for (const [dir, repo] of [[MULTI, multiId], ['lib', libRepo]]) {
      expect((await execFileAsync('git', ['-C', wsDir(both, dir), 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim())
        .toBe(`agent/${both}`)
      expect(await fs.readFile(wsDir(both, dir, '.git', 'objects', 'info', 'alternates'), 'utf8'))
        .toBe(`${path.join(mainClone(repo), '.git', 'objects')}\n`)
    }
    expect((await fs.readdir(wsDir(both))).sort()).toEqual([MULTI, 'lib'])

    const env = await paneEnv(both)
    expect(await real(env.PWD)).toBe(await real(wsDir(both)))
    expect(await real(env.YAAC_WORKSPACE_DIR)).toBe(await real(wsDir(both)))
    expect(env.YAAC_CHECKOUTS).toBe(`${MULTI}:lib`)
    // No sandbox, so gh gets a real token: the first repo's, from the root.
    expect(env.GH_TOKEN).toBe(MULTI_TOKEN)
    // git picks each repo's own token by the remote it talks to.
    expect(await tokenFor(both, wsDir(both, MULTI), `https://github.com/test/${MULTI}.git`)).toBe(MULTI_TOKEN)
    expect(await tokenFor(both, wsDir(both, 'lib'), `https://github.com/test/${LIB}.git`)).toBe(LIB_TOKEN)
  }, 180_000)

  it('--repo picks the repos and their starts, --nested the layout and --cwd where the agent runs, and the next create remembers them', async () => {
    libOnly = await create('--repo', 'lib@dev', '--nested', '--cwd', 'lib')
    expect(await listed(libOnly)).toMatchObject({ cwd: 'lib', repos: [{ repoId: libRepo, path: 'lib', baseBranch: 'dev' }] })
    expect(await fs.readdir(wsDir(libOnly))).toEqual(['lib'])
    expect((await execFileAsync('git', ['-C', wsDir(libOnly, 'lib'), 'rev-parse', '--abbrev-ref', '@{u}'])).stdout.trim())
      .toBe('origin/dev')
    const env = await paneEnv(libOnly)
    expect(await real(env.PWD)).toBe(await real(wsDir(libOnly, 'lib')))
    expect(env.GH_TOKEN).toBe(LIB_TOKEN)

    // A create that names nothing takes what the last one chose: the same
    // repo, layout and cwd, at the repo's default branch.
    const again = await create()
    const remembered = await listed(again)
    expect(remembered).toMatchObject({ cwd: 'lib', repos: [{ repoId: libRepo, path: 'lib' }] })
    expect(remembered.repos[0].baseBranch).not.toBe('dev')

    // One repo at the workspace root, at a full commit, the agent in it.
    const sha = (await execFileAsync('git', ['-C', mainClone(multiId), 'rev-parse', 'HEAD'])).stdout.trim()
    const flat = await create('--repo', `${MULTI}@${sha}`, '--no-nested')
    const pinned = await listed(flat)
    expect(pinned).toMatchObject({ cwd: '', repos: [{ repoId: multiId, path: '', startCommit: sha }] })
    expect(pinned.repos[0].baseBranch).toBeUndefined()
    expect((await execFileAsync('git', ['-C', wsDir(flat), 'rev-parse', 'HEAD'])).stdout.trim()).toBe(sha)

    // --branch is the start of a selection of one repo.
    const branched = await create('--repo', 'lib', '--branch', 'dev', '--no-nested')
    expect(await listed(branched)).toMatchObject({ cwd: '', repos: [{ repoId: libRepo, path: '', baseBranch: 'dev' }] })

    const refusals: Array<[string[], RegExp]> = [
      [['--repo', 'nope'], /has no repo "nope"/],
      [['--repo', 'lib', '--repo', MULTI, '--no-nested'], /several repos always sit in folders of their own/],
      [['--repo', 'lib', '--repo', MULTI, '--branch', 'dev'], /names the start of exactly one repo/],
      [['--repo', 'lib', '--cwd', MULTI], /is not "\." or a repo this workspace starts with/],
    ]
    for (const [args, error] of refusals) {
      const { stderr, exitCode } = await runYaac(cliEnv(), 'workspace', 'create', MULTI, '--tool', 'claude', ...args)
      expect(exitCode, args.join(' ')).not.toBe(0)
      expect(stderr, args.join(' ')).toMatch(error)
    }
    for (const id of [again, flat, branched]) expect((await runYaac(serverEnv, 'workspace', 'stop', id)).exitCode).toBe(0)
  }, 300_000)

  it('--no-repos starts an empty workspace, and a session opened with --cwd runs in one of a workspace\'s checkouts', async () => {
    const empty = await create('--no-repos')
    expect(await listed(empty)).toMatchObject({ cwd: '', repos: [] })
    expect(await fs.readdir(wsDir(empty))).toEqual([])
    const env = await paneEnv(empty)
    expect(env.YAAC_CHECKOUTS).toBe('')
    // No repo's token: whatever GH_TOKEN the user's own shell sets stands.
    expect([MULTI_TOKEN, LIB_TOKEN]).not.toContain(env.GH_TOKEN)
    expect((await runYaac(serverEnv, 'workspace', 'stop', empty)).exitCode).toBe(0)

    // A second session of the two-repo workspace, in `lib`: it runs there
    // with that repo's token as its GH_TOKEN, beside the first at the root.
    const opened = await runYaac(cliEnv(), 'workspace', 'create', '--workspace', both, '--tool', 'claude', '--mode', 'tui', '--cwd', 'lib')
    expect(opened.exitCode, opened.stderr).toBe(0)
    const session = await vi.waitFor(async () => {
      const found = (await listed(both)).sessions.find((s) => s.cwd === 'lib')
      expect(found).toBeDefined()
      return found!
    }, { timeout: 30_000, interval: 250 })
    const sessionEnv = await vi.waitFor(async () => {
      const pid = (await tmux(both, 'display-message', '-p', '-t', `yaac:${session.window}`, '#{pane_pid}')).trim()
      const dumped = await processEnv(pid)
      expect(Object.keys(dumped)).not.toHaveLength(0)
      return dumped
    }, { timeout: 30_000, interval: 250 })
    expect(await real(sessionEnv.PWD)).toBe(await real(wsDir(both, 'lib')))
    expect(sessionEnv.GH_TOKEN).toBe(LIB_TOKEN)

    const elsewhere = await runYaac(cliEnv(), 'workspace', 'create', '--workspace', both, '--tool', 'claude', '--cwd', 'nope')
    expect(elsewhere.exitCode).not.toBe(0)
  }, 180_000)

  it('yaac-mama acts on the checkout it is run in: set-base, fetch and as-repo, and starts workspaces with --repo', async () => {
    // set-base moves the base of the checkout it runs in, and no other.
    await execFileAsync('git', ['-C', mainClone(libRepo), 'update-ref', 'refs/remotes/origin/pr/stacked', 'HEAD'])
    const main = (await listed(both)).repos.find((r) => r.path === MULTI)?.baseBranch
    const set = await mamaIn(both, wsDir(both, 'lib'), 'set-base', 'pr/stacked')
    expect(set.code, set.out).toBe(0)
    expect((await listed(both)).repos.map((r) => [r.path, r.baseBranch])).toEqual([[MULTI, main], ['lib', 'pr/stacked']])
    const changes = await (await fetch(`${origin()}/api/workspace/${both}/changes?diff=0&repo=lib`)).json() as WorkspaceChanges
    expect(changes.branch).toBe('pr/stacked')
    // Outside every checkout there is no telling which is meant, unless named.
    expect((await mamaIn(both, wsDir(both), 'set-base', 'dev')).code).toBe(1)
    const named = await mamaIn(both, wsDir(both), 'set-base', '--repo', 'lib', 'dev')
    expect(named.code, named.out).toBe(0)
    expect((await listed(both)).repos.find((r) => r.path === 'lib')?.baseBranch).toBe('dev')

    // fetch reads the other workspace's checkout of the same repo.
    await execFileAsync('git', ['-C', wsDir(libOnly, 'lib'), '-c', 'user.name=T', '-c', 'user.email=t@t',
      'commit', '-q', '--allow-empty', '-m', 'from lib-only'])
    const tip = (await execFileAsync('git', ['-C', wsDir(libOnly, 'lib'), 'rev-parse', 'HEAD'])).stdout.trim()
    const fetched = await mamaIn(both, wsDir(both, 'lib'), 'fetch', libOnly)
    expect(fetched.code, fetched.out).toBe(0)
    expect((await execFileAsync('git', ['-C', wsDir(both, 'lib'), 'rev-parse', `yaac/peers/${libOnly.slice(0, 8)}/HEAD`])).stdout.trim())
      .toBe(tip)
    const none = await mamaIn(both, wsDir(both, MULTI), 'fetch', libOnly)
    expect(none.code).toBe(1)
    expect(none.out).toContain('has no checkout of this repo')

    // as-repo runs one command with another repo's token as GH_TOKEN.
    const asLib = await mamaIn(both, wsDir(both), 'as-repo', 'lib', '--', 'sh', '-c', 'printf %s "$GH_TOKEN"')
    expect(asLib).toEqual({ code: 0, out: LIB_TOKEN })
    const unknown = await mamaIn(both, wsDir(both), 'as-repo', 'nope', '--', 'true')
    expect(unknown.code).toBe(1)
    expect(unknown.out).toContain('has no repo "nope"')
    expect((await mamaIn(both, wsDir(both), 'as-repo', 'lib')).code).toBe(2)

    // create and queue take the selection the CLI does.
    const spawned = await mamaIn(both, wsDir(both), 'create', '--repo', `${MULTI}`, '--repo', 'lib@dev', '--cwd', MULTI, 'hello')
    expect(spawned.code, spawned.out).toBe(0)
    const sibling = spawned.out.trim().split('\n')[0]
    made.push(sibling)
    await vi.waitFor(async () => {
      expect(await listed(sibling)).toMatchObject({
        cwd: MULTI, repos: [{ repoId: multiId, path: MULTI }, { repoId: libRepo, path: 'lib', baseBranch: 'dev' }],
      })
    }, { timeout: 120_000, interval: 1000 })
    const queued = await mamaIn(both, wsDir(both), 'queue', '--parent-workspace', both, '--repo', 'lib', '--no-nested', 'after')
    expect(queued.code, queued.out).toBe(0)
    const queuedId = queued.out.trim().split('\n')[0]
    const entries = await (await fetch(`${origin()}/api/workspace/queue/list`)).json() as Array<{
      id: string; selection: { repos: Array<{ repo: string }>; nested: boolean }
    }>
    expect(entries.find((e) => e.id === queuedId)?.selection).toMatchObject({ repos: [{ repo: libRepo }], nested: false })
    expect((await mamaIn(both, wsDir(both), 'delete-queued', queuedId)).code).toBe(0)
    expect((await mamaIn(both, wsDir(both), 'create', '--no-repos', '--repo', 'lib', 'x')).code).not.toBe(0)
    expect((await runYaac(serverEnv, 'workspace', 'stop', sibling)).exitCode).toBe(0)
  }, 300_000)

  // Last: it deletes the repo the cases above use.
  it('repo delete unlinks a repo everywhere but keeps its clone while workspaces hold checkouts', async () => {
    const holders = (await (await fetch(`${origin()}/api/repo/${libRepo}/delete-preview`)).json() as {
      heldBy: Array<{ workspaceId: string }>
    }).heldBy.map((h) => h.workspaceId)
    expect(holders).toEqual(expect.arrayContaining([both, libOnly]))

    const deleted = await runYaac(cliEnv(), 'repo', 'delete', `${MULTI}/lib`, '--yes')
    expect(deleted.exitCode, deleted.stderr).toBe(0)
    expect(deleted.stdout).toContain(`Deleted https://github.com/test/${LIB}.git. These workspaces still hold a checkout of it`)
    for (const id of holders) expect(deleted.stdout).toContain(`${id}  in `)
    expect(deleted.stdout).toContain('Delete them (`yaac workspace delete <id>`)')

    // Unlinked from both projects that linked it; the running workspace
    // keeps its checkout, and the main clone its objects borrow from.
    expect((await runYaac(cliEnv(), 'project', 'repo', 'list', MULTI)).stdout).not.toContain('lib ')
    expect((await runYaac(cliEnv(), 'project', 'repo', 'list', LIB)).stdout).toContain('links no repos')
    expect((await runYaac(cliEnv(), 'repo', 'list')).stdout)
      .toMatch(new RegExp(`${libRepo.slice(0, 8)}.*deleted; held by ${String(holders.length)} workspace\\(s\\)`))
    await expect(fs.access(path.join(mainClone(libRepo), '.git'))).resolves.toBeUndefined()
    expect((await execFileAsync('git', ['-C', wsDir(both, 'lib'), 'log', '--format=%s', '-1'])).stdout.trim()).not.toBe('')
    // It can no longer be started with.
    const gone = await runYaac(cliEnv(), 'workspace', 'create', MULTI, '--tool', 'claude', '--repo', 'lib')
    expect(gone.exitCode).not.toBe(0)

    // With the last workspace holding it deleted, nothing holds it; the
    // `deleted-repos` reconcile step then removes its clone and row, on a
    // timer too long to wait out here (unit tests cover it).
    for (const id of holders) {
      await runYaac(serverEnv, 'workspace', 'stop', id)
      await vi.waitFor(async () => {
        expect((await runYaac(serverEnv, 'workspace', 'delete', id, '--yes')).exitCode).toBe(0)
      }, { timeout: 60_000, interval: 2000 })
    }
    expect((await (await fetch(`${origin()}/api/repo/list`)).json() as Array<{ id: string; deleted?: { heldBy: unknown[] } }>)
      .find((r) => r.id === libRepo)?.deleted?.heldBy ?? []).toEqual([])
  }, 480_000)
})

/**
 * Queued workspaces (docs/queued-workspaces.md): a queued workspace starts
 * when its parent is stopped, and stays queued if the parent dies instead.
 */
describe.skipIf(!CAN_RUN)('queued workspaces', () => {
  /** Wait out what is left of the starting grace of a workspace created
   *  at `created`, after which a death is the stale reaper's to take. */
  async function outlastGrace(created: number): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.max(0, created + STARTING_GRACE_MS - Date.now())))
  }

  /** `yaac-mama` as the workspace `id` runs it, with its own credentials. */
  async function mamaAs(id: string, ...args: string[]): Promise<string> {
    return await mamaFrom(id, '/dev/null', ...args)
  }

  /** `mamaAs` with the file `stdin` as its standard input. */
  async function mamaFrom(id: string, stdin: string, ...args: string[]): Promise<string> {
    const env = await paneEnv(id)
    const quoted = [...args, '<', stdin].map((a, i) => (i === args.length ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ')
    const { stdout } = await execFileAsync('sh', ['-c',
      `YAAC_MAMA_URL='${env.YAAC_MAMA_URL}' YAAC_MAMA_TOKEN='${env.YAAC_MAMA_TOKEN}' `
      + `${path.join(process.cwd(), 'workspace-bin', 'yaac-mama')} ${quoted}`,
    ])
    return stdout.trim()
  }

  it('starts the top of a chain when its parent is stopped, with its prompt delivered', async () => {
    const watch = collectSnapshots(server.lock.port)
    await watch.opened
    const latest = (): ServerSnapshot => {
      const snap = watch.latest()
      if (!snap) throw new Error('no snapshot yet')
      return snap
    }
    let childWorkspace: string | undefined
    try {
      // An explicit posture, since earlier cases change the remembered one
      // and it is the ceiling checked below.
      const parent = await createWorkspace('--permission-mode', 'accept-edits')
      await expect(mamaAs(parent, 'queue', '--parent-workspace', parent, '--tool', 'codex', '--permission-mode', 'bypass', 'x'))
        .rejects.toThrow(/more permissive than the caller's ceiling \('accept-edits'\)/)
      // The parent is implied by nothing: with no group to wait in, it is
      // refused.
      await expect(mamaAs(parent, 'queue', 'x')).rejects.toThrow(/needs a group with a workspace limit/)
      // The fake codex reports a conversation only once it gets a prompt,
      // and logs its launch arguments. All of these come from the edit.
      const child = await mamaAs(parent, 'queue', '--parent-workspace', parent, 'draft')

      // A prompt of the maximum size travels by file or stdin, whole and
      // multibyte (16 bytes a repeat, which divides the cap), and reads back
      // in full.
      const long = 'é✓🙂"fi"\\n\n'.repeat(MAX_PROMPT_BYTES / 16)
      const brief = path.join(testEnv.dataDir, 'brief.md')
      await fs.writeFile(brief, long)
      const fullPrompt = async (id: string): Promise<string> =>
        ((await (await fetch(`${origin()}/api/workspace/prompt?id=${id}`)).json()) as { prompt: string }).prompt
      const big = await mamaAs(parent, 'queue', '--parent-workspace', parent, '--prompt-file', brief)
      expect(await fullPrompt(big) === long).toBe(true)
      // A NUL, which no argument can carry, is dropped like any other
      // control character.
      await fs.writeFile(brief, `${long.slice(1)}\0!`)
      await mamaFrom(parent, brief, 'edit-queued', big.slice(0, 8), '-')
      expect(await fullPrompt(big) === `${long.slice(1)}!`).toBe(true)
      await expect(mamaAs(parent, 'queue', '--parent-workspace', parent, '--prompt-file', brief, 'x'))
        .rejects.toThrow(/not both/)
      await fs.writeFile(brief, `${long}!`)
      await expect(mamaFrom(parent, brief, 'queue', '--parent-workspace', parent, '-'))
        .rejects.toThrow(/yaac-mama: the prompt is over the 130 KB limit \(HTTP 422\)/)
      await fs.writeFile(brief, '')
      await expect(mamaAs(parent, 'queue', '--parent-workspace', parent, '--prompt-file', brief))
        .rejects.toThrow(/the prompt from .* is empty/)
      await expect(mamaAs(parent, 'queue', '--parent-workspace', parent, '-')).rejects.toThrow(/the prompt from stdin is empty/)
      // Off the queue again, so the parent's stop below launches only `child`.
      expect((await fetch(`${origin()}/api/workspace/queue/discard`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: big }),
      })).ok).toBe(true)
      await expect(mamaAs(parent, 'edit-queued', child.slice(0, 8), ''))
        .rejects.toThrow(/usage: yaac-mama edit-queued/)
      expect(await mamaAs(
        parent, 'edit-queued', '--tool', 'codex', '--model', 'gpt-5.5', '--effort', 'high',
        '--permission-mode', 'read-only', '--title', 'Say hello', child.slice(0, 8), 'hello',
      )).toContain(`Updated queued workspace ${child.slice(0, 8)}: codex gpt-5.5, read-only — hello`)
      // Moved from the parent to the child; if the move were lost, the
      // parent's stop would launch it too.
      // A level the model lacks is refused at queue time, not at launch.
      await expect(mamaAs(parent, 'queue', '--parent-workspace', parent, '--model', 'claude-opus-4-6', '--effort', 'xhigh', 'x'))
        .rejects.toThrow(/no "xhigh" effort/)
      const grandchild = await mamaAs(parent, 'queue', '--parent-workspace', parent, '--effort', 'low', 'after that')
      expect(await mamaAs(
        parent, 'edit-queued', '--parent-workspace', child.slice(0, 8), '--ui-mode', 'acp',
        '--branch', 'release/next', '--group', 'e2e follow-ups', grandchild.slice(0, 8),
      )).toContain('after that')
      expect(child).toMatch(/^[0-9a-f-]{36}$/)
      expect(await mamaAs(parent, 'list')).toContain('after that')

      const { exitCode } = await runYaac(serverEnv, 'workspace', 'stop', parent)
      expect(exitCode).toBe(0)

      await vi.waitFor(() => {
        childWorkspace = latest().workspaces.find((w) => w.prompt === 'hello')?.workspaceId
        expect(childWorkspace).toBeDefined()
      }, { timeout: 60_000, interval: 250 })
      await vi.waitFor(() => {
        expect(latest().workspaces.find((w) => w.workspaceId === childWorkspace)?.title).toBe('Say hello')
      }, { timeout: 60_000, interval: 250 })
      await vi.waitFor(() => {
        const sessions = latest().workspaces.find((w) => w.workspaceId === childWorkspace)?.conversations ?? []
        expect(sessions.some((a) => /^thread-\d+$/.test(a.conversationId))).toBe(true)
      }, { timeout: 30_000, interval: 250 })
      const launches = await fs.readFile(
        path.join(testEnv.dataDir, 'global', 'projects', projectId, 'codex', `launches-${childWorkspace}`), 'utf8',
      )
      expect(launches).toContain('--sandbox read-only')
      expect(launches).toContain('--model gpt-5.5')
      expect(launches).toContain('model_reasoning_effort=high')

      // A running sibling messages the child's agent, which receives it as a
      // submitted line of input.
      const sender = await createWorkspace('--permission-mode', 'accept-edits')
      try {
        const child = childWorkspace!
        const sent = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'codex', `sent-${child}`)
        // Near the prompt cap, multibyte, from a file; each of its lines
        // reaches the agent as typed. The fake codex echoes a paste
        // line by line, reprinting its prompt after each, where the real
        // tools collapse it. So the message is a few long lines, which the
        // fake keeps up with, ending in one holding the 20 characters a send
        // looks for on screen; and it goes first, before an earlier header
        // on screen could scroll off and hide that it showed.
        const message = [
          ...Array.from({ length: 38 }, (_, i) => `${'Pläase ✓ the 🙂 brief '.repeat(125)}line ${String(i)}`),
          'that-is-the-whole-brief-✓',
        ].join('\n')
        expect(Buffer.byteLength(message)).toBeGreaterThan(125 * 1024)
        expect(promptFits(message)).toBe(true)
        const messageFile = path.join(testEnv.dataDir, 'message.md')
        await fs.writeFile(messageFile, message)
        expect(await mamaAs(sender, 'send', '--prompt-file', messageFile, child.slice(0, 8)))
          .toMatch(new RegExp(`^Sent to ${child.slice(0, 8)}'s codex agent [0-9a-f]{8}\\.`))
        await vi.waitFor(async () => {
          expect((await fs.readFile(sent, 'utf8').catch(() => '')).includes(`\n${message}\n`)).toBe(true)
        }, { timeout: 30_000, interval: 500 })

        expect(await mamaAs(sender, 'send', child.slice(0, 8), 'a message from a peer'))
          .toMatch(new RegExp(`^Sent to ${child.slice(0, 8)}'s codex agent [0-9a-f]{8}\\.`))
        await vi.waitFor(async () => {
          expect(await fs.readFile(sent, 'utf8').catch(() => ''))
            .toContain(`Sent from ${sender} via yaac-mama:\n\na message from a peer\n`)
        }, { timeout: 30_000, interval: 500 })

        // A person messages it too (`yaac workspace send`), naming its
        // agent or its conversation, the message given or read from a file,
        // each ending in the 20 characters a send looks for.
        const { workspaces } = await (await fetch(`${origin()}/api/workspace/list`)).json() as {
          workspaces: Array<{ workspaceId: string; sessions: SessionEntry[] }>
        }
        const target = workspaces.find((w) => w.workspaceId === child)?.sessions[0]
        expect(target?.conversationId).toBeDefined()
        const byAgent = await runYaac(serverEnv, 'workspace', 'send', child.slice(0, 8), '--agent', target!.sessionId.slice(0, 8), '--prompt', 'a message from a person')
        expect(byAgent.stdout, byAgent.stderr).toMatch(new RegExp(`^Sent to ${child.slice(0, 8)}'s codex agent ${target!.sessionId.slice(0, 8)};`))
        await vi.waitFor(async () => {
          expect(await fs.readFile(sent, 'utf8').catch(() => '')).toContain('Sent by local via yaac workspace send:\n\na message from a person\n')
        }, { timeout: 30_000, interval: 500 })
        const note = path.join(testEnv.dataDir, 'note.md')
        await fs.writeFile(note, 'a note read from a file')
        const byConversation = await runYaac(serverEnv, 'workspace', 'send', child, '--conversation', target!.conversationId!, '--prompt-file', note)
        expect(byConversation.exitCode, byConversation.stderr).toBe(0)
        await vi.waitFor(async () => {
          expect(await fs.readFile(sent, 'utf8').catch(() => '')).toContain('Sent by local via yaac workspace send:\n\na note read from a file\n')
        }, { timeout: 30_000, interval: 500 })
      } finally {
        await runYaac(serverEnv, 'workspace', 'stop', sender)
      }

      // The grandchild waits for the child's own stop.
      const entry = latest().queuedWorkspaces.find((q) => q.id === grandchild)
      const group = latest().workspaceGroups.find((g) => g.projectId === projectId && g.name === 'e2e follow-ups')
      expect(entry).toMatchObject({
        parentWorkspaceId: childWorkspace, prompt: 'after that', mode: 'acp',
        selection: { repos: [{ repo: projectId, branch: 'release/next' }] },
        groupId: group?.groupId,
      })
      expect(group).toBeDefined()
      await expect(mamaAs(childWorkspace!, 'delete-queued')).rejects.toThrow(/usage: yaac-mama delete-queued/)
      expect(await mamaAs(childWorkspace!, 'delete-queued', grandchild.slice(0, 8)))
        .toBe(`Discarded queued workspace ${grandchild.slice(0, 8)}.`)
      await vi.waitFor(() => {
        expect(latest().queuedWorkspaces.some((q) => q.id === grandchild)).toBe(false)
      }, { timeout: 10_000, interval: 250 })
    } finally {
      watch.ws.close()
      if (childWorkspace !== undefined) await runYaac(serverEnv, 'workspace', 'stop', childWorkspace)
    }
  }, 240_000)

  // docs/workspace-groups.md: a death frees a slot like a stop does.
  it('starts a workspace waiting for room in a limited group once a member dies', async () => {
    const watch = collectSnapshots(server.lock.port)
    await watch.opened
    const latest = (): ServerSnapshot => {
      const snap = watch.latest()
      if (!snap) throw new Error('no snapshot yet')
      return snap
    }
    let pooled: string | undefined
    try {
      const member = await createWorkspace('--permission-mode', 'accept-edits')
      const created = Date.now()
      await mamaAs(member, 'group', 'move', member, 'Pool')
      expect(await mamaAs(member, 'group', 'set-limit', 'Pool', '1'))
        .toBe('Group "Pool" now runs at most 1 workspace at once.')
      const { groups } = await (await fetch(`${origin()}/api/workspace/group/list?project=${NAME}`)).json() as {
        groups: Array<{ groupId: string; name: string; workspaceLimit?: number }>
      }
      const groupId = groups.find((g) => g.name === 'Pool' && g.workspaceLimit === 1)!.groupId
      await expect(createWorkspace('--group', 'Pool')).rejects.toThrow(/"Pool" is at its workspace limit of 1 \(running or starting\)/)

      const id = await mamaAs(member, 'queue', '--group', 'Pool', '--ui-mode', 'tui', 'pooled hello')
      await vi.waitFor(() => {
        expect(latest().queuedWorkspaces.find((q) => q.id === id)).toMatchObject({ groupId, waitingForRoom: true })
      }, { timeout: 10_000, interval: 250 })
      await expect(mamaAs(member, 'run-queued', id.slice(0, 8))).rejects.toThrow(/"Pool" is at its workspace limit of 1/)
      // A follow-up queued after the member, then set to wait for room too.
      const follow = await mamaAs(member, 'queue', '--parent-workspace', member, '--ui-mode', 'tui', 'pooled later')
      expect(await mamaAs(member, 'edit-queued', '--no-parent', follow.slice(0, 8)))
        .toContain(`Updated queued workspace ${follow.slice(0, 8)}`)
      await vi.waitFor(() => {
        const entry = latest().queuedWorkspaces.find((q) => q.id === follow)
        expect(entry).toMatchObject({ groupId, waitingForRoom: true })
        expect(entry?.parentWorkspaceId).toBeUndefined()
      }, { timeout: 10_000, interval: 250 })
      expect(await mamaAs(member, 'list')).toMatch(new RegExp(`waiting for room in "Pool":\\n.*${id.slice(0, 8)}[^\\n]*\\n.*${follow.slice(0, 8)}`))

      await outlastGrace(created)
      await tmux(member, 'kill-server').catch(() => undefined)
      await vi.waitFor(() => {
        pooled = latest().workspaces.find((w) => w.prompt === 'pooled hello')?.workspaceId
        expect(pooled).toBeDefined()
      }, { timeout: 60_000, interval: 250 })
      expect(latest().workspaces.find((w) => w.workspaceId === pooled)?.groupId).toBe(groupId)
      // The limit is one, so the newer entry still waits behind it.
      expect(latest().queuedWorkspaces.find((q) => q.id === follow)).toMatchObject({ waitingForRoom: true })
      await fetch(`${origin()}/api/workspace/queue/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: follow }),
      })
    } finally {
      watch.ws.close()
      if (pooled !== undefined) await runYaac(serverEnv, 'workspace', 'stop', pooled)
    }
  }, 180_000)

  it('keeps a dead parent\'s child queued and the parent held, until the child is discarded', async () => {
    const watch = collectSnapshots(server.lock.port)
    await watch.opened
    const latest = (): ServerSnapshot => {
      const snap = watch.latest()
      if (!snap) throw new Error('no snapshot yet')
      return snap
    }
    try {
      const parent = await createWorkspace()
      const created = Date.now()
      const res = await fetch(`${origin()}/api/workspace/queue/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: NAME, parent, prompt: 'never on a crash' }),
      })
      expect(res.status).toBe(200)
      const { id } = await res.json() as { id: string }

      // Killing tmux directly is a death, not a stop. Past the starting
      // grace, the reaper takes it on the pass the dropped stream triggers.
      // The wait also outlasts create's ~1s launch probe, which would report
      // an earlier death as a failed launch whose provisioning row hides the
      // held one.
      await outlastGrace(created)
      await tmux(parent, 'kill-server').catch(() => undefined)
      await vi.waitFor(() => {
        expect(latest().heldWorkspaces.map((h) => h.workspaceId)).toContain(parent)
      }, { timeout: 20_000, interval: 250 })
      expect(latest().heldWorkspaces.find((h) => h.workspaceId === parent)?.deathReason).toBe('agent-exited')
      expect(latest().queuedWorkspaces.map((q) => q.id)).toContain(id)
      expect(latest().workspaces.find((w) => w.prompt === 'never on a crash')).toBeUndefined()

      const discarded = await fetch(`${origin()}/api/workspace/queue/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      expect(discarded.status).toBe(204)
      await vi.waitFor(() => {
        expect(latest().heldWorkspaces.map((h) => h.workspaceId)).not.toContain(parent)
      }, { timeout: 10_000, interval: 250 })
    } finally {
      watch.ws.close()
    }
  }, 60_000)
})
