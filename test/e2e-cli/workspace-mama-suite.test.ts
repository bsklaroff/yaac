import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { git } from '@yaac/test-utils/git'
import { cloneRepo } from '@yaac/server/domain/git'
import { listWorkspacePods, type PodInfo } from '@yaac/server/drivers/k8s/substrate/pods'
import { SERVER_MAMA_PORT, SERVER_MAMA_SERVICE_NAME } from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import { k8sNamespace } from '@yaac/server/drivers/k8s/substrate/api'
import {
  createYaacTestEnv,
  spawnYaacServer,
  setTestGitIdentity,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { assignTestGitCredential, registerTestProject } from '@yaac/test-utils/api'
import {
  requirePodman,
  requireCluster,
  execInJob,
  cleanupWorkspaceJobs,
} from '@yaac/test-utils/setup'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '@yaac/test-utils/mock-remotes'
import { collectSnapshots } from '@yaac/test-utils/events-ws'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The in-workspace command channel: a workspace pod runs `yaac-mama`, whose
 * request travels over HTTP egress to the proxy's magic host, which relays
 * it to the server. The server runs it against the caller's project: creating a sibling
 * with a prompt, listing workspaces, managing groups, and stopping.
 */
describe('yaac-mama from inside a workspace (real CLI + server + cluster)', () => {
  const SLUG = 'spawner'
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let serverEnv: NodeJS.ProcessEnv
  let jobA = ''
  /** The caller's own workspace id, checked by the self-stop case. */
  let callerWorkspaceId = ''
  /** The sibling the spawn case creates, reused by the stop case. */
  let spawnedWorkspaceId = ''

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()

    testEnv = await createYaacTestEnv()
    const credsDir = path.join(testEnv.dataDir, 'server-local', '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(credsDir, 'claude.json'), JSON.stringify({
      kind: 'api-key',
      savedAt: new Date().toISOString(),
      apiKey: 'sk-ant-fake-real-key',
    }) + '\n')

    mockLLM = await startMockLLM()
    mockGit = await startMockGit()
    const llmTarget = { host: mockLLM.host, port: mockLLM.port, tls: false }
    const gitTarget = { host: mockGit.host, port: mockGit.port, tls: false }
    serverEnv = {
      ...testEnv.env,
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify({
        'github.com': gitTarget,
        'api.github.com': gitTarget,
        'api.anthropic.com': llmTarget,
        'statsig.anthropic.com': llmTarget,
        'api.statsig.com': llmTarget,
        'platform.claude.com': llmTarget,
        'docs.claude.com': llmTarget,
        'code.claude.com': llmTarget,
        'claude.com': llmTarget,
        'claude.ai': llmTarget,
        'mcp-proxy.anthropic.com': llmTarget,
      }),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
    }
    server = await spawnYaacServer(serverEnv)
    await setTestGitIdentity(serverEnv)

    // Stage the project as `yaac project add` would: a local bare repo with
    // a github-shaped remote.
    await seedMockGitRepo(mockGit, SLUG, { files: { 'README.md': '# demo\n' } })
    const projectPath = path.join(testEnv.dataDir, 'global', 'projects', SLUG)
    const repoPath = path.join(projectPath, 'repo')
    await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit.reposDir, `${SLUG}.git`), repoPath, null)
    const fakeRemote = `https://github.com/test-org/${SLUG}.git`
    await git(repoPath, ['remote', 'set-url', 'origin', fakeRemote])
    await registerTestProject(server, SLUG, fakeRemote)
    await assignTestGitCredential(server, SLUG, 'fake-ghp-token')

    const { stdout, stderr, exitCode } = await runYaac(serverEnv, 'workspace', 'create', SLUG)
    if (exitCode !== 0) {
      throw new Error(`workspace create failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    const pods = await listWorkspacePods(SLUG)
    if (pods.length !== 1) throw new Error(`expected 1 workspace pod, found ${pods.length}`)
    jobA = pods[0].jobName
    callerWorkspaceId = pods[0].workspaceId
  }, 300_000)

  afterAll(async () => {
    if (server) await server.stop()
    server = null
    await cleanupWorkspaceJobs()
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  /**
   * Run yaac-mama in workspace A and return its exit code and output
   * (execInJob would throw and retry on a non-zero exit).
   */
  async function runMama(args: string): Promise<{ exitCode: number; output: string }> {
    const { stdout } = await execInJob(jobA, [
      'sh', '-c', `yaac-mama ${args} 2>&1; echo "EXIT:$?"`,
    ], { timeout: 120_000 })
    const m = /\nEXIT:(\d+)\s*$/.exec(stdout) ?? /^EXIT:(\d+)\s*$/.exec(stdout)
    if (!m) throw new Error(`no exit marker in output:\n${stdout}`)
    return { exitCode: Number(m[1]), output: stdout.slice(0, m.index) }
  }

  it('is installed on PATH as a read-only file', async () => {
    const { stdout } = await execInJob(jobA, ['sh', '-c', 'command -v yaac-mama'])
    expect(stdout.trim()).toBe('/usr/local/bin/yaac-mama')
    const { stdout: watchPrs } = await execInJob(jobA, ['sh', '-c', 'command -v yaac-watch-prs'])
    expect(watchPrs.trim()).toBe('/usr/local/bin/yaac-watch-prs')
    const { output, exitCode } = await runMama('')
    expect(exitCode).toBe(2)
    expect(output).toContain('Usage:')
    // The script is mounted read-only.
    const { stdout: rw } = await execInJob(jobA, [
      'sh', '-c', 'sh -c ">> /usr/local/bin/yaac-mama" 2>&1; echo "EXIT:$?"',
    ])
    expect(rw).not.toContain('EXIT:0')
  })

  it('refuses a command outside the allowlist, whatever the caller sends', async () => {
    const viaScript = await runMama('delete 1234')
    expect(viaScript.exitCode).toBe(2)
    expect(viaScript.output).toContain('unknown command')

    // The server enforces the same allowlist for a caller that bypasses the
    // script, since the proxy forwards any command.
    const { stdout } = await execInJob(jobA, ['sh', '-c',
      `curl -sS -X POST -H 'Content-Type: application/json' \
        --data-binary '{"command":"delete","args":{},"body":"x"}' \
        -w '\nHTTP:%{http_code}' http://yaac.internal/api/workspace/mama 2>&1`,
    ], { timeout: 120_000 })
    expect(stdout).toContain('unknown command')
    expect(stdout).toContain('HTTP:422')
  }, 120_000)

  it('spawns a sibling workspace with the prompt and every create option delivered to its agent', async () => {
    // A spawned workspace must show in the snapshot stream like a user
    // create: a provisioning row, then the ready workspace. All create
    // options go on this one spawn, since a sibling is the most expensive
    // thing in the file. `plan` is within the caller's own posture (bypass).
    const sub = collectSnapshots(server!.lock.port)
    await sub.opened

    const PROMPT = 'hello from spawn e2e'
    const { exitCode, output } = await runMama(
      'create --model claude-opus-4-8 --permission-mode plan --ui-mode tui --branch main '
      + `--group "release train" --title "Spawned by e2e" "${PROMPT}"`)
    expect(exitCode).toBe(0)
    const newWorkspaceId = output.trim()
    expect(newWorkspaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    spawnedWorkspaceId = newWorkspaceId

    let sawRow = false
    for (let i = 0; i < 150 && !sawRow; i++) {
      const row = sub.latest()?.provisioning.find((p) => p.workspaceId === newWorkspaceId)
      if (row) {
        expect(row.kind).toBe('create')
        expect(row.projectSlug).toBe(SLUG)
        sawRow = true
      } else await sleep(200)
    }
    expect(sawRow).toBe(true)

    let spawned: PodInfo | undefined
    for (let i = 0; i < 120 && !spawned?.running; i++) {
      const pods = await listWorkspacePods(SLUG)
      spawned = pods.find((p) => p.workspaceId === newWorkspaceId)
      if (!spawned?.running) await sleep(1000)
    }
    expect(spawned?.running).toBe(true)
    expect(spawned?.projectSlug).toBe(SLUG)
    // No --tool, so it inherits the caller's (claude).
    expect(spawned?.tool).toBe('claude')

    // The row is replaced by the workspace, never both at once
    // (buildSnapshot hides the workspace while its row exists).
    let handedOff = false
    for (let i = 0; i < 180 && !handedOff; i++) {
      const snap = sub.latest()
      handedOff = snap !== null
        && snap.workspaces.some((s) => s.workspaceId === newWorkspaceId)
        && !snap.provisioning.some((p) => p.workspaceId === newWorkspaceId)
      if (!handedOff) await sleep(1000)
    }
    expect(handedOff).toBe(true)
    expect(sub.latest()?.workspaces.find((s) => s.workspaceId === newWorkspaceId)?.title).toBe('Spawned by e2e')
    sub.ws.close()

    // The prompt is pasted into the agent's pane; poll while claude boots.
    let pane = ''
    let found = false
    for (let i = 0; i < 60; i++) {
      try {
        const { stdout } = await execInJob(spawned!.jobName, [
          'sh', '-c',
          `tmux -S ${CONTAINER_TMUX_SOCK} capture-pane -t yaac:claude -p -S - -E - 2>&1`,
        ], { timeout: 10_000 })
        pane = stdout
        if (pane.includes(PROMPT)) { found = true; break }
      } catch {
        // pod/tmux not ready yet
      }
      await sleep(1000)
    }
    if (!found) console.error('final spawned pane:\n' + pane)
    expect(found).toBe(true)

    // Check the flags claude was launched with, not what its TUI shows.
    let startCmd = ''
    for (let i = 0; i < 60; i++) {
      try {
        const { stdout } = await execInJob(spawned!.jobName, [
          'sh', '-c',
          `tmux -S ${CONTAINER_TMUX_SOCK} display -p -t yaac:claude "#{pane_start_command}" 2>&1`,
        ], { timeout: 10_000 })
        startCmd = stdout
        if (startCmd.includes('--model')) break
      } catch {
        // pod/tmux not ready yet
      }
      await sleep(1000)
    }
    expect(startCmd).toContain('claude --permission-mode plan --model claude-opus-4-8')
  }, 420_000)

  it('lists the project\u2019s workspaces, marking the caller and its group', async () => {
    // Relies on the spawn above: both workspaces up, the sibling in its group.
    const { exitCode, output } = await runMama('list')
    expect(exitCode).toBe(0)
    expect(output).toMatch(/WORKSPACE\s+TOOL\s+STATUS\s+GROUP\s+TITLE\s+PROMPT/)
    // The caller's own row is marked so an agent can find itself.
    expect(output).toContain('(you)')
    expect(output).toContain('release train')
    expect(output).toContain('Groups: release train')
  }, 120_000)

  it('makes a group and files a workspace into it, by name and short id', async () => {
    const made = await runMama('group create "review queue"')
    expect(made.exitCode).toBe(0)
    expect(made.output).toContain('review queue')

    // Idempotent, so an agent need not check first.
    const again = await runMama('group create "review queue"')
    expect(again.exitCode).toBe(0)

    // Move the caller, by the 8-char prefix `list` prints.
    const listed = await runMama('list')
    const selfShortId = /^([0-9a-f]{8}) \(you\)/m.exec(listed.output)?.[1]
    expect(selfShortId).toBeTruthy()

    const moved = await runMama(`group move ${selfShortId!} "review queue"`)
    expect(moved.exitCode).toBe(0)
    expect(moved.output).toContain('review queue')

    const after = await runMama('list')
    expect(after.output).toMatch(new RegExp(`${selfShortId!}[^\\n]*review queue`))

    // By group id (what the ambiguity error suggests), the output still
    // names the group.
    const groupId = /\(([0-9a-f-]{36})\)/.exec(made.output)?.[1]
    expect(groupId).toBeTruthy()
    const byId = await runMama(`group move ${selfShortId!} ${groupId!}`)
    expect(byId.exitCode).toBe(0)
    expect(byId.output).toContain('"review queue"')
    expect(byId.output).not.toContain(groupId!)

    // No group moves it back to the default list; the group remains.
    const out = await runMama(`group move ${selfShortId!}`)
    expect(out.exitCode).toBe(0)
    expect(out.output).toContain('out of its group')
    const restored = await runMama('list')
    expect(restored.output).toContain('Groups: ')
    expect(restored.output).toMatch(new RegExp(`${selfShortId!}[^\\n]*\\(you\\)`))
  }, 180_000)

  it('renames itself through the proxy relay, with no workspace named', async () => {
    const { exitCode, output } = await runMama('rename "driving the mama e2e"')
    expect(exitCode).toBe(0)
    expect(output).toContain('driving the mama e2e')

    // The caller is identified by source pod IP.
    const listed = await runMama('list')
    expect(listed.output).toContain('(you)')
  }, 120_000)

  it('names the caller by its pod, whatever identity the request claims', async () => {
    // The proxy drops a workspace's own Authorization and caller header, so
    // claiming the sibling still renames the caller.
    const { stdout } = await execInJob(jobA, ['sh', '-c',
      `curl -sS -X POST -H 'Content-Type: application/json' \
        -H 'x-yaac-workspace-id: ${spawnedWorkspaceId}' -H 'Authorization: Bearer forged' \
        --data-binary '{"command":"rename","body":"forged caller"}' \
        -w '\nHTTP:%{http_code}' http://yaac.internal/api/workspace/mama 2>&1`,
    ], { timeout: 120_000 })
    expect(stdout).toContain('HTTP:200')
    const listed = await runMama('list')
    expect(listed.output).toMatch(/\(you\)[^\n]*forged caller|forged caller[^\n]*\(you\)/)
    expect(listed.output.match(/forged caller/g)).toHaveLength(1)

    // And the server's mama listener is out of a pod's reach.
    const direct = await execInJob(jobA, ['sh', '-c',
      `curl -sS --max-time 10 -o /dev/null -w 'HTTP:%{http_code}' `
        + `http://${SERVER_MAMA_SERVICE_NAME}.${k8sNamespace()}.svc.cluster.local:${SERVER_MAMA_PORT}`
        + '/api/workspace/mama 2>&1; echo "EXIT:$?"',
    ], { timeout: 120_000 })
    expect(direct.stdout).not.toContain('EXIT:0')
  }, 240_000)

  it('surfaces the server rejection for a model value outside the safe charset', async () => {
    // `;` survives the script but fails the server's MODEL_RE check, so the
    // error round trip is tested without provisioning anything.
    const { exitCode, output } = await runMama('create --model "opus;rm" "x"')
    expect(exitCode).toBe(1)
    expect(output).toContain('invalid model')
    expect(output).toContain('HTTP 422')
  }, 120_000)

  it('surfaces the server rejection for an unknown tool', async () => {
    const { exitCode, output } = await runMama('create --tool bogus "x"')
    expect(exitCode).toBe(1)
    expect(output).toContain('bogus')
    expect(output).toContain('HTTP 422')
  }, 120_000)

  it('reports which tools the host can authenticate, and their model ids', async () => {
    // Only claude.json is seeded, so only claude is configured; its model
    // ids come from the built-in catalog.
    const { exitCode, output } = await runMama('models')
    expect(exitCode).toBe(0)
    expect(output).toContain('this workspace runs: claude')
    expect(output).toContain('claude-opus-4-8')
    expect(output).toMatch(/codex\s+not configured/)
    expect(output).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/m)
  }, 120_000)

  it('--help prints usage without touching the proxy', async () => {
    const { exitCode, output } = await runMama('--help')
    expect(exitCode).toBe(0)
    expect(output).toContain('Usage:')
    expect(output).toContain('yaac-mama create')
    expect(output).toContain('--group <name>')
  }, 120_000)

  // The destructive cases run last.

  it('stops the sibling it spawned, and the stop is a stop and not a delete', async () => {
    expect(spawnedWorkspaceId).not.toBe('')
    const shortId = spawnedWorkspaceId.slice(0, 8)

    const { exitCode, output } = await runMama(`stop ${shortId}`)
    expect(exitCode).toBe(0)
    expect(output).toContain(shortId)
    expect(output).toContain('checkout is kept')

    // Teardown is detached, so the pod goes after the reply.
    let gone = false
    for (let i = 0; i < 120 && !gone; i++) {
      const pods = await listWorkspacePods(SLUG)
      gone = !pods.some((p) => p.workspaceId === spawnedWorkspaceId)
      if (!gone) await sleep(1000)
    }
    expect(gone).toBe(true)

    // It stays in the stopped listing, so the user can restart it.
    const listed = await runYaac(serverEnv, 'workspace', 'list', '--stopped')
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain(shortId)

    const mine = await runMama('list')
    expect(mine.exitCode).toBe(0)
    expect(mine.output).toContain('(you)')
  }, 240_000)

  it('stops ITSELF when no workspace is named, starting what it queued after itself', async () => {
    // Queue a follow-up under the caller's id, edit it, then let the
    // caller's own stop start it.
    const queued = await runMama('queue --parent-workspace "$YAAC_WORKSPACE_ID" "draft follow-up"')
    expect(queued.exitCode).toBe(0)
    expect(queued.output.trim()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const edited = await runMama(
      `edit-queued --title "Follow-up" ${queued.output.trim().slice(0, 8)} "follow-up from queue e2e"`)
    expect(edited.exitCode).toBe(0)
    expect(edited.output).toContain('follow-up from queue e2e')
    const listedQueue = await runMama('list')
    expect(listedQueue.output).toContain('follow-up from queue e2e')

    // A self-stop tears down the pod its reply travels through, so assert
    // that the workspace went away, not what printed. Not via `runMama`,
    // which needs an exit marker the dying exec never prints.
    await execInJob(jobA, ['sh', '-c', 'yaac-mama stop 2>&1'], { timeout: 60_000 }).catch(() => undefined)

    let gone = false
    for (let i = 0; i < 120 && !gone; i++) {
      const pods = await listWorkspacePods(SLUG)
      gone = !pods.some((p) => p.jobName === jobA)
      if (!gone) await sleep(1000)
    }
    expect(gone).toBe(true)

    // Match the caller's id: the sibling stopped above is already listed.
    const listed = await runYaac(serverEnv, 'workspace', 'list', '--stopped')
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain(callerWorkspaceId.slice(0, 8))

    // The queued workspace started: a pod that is neither caller nor sibling.
    let child: PodInfo | undefined
    for (let i = 0; i < 180 && !child?.running; i++) {
      const pods = await listWorkspacePods(SLUG)
      child = pods.find((p) => p.workspaceId !== callerWorkspaceId && p.workspaceId !== spawnedWorkspaceId)
      if (!child?.running) await sleep(1000)
    }
    expect(child?.running).toBe(true)
  }, 420_000)
})
