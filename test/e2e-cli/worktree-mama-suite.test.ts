import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@yaac/server/domain/git'
import { listWorktreePods, type PodInfo } from '@yaac/server/drivers/k8s/substrate/pods'
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
 * End-to-end coverage for the in-session command channel: a session pod runs
 * the auto-installed `yaac-mama`, its JSON envelope rides the transparent
 * HTTP egress path to the proxy's magic host, the server's background tick
 * drains it, and the command runs against the caller's own project — a
 * sibling session created with its prompt typed into its agent pane, the
 * project's sessions listed back, groups made and filled.
 */
describe('yaac-mama from inside a session (real CLI + server + cluster)', () => {
  const SLUG = 'spawner'
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let serverEnv: NodeJS.ProcessEnv
  let jobA = ''
  /** The caller's own worktree id — what the self-stop case asserts against,
   *  since its whole point is that the CALLER's row outlives its unit. */
  let callerWorktreeId = ''
  /** The sibling the spawn case creates — the stop case's subject, since a
   *  session bring-up is the most expensive thing in this file. */
  let spawnedWorktreeId = ''

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()

    testEnv = await createYaacTestEnv()
    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(credsDir, 'github.json'), JSON.stringify({
      tokens: [{ pattern: 'github.com/test-org/*', token: 'fake-ghp-token' }],
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
    callerWorktreeId = pods[0].worktreeId
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

  /** Run yaac-mama in session A, capturing exit code + combined output
   *  ourselves (execInJob throws-and-retries on non-zero exits). */
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
    // No command at all is a usage error, not a request.
    const { output, exitCode } = await runMama('')
    expect(exitCode).toBe(2)
    expect(output).toContain('Usage:')
    // Read-only mount: a session cannot tamper with the host-staged copy.
    const { stdout: rw } = await execInJob(jobA, [
      'sh', '-c', 'sh -c ">> /usr/local/bin/yaac-mama" 2>&1; echo "EXIT:$?"',
    ])
    expect(rw).not.toContain('EXIT:0')
  })

  it('refuses a command outside the allowlist, whatever the caller sends', async () => {
    // The script rejects what it does not offer...
    const viaScript = await runMama('delete 1234')
    expect(viaScript.exitCode).toBe(2)
    expect(viaScript.output).toContain('unknown command')

    // ...and the SERVER refuses it too, which is the half that matters: the
    // proxy queues envelopes without knowing what any command means, so a
    // caller bypassing the script reaches the same allowlist.
    const { stdout } = await execInJob(jobA, ['sh', '-c',
      `curl -sS -X POST -H 'Content-Type: application/json' \
        --data-binary '{"command":"delete","args":{},"body":"x"}' \
        -w '\nHTTP:%{http_code}' http://yaac.internal/cmd 2>&1`,
    ], { timeout: 120_000 })
    expect(stdout).toContain('unknown command')
    expect(stdout).toContain('HTTP:422')
  }, 120_000)

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
    const { exitCode, output } = await runMama(
      `create --model claude-opus-4-8 --group "release train" "${PROMPT}"`)
    expect(exitCode).toBe(0)
    const newWorktreeId = output.trim()
    expect(newWorktreeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    spawnedWorktreeId = newWorktreeId

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
    expect(startCmd).toContain('claude --permission-mode bypassPermissions --model claude-opus-4-8')
  }, 420_000)

  it('lists the project\u2019s sessions, marking the caller and its group', async () => {
    // Runs after the spawn above, so both sessions are up and the spawned
    // one is filed under the group `create --group` made.
    const { exitCode, output } = await runMama('list')
    expect(exitCode).toBe(0)
    expect(output).toMatch(/SESSION\s+TOOL\s+STATUS\s+GROUP\s+PROMPT/)
    // The caller's own row is marked, which is how an agent tells itself
    // from its siblings.
    expect(output).toContain('(you)')
    // The group made during the spawn is listed, and holds the sibling.
    expect(output).toContain('release train')
    expect(output).toContain('Groups: release train')
  }, 120_000)

  it('makes a group and files a session into it, by name and short id', async () => {
    const made = await runMama('group create "review queue"')
    expect(made.exitCode).toBe(0)
    expect(made.output).toContain('review queue')

    // Idempotent: an agent can name a group without checking first.
    const again = await runMama('group create "review queue"')
    expect(again.exitCode).toBe(0)

    // Move the CALLER itself, addressed by the 8-char prefix `list` prints.
    const listed = await runMama('list')
    const selfShortId = /^([0-9a-f]{8}) \(you\)/m.exec(listed.output)?.[1]
    expect(selfShortId).toBeTruthy()

    const moved = await runMama(`group move ${selfShortId!} "review queue"`)
    expect(moved.exitCode).toBe(0)
    expect(moved.output).toContain('review queue')

    const after = await runMama('list')
    expect(after.output).toMatch(new RegExp(`${selfShortId!}[^\\n]*review queue`))

    // Addressed by group id — which is what the ambiguity error tells an
    // agent to pass — the line still names the group it landed on.
    const groupId = /\(([0-9a-f-]{36})\)/.exec(made.output)?.[1]
    expect(groupId).toBeTruthy()
    const byId = await runMama(`group move ${selfShortId!} ${groupId!}`)
    expect(byId.exitCode).toBe(0)
    expect(byId.output).toContain('"review queue"')
    expect(byId.output).not.toContain(groupId!)

    // Omitting the group puts it back in the default list, leaving the
    // group behind.
    const out = await runMama(`group move ${selfShortId!}`)
    expect(out.exitCode).toBe(0)
    expect(out.output).toContain('out of its group')
    const restored = await runMama('list')
    expect(restored.output).toContain('Groups: ')
    expect(restored.output).toMatch(new RegExp(`${selfShortId!}[^\\n]*\\(you\\)`))
  }, 180_000)

  it('renames itself over the proxy queue, with no session named', async () => {
    const { exitCode, output } = await runMama('rename "driving the mama e2e"')
    expect(exitCode).toBe(0)
    expect(output).toContain('driving the mama e2e')

    // The caller is attributed by source pod IP, so the title has to land on
    // the calling session and no other.
    const listed = await runMama('list')
    expect(listed.output).toContain('(you)')
  }, 120_000)

  it('surfaces the proxy rejection for a model value outside the safe charset', async () => {
    // `;` survives the script's JSON encoding but fails the proxy's MODEL_RE
    // mirror — proving the option validation round trip without provisioning
    // a session.
    const { exitCode, output } = await runMama('create --model "opus;rm" "x"')
    expect(exitCode).toBe(1)
    expect(output).toContain('invalid value for --model')
    expect(output).toContain('HTTP 400')
  }, 120_000)

  it('surfaces the server rejection for an unknown tool', async () => {
    // 'bogus' passes the proxy's charset check; the server's AGENT_TOOLS
    // validation rejects it — proving the full round trip of the error path.
    const { exitCode, output } = await runMama('create --tool bogus "x"')
    expect(exitCode).toBe(1)
    expect(output).toContain('bogus')
    expect(output).toContain('HTTP 422')
  }, 120_000)

  it('reports which tools the host can authenticate, and their model ids', async () => {
    // Answered by the SERVER from the host's own credentials: only
    // claude.json (api-key) is seeded here, so claude is configured and the
    // rest are not, with the baked catalog supplying claude's model ids.
    const { exitCode, output } = await runMama('models')
    expect(exitCode).toBe(0)
    expect(output).toContain('this session runs: claude')
    expect(output).toContain('claude-opus-4-8')
    expect(output).toMatch(/codex\s+not configured/)
    // No session was spawned: the output is a report, not a session id.
    expect(output).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/m)
  }, 120_000)

  it('--help prints usage without touching the proxy', async () => {
    const { exitCode, output } = await runMama('--help')
    expect(exitCode).toBe(0)
    expect(output).toContain('Usage:')
    expect(output).toContain('yaac-mama create')
    expect(output).toContain('--group <name>')
  }, 120_000)

  // The two destructive cases, last in the file: after them there is no
  // sibling to list and, finally, no caller to run a command in.

  it('stops the sibling it spawned, and the stop is a stop and not a delete', async () => {
    expect(spawnedWorktreeId).not.toBe('')
    const shortId = spawnedWorktreeId.slice(0, 8)

    const { exitCode, output } = await runMama(`stop ${shortId}`)
    expect(exitCode).toBe(0)
    expect(output).toContain(shortId)
    expect(output).toContain('checkout is kept')

    // The teardown is detached, so the unit goes after the reply, not with
    // it.
    let gone = false
    for (let i = 0; i < 120 && !gone; i++) {
      const pods = await listWorktreePods(SLUG)
      gone = !pods.some((p) => p.worktreeId === spawnedWorktreeId)
      if (!gone) await sleep(1000)
    }
    expect(gone).toBe(true)

    // What makes this reversible survives: the session is in the stopped
    // listing, which is where the user restarts it from.
    const listed = await runYaac(serverEnv, 'worktree', 'list', '--stopped')
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain(shortId)

    // The caller is untouched — naming a session means that session.
    const mine = await runMama('list')
    expect(mine.exitCode).toBe(0)
    expect(mine.output).toContain('(you)')
  }, 240_000)

  it('stops ITSELF when no session is named', async () => {
    // A self-stop tears down the pod its own reply travels back through, so
    // what is asserted is that the session went away — not what printed.
    // Whether the confirmation (or the exec itself) survives the teardown is
    // exactly the race the skill tells an agent not to depend on, which is
    // also why this does not go through `runMama`: a dying exec must not be
    // retried into the file's time budget.
    await execInJob(jobA, ['sh', '-c', 'yaac-mama stop 2>&1'], {
      timeout: 60_000,
      maxAttempts: 1,
    }).catch(() => undefined)

    let gone = false
    for (let i = 0; i < 120 && !gone; i++) {
      const pods = await listWorktreePods(SLUG)
      gone = !pods.some((p) => p.jobName === jobA)
      if (!gone) await sleep(1000)
    }
    expect(gone).toBe(true)

    // The CALLER's own row specifically — the sibling stopped above is
    // already in this listing, so asserting anything less than its id would
    // pass whether or not the thing this case exists to prove happened.
    const listed = await runYaac(serverEnv, 'worktree', 'list', '--stopped')
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain(callerWorktreeId.slice(0, 8))
  }, 240_000)
})
