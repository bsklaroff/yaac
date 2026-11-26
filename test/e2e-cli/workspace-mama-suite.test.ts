import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { git } from '@yaac/test-utils/git'
import { cloneRepo } from '@yaac/server/domain/git'
import { listWorkspacePods, type PodInfo } from '@yaac/server/drivers/k8s/substrate/pods'
import { SERVER_MAMA_PORT, SERVER_MAMA_SERVICE_NAME } from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import { k8sNamespace } from '@yaac/server/drivers/k8s/substrate/api'
import { createYaacTestEnv, spawnYaacServer, setTestGitIdentity, runYaac, type YaacTestEnv } from '#support/cli'
import { assignTestGitCredential, registerTestProject, signInTestTool, type SpawnedServer } from '@yaac/test-utils/api'
import { requireCluster } from '@yaac/test-utils/setup'
import { requirePodman, execInJob, cleanupWorkspaceJobs } from '#support/cluster'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '#support/mock-remotes'
import { collectSnapshots } from '@yaac/test-utils/events-ws'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The in-workspace command channel: a workspace pod runs `yaac-mama`, whose
 * request travels over HTTP egress to the proxy's magic host, which relays
 * it to the server. What a pod and the proxy change is checked here: the
 * read-only script, the relay's allowlist, the caller named by its pod, the
 * hosted git relay, and spawning, stopping and restarting siblings and
 * itself. What each command does is the same under containerless, whose
 * tier and `api/mama` unit tests cover the rest.
 */
