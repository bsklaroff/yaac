import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@yaac/server/platform/git'
import { listWorktreePods, type PodInfo } from '@yaac/server/runtime/k8s/substrate/pods'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import {
  requirePodman,
  requireCluster,
  execInJob,
  cleanupWorktreeJobs,
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
 * End-to-end coverage for in-session spawning: a session pod runs the
 * auto-installed `yaac-spawn` command, the request rides the transparent
 * HTTP egress path to the proxy's magic host, the server's background tick
 * drains it and fires a headless create, and the new session comes up in
 * the same project with the prompt typed into its agent pane.
 */
describe('yaac-spawn from inside a session (real CLI + server + cluster)', () => {
  const SLUG = 'spawner'
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let serverEnv: NodeJS.ProcessEnv
  let jobA = ''

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()

    testEnv = await createYaacTestEnv()
    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(credsDir, 'github.json'), JSON.stringify({
      tokens: [{ pattern: 'test-org/*', token: 'fake-ghp-token' }],
    }) + '\n')
    await fs.writeFile(path.join(credsDir, 'claude.json'), JSON.stringify({
      kind: 'api-key',
      savedAt: new Date().toISOString(),
      apiKey: 'sk-ant-fake-real-key',
    }) + '\n')
    await fs.writeFile(
      testEnv.gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    )

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

    // Stage the project as if `yaac project add` had cloned it (the
    // worktree-create-suite pattern: local bare repo, github-shaped remote).
    await seedMockGitRepo(mockGit, SLUG, { files: { 'README.md': '# demo\n' } })
    const projectPath = path.join(testEnv.dataDir, 'projects', SLUG)
    const repoPath = path.join(projectPath, 'repo')
    await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit.reposDir, `${SLUG}.git`), repoPath, null)
    const fakeRemote = `https://github.com/test-org/${SLUG}.git`
    await simpleGit(repoPath).remote(['set-url', 'origin', fakeRemote])
    await fs.writeFile(path.join(projectPath, 'project.json'), JSON.stringify({
      slug: SLUG,
      remoteUrl: fakeRemote,
      addedAt: new Date().toISOString(),
    }) + '\n')

    const { stdout, stderr, exitCode } = await runYaac(serverEnv, 'worktree', 'create', SLUG)
    if (exitCode !== 0) {
      throw new Error(`session create failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    const pods = await listWorktreePods(SLUG)
    if (pods.length !== 1) throw new Error(`expected 1 session pod, found ${pods.length}`)
    jobA = pods[0].jobName
  }, 300_000)

  afterAll(async () => {
    if (server) await server.stop()
    server = null
    await cleanupWorktreeJobs()
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  /** Run yaac-spawn in session A, capturing exit code + combined output
   *  ourselves (execInJob throws-and-retries on non-zero exits). */
  async function runSpawn(args: string): Promise<{ exitCode: number; output: string }> {
    const { stdout } = await execInJob(jobA, [
      'sh', '-c', `yaac-spawn ${args} 2>&1; echo "EXIT:$?"`,
    ], { timeout: 120_000 })
    const m = /\nEXIT:(\d+)\s*$/.exec(stdout) ?? /^EXIT:(\d+)\s*$/.exec(stdout)
    if (!m) throw new Error(`no exit marker in output:\n${stdout}`)
    return { exitCode: Number(m[1]), output: stdout.slice(0, m.index) }
  }

  it('is installed on PATH as a read-only file', async () => {
    const { stdout } = await execInJob(jobA, ['sh', '-c', 'command -v yaac-spawn'])
    expect(stdout.trim()).toBe('/usr/local/bin/yaac-spawn')
    const { stdout: watchPrs } = await execInJob(jobA, ['sh', '-c', 'command -v yaac-watch-prs'])
    expect(watchPrs.trim()).toBe('/usr/local/bin/yaac-watch-prs')
    // Read-only mount: a session cannot tamper with the host-staged copy.
    const { output, exitCode } = await runSpawn('') // also covers usage error
    expect(exitCode).toBe(2)
    expect(output).toContain('usage:')
    const { stdout: rw } = await execInJob(jobA, [
      'sh', '-c', 'sh -c ">> /usr/local/bin/yaac-spawn" 2>&1; echo "EXIT:$?"',
    ])
    expect(rw).not.toContain('EXIT:0')
  })

  it('spawns a sibling session with the prompt and --model delivered to its agent', async () => {
    // Watch the webapp snapshot stream: a spawned session must provision in
    // the sidebar exactly like a user-initiated create (row while building,
    // then the ready session in its place).
    //
    // --model rides along on this spawn rather than getting a session of its
    // own: the two are orthogonal flags read off different surfaces of the
    // same pod (the agent pane vs. the window's start command), and a
    // sibling bring-up is the most expensive thing in this file.
    const sub = collectSnapshots(server!.lock.port, server!.lock.secret)
    await sub.opened

    const PROMPT = 'hello from spawn e2e'
    const { exitCode, output } = await runSpawn(`--model claude-opus-4-8 "${PROMPT}"`)
    expect(exitCode).toBe(0)
    const newWorktreeId = output.trim()
    expect(newWorktreeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

    // The provisioning row for the minted id shows while the create runs.
    let sawRow = false
    for (let i = 0; i < 150 && !sawRow; i++) {
      const row = sub.latest()?.provisioning.find((p) => p.worktreeId === newWorktreeId)
      if (row) {
        expect(row.kind).toBe('create')
        expect(row.projectSlug).toBe(SLUG)
        sawRow = true
      } else await sleep(200)
    }
    expect(sawRow).toBe(true)

    // The new pod appears in the same project under the minted session id.
    let spawned: PodInfo | undefined
    for (let i = 0; i < 120 && !spawned?.running; i++) {
      const pods = await listWorktreePods(SLUG)
      spawned = pods.find((p) => p.worktreeId === newWorktreeId)
      if (!spawned?.running) await sleep(1000)
    }
    expect(spawned?.running).toBe(true)
    expect(spawned?.projectSlug).toBe(SLUG)
    // Tool defaulted to the caller's (claude — no --tool given).
    expect(spawned?.tool).toBe('claude')

    // Hand-off: once the create resolves, the row drops and the session
    // lists — never both at once (buildSnapshot hides the session while its
    // row exists).
    let handedOff = false
    for (let i = 0; i < 180 && !handedOff; i++) {
      const snap = sub.latest()
      handedOff = snap !== null
        && snap.worktrees.some((s) => s.worktreeId === newWorktreeId)
        && !snap.provisioning.some((p) => p.worktreeId === newWorktreeId)
      if (!handedOff) await sleep(1000)
    }
    expect(handedOff).toBe(true)
    sub.ws.close()

    // The prompt lands in the spawned agent's pane (typed via the shared
    // tmux paste path). claude may still be booting;
    // poll the pane until the text renders.
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

    // The agent window's launch command carries the --model override — the
    // flag claude was actually started with, whatever the TUI renders.
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
    expect(startCmd).toContain('claude --dangerously-skip-permissions --model claude-opus-4-8')
  }, 420_000)

  it('surfaces the proxy rejection for a model value outside the safe charset', async () => {
    // `;` passes shell/URL handling in yaac-spawn but fails the proxy's
    // MODEL_RE mirror — proving the model validation round trip without
    // provisioning a session.
    const { exitCode, output } = await runSpawn('--model "opus;rm" "x"')
    expect(exitCode).toBe(1)
    expect(output).toContain('invalid model')
    expect(output).toContain('HTTP 400')
  }, 120_000)

  it('surfaces the server rejection for an unknown tool', async () => {
    // 'bogus' passes the proxy's charset check; the server's AGENT_TOOLS
    // validation rejects it — proving the full round trip of the error path.
    const { exitCode, output } = await runSpawn('--tool bogus "x"')
    expect(exitCode).toBe(1)
    expect(output).toContain('bogus')
    expect(output).toContain('HTTP 422')
  }, 120_000)

  it('--models reports authed tools + model ids from the proxy', async () => {
    // The proxy answers GET yaac.internal/tools from the host-mounted creds
    // dir: only claude.json (api-key) is seeded here, so claude is authed and
    // the rest are not — and the baked catalog supplies claude's model ids.
    const { exitCode, output } = await runSpawn('--models')
    expect(exitCode).toBe(0)
    expect(output).toContain('current worktree tool: claude')
    expect(output).toContain('claude-opus-4-8')
    // codex/opencode/pi have no creds in this env.
    expect(output).toContain('not configured')
    expect(output).toMatch(/codex\s+not configured/)
    // No session was spawned: the output is a report, not a session id.
    expect(output).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/m)
  }, 120_000)

  it('--help prints usage documenting --models without touching the proxy', async () => {
    const { exitCode, output } = await runSpawn('--help')
    expect(exitCode).toBe(0)
    expect(output).toContain('Usage:')
    expect(output).toContain('--tool claude|codex|opencode|pi')
    expect(output).toContain('--models')
  }, 120_000)
})