describe('yaac-mama from inside a workspace (real CLI + server + cluster)', () => {
  const NAME = 'spawner'
  const PROJECT_ID = crypto.randomUUID()
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

    ;[mockLLM, mockGit] = await Promise.all([startMockLLM(), startMockGit()])
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
    await signInTestTool(server, 'claude', { kind: 'api-key', apiKey: 'sk-ant-fake-real-key' })
    await setTestGitIdentity(serverEnv)

    // Stage the project as `yaac project add` would: a local bare repo with
    // a github-shaped remote.
    await seedMockGitRepo(mockGit, NAME, { files: { 'README.md': '# demo\n' } })
    const projectPath = path.join(testEnv.dataDir, 'global', 'projects', PROJECT_ID)
    // The main clone of the project's repo, which carries the project's id.
    const repoPath = path.join(testEnv.dataDir, 'global', 'repos', PROJECT_ID)
    await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit.reposDir, `${NAME}.git`), repoPath, null)
    const fakeRemote = `https://github.com/test-org/${NAME}.git`
    await git(repoPath, ['remote', 'set-url', 'origin', fakeRemote])
    await registerTestProject(server, PROJECT_ID, NAME, fakeRemote)
    await assignTestGitCredential(server, NAME, 'fake-ghp-token')

    const { stdout, stderr, exitCode } = await runYaac(serverEnv, 'workspace', 'create', NAME)
    if (exitCode !== 0) {
      throw new Error(`workspace create failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    const pods = await listWorkspacePods(PROJECT_ID)
    if (pods.length !== 1) throw new Error(`expected 1 workspace pod, found ${pods.length}`)
    jobA = pods[0].jobName
    callerWorkspaceId = pods[0].workspaceId
  })

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
   * Run yaac-mama in workspace A's checkout, as from one of its windows, and
   * return its exit code and output (execInJob would throw and retry on a
   * non-zero exit).
   */
  async function runMama(args: string): Promise<{ exitCode: number; output: string }> {
    const { stdout } = await execInJob(jobA, [
      'sh', '-c', `cd /workspace && yaac-mama ${args} 2>&1; echo "EXIT:$?"`,
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
        expect(row.projectId).toBe(PROJECT_ID)
        sawRow = true
      } else await sleep(200)
    }
    expect(sawRow).toBe(true)

    let spawned: PodInfo | undefined
    for (let i = 0; i < 480 && !spawned?.running; i++) {
      const pods = await listWorkspacePods(PROJECT_ID)
      spawned = pods.find((p) => p.workspaceId === newWorkspaceId)
      if (!spawned?.running) await sleep(250)
    }
    expect(spawned?.running).toBe(true)
    expect(spawned?.projectId).toBe(PROJECT_ID)
    // No --tool, so its session inherits the caller's (claude).
    let tool: string | undefined
    for (let i = 0; i < 150 && tool === undefined; i++) {
      tool = sub.latest()?.workspaces.find((w) => w.workspaceId === newWorkspaceId)?.sessions[0]?.tool
      if (tool === undefined) await sleep(200)
    }
    expect(tool).toBe('claude')

    // The row is replaced by the workspace, never both at once
    // (buildSnapshot hides the workspace while its row exists).
    let handedOff = false
    for (let i = 0; i < 720 && !handedOff; i++) {
      const snap = sub.latest()
      handedOff = snap !== null
        && snap.workspaces.some((s) => s.workspaceId === newWorkspaceId)
        && !snap.provisioning.some((p) => p.workspaceId === newWorkspaceId)
      if (!handedOff) await sleep(250)
    }
    expect(handedOff).toBe(true)
    expect(sub.latest()?.workspaces.find((s) => s.workspaceId === newWorkspaceId)?.title).toBe('Spawned by e2e')
    sub.ws.close()

    // The prompt is pasted into the agent's pane; poll while claude boots.
    let pane = ''
    let found = false
    for (let i = 0; i < 240; i++) {
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
      await sleep(250)
    }
    if (!found) console.error('final spawned pane:\n' + pane)
    expect(found).toBe(true)

    // Check the flags claude was launched with, not what its TUI shows.
    let startCmd = ''
    for (let i = 0; i < 240; i++) {
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
      await sleep(250)
    }
    expect(startCmd).toContain('claude --permission-mode plan --model claude-opus-4-8')
  }, 420_000)

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

    // And the server's mama listener is out of a pod's reach: the dial
    // connects, as every dial does, and the proxy refuses the install's own
    // Service by name.
    const direct = await execInJob(jobA, ['sh', '-c',
      `curl -sS --max-time 10 -o /dev/null -w 'HTTP:%{http_code}' `
        + `http://${SERVER_MAMA_SERVICE_NAME}.${k8sNamespace()}.svc.cluster.local:${SERVER_MAMA_PORT}`
        + '/api/workspace/mama 2>&1',
    ], { timeout: 120_000 })
    expect(direct.stdout).toContain('HTTP:403')
  }, 240_000)

  it('relays a pod\'s git to its hosted remote, and refuses another project\'s pod', async () => {
    const created = await runYaac(serverEnv, 'project', 'create', 'mama-hosted')
    expect(created.exitCode, created.stderr).toBe(0)
    const hostedId = /\(([0-9a-f-]{36})\)/.exec(created.stdout)?.[1] ?? ''
    expect(hostedId).not.toBe('')
    const made = await runYaac(serverEnv, 'workspace', 'create', 'mama-hosted')
    expect(made.exitCode, made.stderr).toBe(0)
    // The project's id names its pods, its repo's id the remote and main clone.
    const projects = await (await fetch(`http://127.0.0.1:${String(server!.lock.port)}/api/project/list`))
      .json() as Array<{ id: string; repos: Array<{ id: string }> }>
    const hostedRepo = projects.find((p) => p.id === hostedId)?.repos[0]?.id ?? ''
    expect(hostedRepo).not.toBe('')
    const [pod] = await listWorkspacePods(hostedId)
    try {
      const pushed = await execInJob(pod.jobName, ['sh', '-c',
        'cd /workspace && git commit -q --allow-empty -m first && git push -q origin HEAD:main 2>&1 && git rev-parse HEAD'],
      { timeout: 120_000 })
      const tip = pushed.stdout.trim().split('\n').pop() ?? ''
      // The push lands in the main clone, which the server fetches at once.
      const mainClone = path.join(testEnv.dataDir, 'global', 'repos', hostedRepo)
      for (let i = 0; i < 60; i += 1) {
        if ((await git(mainClone, ['rev-parse', 'refs/remotes/origin/main']).catch(() => '')).trim() === tip) break
        await sleep(500)
      }
      expect((await git(mainClone, ['rev-parse', 'refs/remotes/origin/main'])).trim()).toBe(tip)

      // A pod of another project is refused, by the server, as itself.
      const { stdout } = await execInJob(jobA, ['sh', '-c',
        `git ls-remote http://yaac.internal/api/workspace/git/${hostedRepo}.git 2>&1; echo "EXIT:$?"`])
      expect(stdout).toMatch(/403/)
      expect(stdout).not.toContain('EXIT:0')
    } finally {
      await runYaac(serverEnv, 'workspace', 'stop', pod.workspaceId)
    }
  }, 300_000)

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
    for (let i = 0; i < 480 && !gone; i++) {
      const pods = await listWorkspacePods(PROJECT_ID)
      gone = !pods.some((p) => p.workspaceId === spawnedWorkspaceId)
      if (!gone) await sleep(250)
    }
    expect(gone).toBe(true)

    // It stays in the stopped listing, so it can be restarted.
    const listed = await runYaac(serverEnv, 'workspace', 'list', '--stopped')
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain(shortId)

    const mine = await runMama('list')
    expect(mine.exitCode).toBe(0)
    expect(mine.output).toContain('(you)')
  }, 240_000)

  it('finds the stopped sibling, reads it as it is, and restarts it with its conversation', async () => {
    const shortId = spawnedWorkspaceId.slice(0, 8)

    const found = await runMama('list --stopped --search "spawned BY" --group "release train" --limit 5')
    expect(found.exitCode, found.output).toBe(0)
    expect(found.output).toMatch(new RegExp(`^${shortId}\\s+claude\\s+\\S+ \\S+\\s+stopped\\s+release train\\s+Spawned by e2e`, 'm'))
    const shown = await runMama(`list ${shortId}`)
    expect(shown.output).toContain('Stopped workspaces:')
    expect(shown.output).toContain('hello from spawn e2e')

    // Its conversation and branches stay readable while it is stopped.
    const history = await runMama(`history ${shortId}`)
    expect(history.exitCode, history.output).toBe(0)
    expect(history.output).toMatch(/\sclaude\s+tui\s/)
    const fetched = await runMama(`fetch ${shortId}`)
    expect(fetched.exitCode, fetched.output).toBe(0)
    expect(fetched.output).toContain(`yaac/peers/${shortId}/HEAD`)

    const unsent = await runMama(`send ${shortId} "are you there"`)
    expect(unsent.exitCode).toBe(1)
    expect(unsent.output).toContain(`restart it with yaac-mama restart ${shortId}`)
    // A person's send (`yaac workspace send`) reaches the same route, by
    // whichever option names its message or its session.
    const note = path.join(testEnv.dataDir, 'note.md')
    await fs.writeFile(note, 'are you there')
    for (const args of [['--prompt', 'are you there'], ['--prompt-file', note, '--agent', 'abc'], ['--prompt', 'x', '--conversation', 'abc']]) {
      const refused = await runYaac(serverEnv, 'workspace', 'send', shortId, ...args)
      expect(refused.exitCode, args.join(' ')).toBe(1)
      expect(refused.stderr).toContain(`workspace ${shortId} is stopped`)
    }

    const restarted = await runMama(`restart ${shortId}`)
    expect(restarted.exitCode, restarted.output).toBe(0)
    expect(restarted.output).toContain(`Restarting ${shortId}`)
    let back: PodInfo | undefined
    for (let i = 0; i < 720 && !back?.running; i++) {
      back = (await listWorkspacePods(PROJECT_ID)).find((p) => p.workspaceId === spawnedWorkspaceId)
      if (!back?.running) await sleep(250)
    }
    expect(back?.running).toBe(true)
    // Its session comes back in the posture it had.
    let startCmd = ''
    for (let i = 0; i < 240 && !startCmd.includes('--permission-mode'); i++) {
      startCmd = await execInJob(back!.jobName, ['sh', '-c',
        `tmux -S ${CONTAINER_TMUX_SOCK} list-panes -s -t yaac -F "#{window_name} #{pane_start_command}" 2>&1 | grep '^claude-'`,
      ], { timeout: 10_000 }).then((r) => r.stdout, () => '')
      if (!startCmd.includes('--permission-mode')) await sleep(250)
    }
    expect(startCmd).toContain('--permission-mode plan')
  }, 420_000)

  // Queuing after itself, and the queued start a stop sets off, are the
  // same under containerless, which checks them.
  it('stops ITSELF when no workspace is named', async () => {
    // A running workspace is never restarted from here, itself least of all.
    const self = await runMama('restart "$YAAC_WORKSPACE_ID"')
    expect(self.exitCode).toBe(1)
    expect(self.output).toContain('cannot restart this workspace itself')

    // A self-stop tears down the pod its reply travels through, so assert
    // that the workspace went away, not what printed. Not via `runMama`,
    // which needs an exit marker the dying exec never prints.
    await execInJob(jobA, ['sh', '-c', 'yaac-mama stop 2>&1'], { timeout: 60_000 }).catch(() => undefined)

    let gone = false
    for (let i = 0; i < 480 && !gone; i++) {
      const pods = await listWorkspacePods(PROJECT_ID)
      gone = !pods.some((p) => p.jobName === jobA)
      if (!gone) await sleep(250)
    }
    expect(gone).toBe(true)

    // Match the caller's id: the sibling stopped above is already listed.
    const listed = await runYaac(serverEnv, 'workspace', 'list', '--stopped')
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain(callerWorkspaceId.slice(0, 8))
  }, 420_000)
})
