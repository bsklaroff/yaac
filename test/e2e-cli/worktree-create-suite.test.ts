import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import WebSocket from 'ws'
import simpleGit from 'simple-git'
import { cloneRepo } from '@yaac/server/domain/git'
import { listWorktreePods, type PodInfo } from '@yaac/server/runtime/k8s/substrate/pods'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import {
  IS_NESTED_YAAC,
  requirePodman,
  requireCluster,
  execInJob,
  cleanupWorktreeJobs,
} from '@yaac/test-utils/setup'
import { k8sNamespace, kubectlWithRetry } from '@yaac/server/runtime/k8s/substrate/kubectl'
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

const execFileAsync = promisify(execFile)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Consolidated end-to-end coverage for `yaac worktree create` and everything
 * that hangs off a live session: real CLI + real server + real cluster, with
 * the proxy's `upstreamRedirects` feature rerouting every outbound host
 * (GitHub, Anthropic, OpenAI) to mock pods in the test namespace.
 *
 * One server + one mock-LLM/mock-Git pair serves the whole file, and one
 * "kitchen-sink" claude session carries every orthogonal per-session feature
 * (envPassthrough, cacheVolumes, initCommands, portForward, bindMounts,
 * node_modules redirect) so we don't pay a pod bring-up per
 * feature. This file replaces the former session-create-happy / -claude /
 * -codex / -opencode / -features, session-status, port-forward, the PTY half
 * of server-ws, and the hand-off half of session-provisioning.
 *
 * Within each describe the `it`s run in declaration order and some are
 * deliberately sequenced: the claude round-trip needs the live agent, the
 * status-watcher test then replaces it with an inert sleep, and the
 * node_modules/delete test tears the session down — keep that order.
 *
 * Deliberately deferred (unchanged from the originals):
 *   - pnpm cache reuse — exercises pnpm store behavior, not CLI surface.
 *   - nestedContainers — covered by nested-containers.test.ts.
 *   - full opencode turn via mock LLM — its HTTP server runs independently
 *     of any provider; reaching /session/status proves the wiring.
 */

/** POSIX single-quote escaping for strings embedded in `sh -c '...'`. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function httpGet(url: string, timeoutMs = 15_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timed out'))
    })
  })
}

/** Open a WS against the server, collecting text + binary frames. */
function openWs(url: string, headers: Record<string, string>): {
  ws: WebSocket
  text: string[]
  binary: () => string
  opened: Promise<void>
} {
  const ws = new WebSocket(url, { headers })
  const text: string[] = []
  const chunks: Buffer[] = []
  ws.on('message', (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
    if (isBinary) chunks.push(buf)
    else text.push(buf.toString('utf8'))
  })
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  opened.catch(() => {})
  return { ws, text, binary: () => Buffer.concat(chunks).toString('utf8'), opened }
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature-placeholder`
}

const CODEX_REAL_ACCESS_TOKEN = 'codex-real-access-token'

describe('yaac worktree create suite (real CLI + real server + mocked remotes)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let serverEnv: NodeJS.ProcessEnv
  let base = ''
  let auth: Record<string, string> = {}

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()

    testEnv = await createYaacTestEnv()

    // Fake credentials for every tool the suite exercises. The proxy reads
    // these at MITM time and swaps the container-facing placeholders for the
    // "real" values — the mock ignores them, but the swap is what we assert.
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
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
    await fs.writeFile(path.join(credsDir, 'codex.json'), JSON.stringify({
      kind: 'oauth',
      savedAt: new Date().toISOString(),
      codexOauth: {
        accessToken: CODEX_REAL_ACCESS_TOKEN,
        refreshToken: 'codex-real-refresh-token',
        idTokenRawJwt: makeJwt({
          sub: 'user-mock',
          email: 'test@example.com',
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-mock',
            chatgpt_user_id: 'user-mock',
          },
        }),
        expiresAt: futureExpSeconds * 1000,
        lastRefresh: new Date().toISOString(),
        accountId: 'acct-mock',
      },
    }) + '\n')
    // `provider` is required: a stored opencode credential that names none is
    // dropped at load (with a warning), which would leave the session with no
    // provider env var at all.
    await fs.writeFile(path.join(credsDir, 'opencode.json'), JSON.stringify({
      kind: 'api-key',
      provider: 'openrouter',
      savedAt: new Date().toISOString(),
      apiKey: 'sk-or-v1-fake-test-key',
    }) + '\n')

    await fs.writeFile(
      testEnv.gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    )

    mockLLM = await startMockLLM()
    mockGit = await startMockGit()

    // Redirect every host any of the tools' startup touches. Missing a
    // claude/statsig host causes claude's background task to 502 and the
    // whole process to unwind; `auth.openai.com` covers codex's background
    // refresh attempts.
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
        'api.openai.com': llmTarget,
        'auth.openai.com': llmTarget,
        'chatgpt.com': llmTarget,
        'ab.chatgpt.com': llmTarget,
        'openai.com': llmTarget,
        'cdn.openai.com': llmTarget,
      }),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
      // Set once at server startup so the envPassthrough test can observe
      // it without needing to restart the server. Harmless for other tests.
      YAAC_TEST_VAR: 'hello-from-host',
    }
    server = await spawnYaacServer(serverEnv)
    base = `http://127.0.0.1:${server.lock.port}`
    auth = { authorization: `Bearer ${server.lock.secret}` }
  })

  afterAll(async () => {
    if (server) await server.stop()
    server = null
    await cleanupWorktreeJobs()
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  /**
   * Stage a yaac project on disk as if `yaac project add` had cloned
   * github.com/test-org/<slug>.git — clone from the local bare repo (fast,
   * no network) and rewrite the remote URL to the pretend github URL so
   * proxy routing + token resolution see it as a github remote.
   */
  async function setupProject(
    slug: string,
    opts: {
      yaacConfig?: Record<string, unknown>
      files?: Record<string, string>
      extraBranches?: Record<string, Record<string, string>>
    } = {},
  ): Promise<string> {
    const files: Record<string, string> = {
      'README.md': '# demo\n',
      ...(opts.files ?? {}),
    }
    await seedMockGitRepo(mockGit!, slug, { files, extraBranches: opts.extraBranches })

    const projectPath = path.join(testEnv.dataDir, 'projects', slug)
    const repoPath = path.join(projectPath, 'repo')
    await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit!.reposDir, `${slug}.git`), repoPath, null)
    const fakeRemote = `https://github.com/test-org/${slug}.git`
    await simpleGit(repoPath).remote(['set-url', 'origin', fakeRemote])
    await fs.writeFile(path.join(projectPath, 'project.json'), JSON.stringify({
      slug,
      remoteUrl: fakeRemote,
      addedAt: new Date().toISOString(),
    }) + '\n')

    if (opts.yaacConfig) {
      const configDir = path.join(projectPath, 'config')
      await fs.mkdir(configDir, { recursive: true })
      await fs.writeFile(
        path.join(configDir, 'yaac-config.json'),
        JSON.stringify(opts.yaacConfig, null, 2) + '\n',
      )
    }
    return projectPath
  }

  async function findWorktreePod(slug: string): Promise<PodInfo> {
    // listWorktreePods scopes by the data-dir-hash label, so we never trip
    // over pods owned by a concurrent worker. Oldest-first so we always
    // grab the CLI's session.
    const pods = await listWorktreePods(slug)
    const pod = pods.sort((a, b) => a.createdAtMs - b.createdAtMs)[0]
    if (!pod) throw new Error(`no session pod found for project ${slug}`)
    return pod
  }

  async function createWorktree(
    slug: string,
    ...extraArgs: string[]
  ): Promise<{ jobName: string; stdout: string }> {
    const { stdout, stderr, exitCode } = await runYaac(
      serverEnv, 'worktree', 'create', slug, ...extraArgs,
    )
    if (exitCode !== 0) {
      throw new Error(`session create failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    return { jobName: (await findWorktreePod(slug)).jobName, stdout }
  }

  /**
   * Spawn an HTTP server inside a session pod (backgrounded with nohup —
   * kubectl exec has no detach mode) and wait (in-container) for it to
   * accept. Each call should use a unique `containerPort` so tests don't
   * fight over the same listen socket.
   */
  async function startHttpServerInContainer(
    jobName: string,
    containerPort: number,
    bindAddress: '127.0.0.1' | '::1',
    responseText: string,
  ): Promise<void> {
    const script = `
      const http = require('http');
      http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(${JSON.stringify(responseText)});
      }).listen(${containerPort}, '${bindAddress}');
    `
    await execInJob(jobName, [
      'sh', '-c', `nohup node -e ${shq(script)} >/dev/null 2>&1 &`,
    ])

    const curlHost = bindAddress === '::1' ? '[::1]' : bindAddress
    for (let i = 0; i < 40; i++) {
      try {
        const { stdout } = await execInJob(jobName, [
          'sh', '-c',
          `curl -sf http://${curlHost}:${containerPort}/`,
        ], { timeout: 5000 })
        if (stdout === responseText) return
      } catch {
        await sleep(250)
      }
    }
    throw new Error(`HTTP server on ${bindAddress}:${containerPort} never became ready`)
  }

  describe('kitchen-sink claude session', () => {
    // One session exercises every orthogonal create-time feature at once.
    const PORT_FORWARD = [
      { containerPort: 8080, hostPortStart: 20000 },
      { containerPort: 8081, hostPortStart: 20010 },
      { containerPort: 8082, hostPortStart: 20020 },
      { containerPort: 8083, hostPortStart: 20030 },
      { containerPort: 8084, hostPortStart: 20040 },
    ]
    // Container-port → host-port map, populated from the CLI's
    // "Forwarding host port ... -> container port ..." progress messages.
    const hostPortFor = new Map<number, number>()
    let jobName = ''
    let worktreeId = ''
    let projectPath = ''
    let roDir = ''
    let rwDir = ''

    beforeAll(async () => {
      roDir = path.join(testEnv.scratchDir, 'ro-data')
      rwDir = path.join(testEnv.scratchDir, 'rw-data')
      for (const d of [roDir, rwDir]) {
        await fs.mkdir(d, { recursive: true })
      }
      await fs.writeFile(path.join(roDir, 'readme.txt'), 'read-only content')
      await fs.writeFile(path.join(rwDir, 'data.txt'), 'writable content')

      projectPath = await setupProject('kitchen', {
        // Real Node projects gitignore node_modules; seed the same so
        // `git status` stays clean once the bind mount is populated.
        // `frontends/` is tracked so the nested ephemeral path below has a
        // real parent: its mount point is created on the host worktree
        // before the checkout, which then has to populate a dir that is
        // already there.
        files: { '.gitignore': 'node_modules\n', 'frontends/app.txt': 'app\n' },
        yaacConfig: {
          envPassthrough: ['YAAC_TEST_VAR'],
          // Both shapes of ephemeral redirect at once: the root default and
          // a nested path whose target dir sits under a tracked one.
          ephemeralModulesPaths: ['node_modules', 'frontends/node_modules'],
          // cacheVolumes are hostPath dirs under the project dir on the k8s
          // backend, so they vanish with the temp data dir.
          cacheVolumes: { 'test-cache': '/tmp/test-cache' },
          // `sleep` keeps the init tmux window alive long enough for the
          // server's follow-up `tmux set-option -t yaac:init remain-on-exit`
          // to find the window. A bare `touch` exits before that call and
          // triggers a retry loop in session-create.
          initCommands: ['touch /tmp/init-ran && sleep 30'],
          portForward: PORT_FORWARD,
          bindMounts: [
            { hostPath: roDir, containerPath: '/mnt/ro-data', mode: 'ro' },
            { hostPath: rwDir, containerPath: '/mnt/rw-data', mode: 'rw' },
          ],
        },
      })

      // Pre-seed claude-code's onboarding state so the first-run wizard is
      // skipped. These mount as /home/yaac/.claude.json and
      // /home/yaac/.claude/settings.json in the session pod. `/repo` (not
      // `/workspace`) is the key claude uses because the session worktree's
      // .git file points at /repo/.git.
      await fs.writeFile(path.join(projectPath, 'claude.json'), JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: '2.1.116',
        customApiKeyResponses: { approved: ['yaac-ph-api-key'], rejected: [] },
        projects: {
          '/repo': { hasTrustDialogAccepted: true },
          '/workspace': { hasTrustDialogAccepted: true },
        },
      }) + '\n')
      await fs.writeFile(path.join(projectPath, 'claude', 'settings.json'), JSON.stringify({
        skipDangerousModePermissionPrompt: true,
      }) + '\n')

      const created = await createWorktree('kitchen', '--tool', 'claude')
      jobName = created.jobName

      // Parse the CLI's progress stream for the resolved host ports. Each
      // portForward entry produces one such line — this both tells us which
      // host port to dial and proves the server read our config.
      for (const line of created.stdout.split('\n')) {
        const m = line.match(/Forwarding host port (\d+) -> container port (\d+)/)
        if (m) hostPortFor.set(Number(m[2]), Number(m[1]))
      }
      expect(hostPortFor.size).toBe(PORT_FORWARD.length)

      worktreeId = (await findWorktreePod('kitchen')).worktreeId
      expect(worktreeId).toBeTruthy()
    }, 240_000)

    it('provisions pod, worktree, mounts, git, and tmux', async () => {
      const pod = await findWorktreePod('kitchen')
      expect(pod.running).toBe(true)
      expect(pod.labels['yaac.project']).toBe('kitchen')
      expect(pod.labels['yaac.tool']).toBe('claude')

      await execInJob(jobName, ['test', '-d', '/home/yaac/.claude'])
      await execInJob(jobName, ['test', '-f', '/home/yaac/.claude.json'])
      await execInJob(jobName, ['test', '-d', '/home/yaac/.codex'])

      const { stdout: lsOut } = await execInJob(jobName, ['ls', '/workspace'])
      expect(lsOut).toContain('README.md')

      // kubectl exec has no workdir flag — cd inside the shell instead.
      const { stdout: gitStatus } = await execInJob(jobName, [
        'sh', '-c', 'cd /workspace && git status --porcelain',
      ])
      expect(gitStatus.trim()).toBe('')
      const { stdout: branch } = await execInJob(jobName, [
        'sh', '-c', 'cd /workspace && git rev-parse --abbrev-ref HEAD',
      ])
      expect(branch.trim()).toBe(`agent/${worktreeId}`)

      const { stdout: tmuxList } = await execInJob(jobName, [
        'tmux', '-S', CONTAINER_TMUX_SOCK, 'list-sessions',
      ])
      expect(tmuxList).toContain('yaac')

      await expect(execInJob(jobName, [
        'test', '-f', '/tmp/yaac-prompt',
      ])).rejects.toThrow()
    }, 60_000)

    it('passes envPassthrough vars to the container', async () => {
      const { stdout } = await execInJob(jobName, ['env'])
      expect(stdout).toContain('YAAC_TEST_VAR=hello-from-host')
    }, 60_000)

    it('mounts named cacheVolumes from config', async () => {
      await execInJob(jobName, [
        'sh', '-c', 'echo hello > /tmp/test-cache/marker',
      ])
      const { stdout } = await execInJob(jobName, [
        'cat', '/tmp/test-cache/marker',
      ])
      expect(stdout.trim()).toBe('hello')
    }, 60_000)

    it('runs initCommands at session start', async () => {
      // Init commands run in a background tmux window, so poll rather than
      // assume they finished by the time session-create returned.
      let ran = false
      for (let i = 0; i < 40; i++) {
        try {
          await execInJob(jobName, ['test', '-f', '/tmp/init-ran'])
          ran = true
          break
        } catch {
          await sleep(250)
        }
      }
      expect(ran).toBe(true)
    }, 60_000)

    it('mounts bindMounts read-only and read-write per config mode', async () => {
      const { stdout: roContent } = await execInJob(jobName, [
        'cat', '/mnt/ro-data/readme.txt',
      ])
      expect(roContent.trim()).toBe('read-only content')
      await expect(execInJob(jobName, [
        'sh', '-c', 'echo test > /mnt/ro-data/fail.txt',
      ])).rejects.toThrow()

      const { stdout: rwContent } = await execInJob(jobName, [
        'cat', '/mnt/rw-data/data.txt',
      ])
      expect(rwContent.trim()).toBe('writable content')
      await execInJob(jobName, [
        'sh', '-c', 'echo new-data > /mnt/rw-data/new.txt',
      ])
      const { stdout: newContent } = await execInJob(jobName, [
        'cat', '/mnt/rw-data/new.txt',
      ])
      expect(newContent.trim()).toBe('new-data')
    }, 60_000)

    it('surfaces forwarded host ports in the tmux status bar', async () => {
      // Port forwarding runs through the server's per-connection
      // `kubectl exec nc` relay, not any kubernetes port mapping, so the
      // pod spec has no port map — status-right is the user-facing surface
      // for the chosen host ports, alongside the session id.
      const { stdout: statusRight } = await execInJob(jobName, [
        'tmux', '-S', CONTAINER_TMUX_SOCK,
        'show-option', '-t', 'yaac', 'status-right',
      ])
      expect(statusRight).toContain(worktreeId.slice(0, 8))
      for (const { containerPort, hostPortStart } of PORT_FORWARD.slice(0, 2)) {
        const m = statusRight.match(new RegExp(`:(\\d+)->${containerPort}`))
        expect(m).not.toBeNull()
        expect(Number(m![1])).toBeGreaterThanOrEqual(hostPortStart)
      }
    }, 60_000)

    it('forwards HTTP from host to an IPv4-loopback container server', async () => {
      await startHttpServerInContainer(jobName, 8080, '127.0.0.1', 'hello ipv4')
      const res = await httpGet(`http://127.0.0.1:${hostPortFor.get(8080)}/`)
      expect(res.status).toBe(200)
      expect(res.body).toBe('hello ipv4')
    }, 30_000)

    it('forwards HTTP from host to an IPv6-only container server', async () => {
      await startHttpServerInContainer(jobName, 8081, '::1', 'hello ipv6')
      const res = await httpGet(`http://127.0.0.1:${hostPortFor.get(8081)}/`)
      expect(res.status).toBe(200)
      expect(res.body).toBe('hello ipv6')
    }, 30_000)

    it('forwards multiple portForward entries to the same container independently', async () => {
      await startHttpServerInContainer(jobName, 8082, '127.0.0.1', 'first server')
      await startHttpServerInContainer(jobName, 8083, '127.0.0.1', 'second server')

      const [r1, r2] = await Promise.all([
        httpGet(`http://127.0.0.1:${hostPortFor.get(8082)}/`),
        httpGet(`http://127.0.0.1:${hostPortFor.get(8083)}/`),
      ])
      expect(r1.status).toBe(200)
      expect(r1.body).toBe('first server')
      expect(r2.status).toBe(200)
      expect(r2.body).toBe('second server')
    }, 30_000)

    it('surfaces the live forwarders on /worktree/list (feeds the webapp snapshot)', async () => {
      const res = await fetch(`${base}/worktree/list?project=kitchen`, { headers: auth })
      expect(res.status).toBe(200)
      const body = await res.json() as {
        worktrees: Array<{ forwardedPorts: Array<{ containerPort: number; hostPort: number }> }>
      }
      expect(body.worktrees).toHaveLength(1)
      // Same mappings the create stream reported, order-insensitive.
      const got = new Map(body.worktrees[0].forwardedPorts.map((p) => [p.containerPort, p.hostPort]))
      expect(got).toEqual(hostPortFor)
    }, 30_000)

    // The review pane's data. The pod-side script resolves the fork point and
    // snapshots the worktree into an index of its own, so this is the only
    // place the whole path — base resolution, committed + uncommitted staging,
    // the completion marker — runs for real.
    it('reports committed and uncommitted worktree changes on /worktree/:id/changes', async () => {
      await execInJob(jobName, ['sh', '-c',
        'cd /workspace && printf "committed\\n" > committed.txt'
        + ' && git add committed.txt && git -c user.email=t@t -c user.name=t commit -qm "add committed.txt"'
        + ' && printf "working\\n" > untracked.txt'
        + ' && printf "\\nappended\\n" >> README.md',
      ])

      const res = await fetch(`${base}/worktree/${worktreeId}/changes`, { headers: auth })
      expect(res.status).toBe(200)
      const body = await res.json() as {
        base: string
        baseResolved: boolean
        files: Array<{ path: string; status: string; additions: number }>
        diff: string
        truncated: boolean
      }

      // A real fork point was found, so the committed file must be in the diff
      // — collapsing the base to HEAD is what used to make committed work
      // vanish and the pane claim "No changes".
      expect(body.baseResolved).toBe(true)
      expect(body.base).toMatch(/^[0-9a-f]{40}$/)
      const byPath = new Map(body.files.map((f) => [f.path, f]))
      expect(byPath.get('committed.txt')?.status).toBe('added')
      expect(byPath.get('untracked.txt')?.status).toBe('added')
      expect(byPath.get('README.md')?.status).toBe('modified')
      expect(body.diff).toContain('+committed')
      expect(body.diff).toContain('+working')
      expect(body.truncated).toBe(false)

      // The agent's own index and HEAD are untouched by our snapshot: the
      // staged/committed state is exactly what the commit above left.
      const { stdout: porcelain } = await execInJob(jobName, [
        'sh', '-c', 'cd /workspace && git status --porcelain',
      ])
      expect(porcelain).toContain('?? untracked.txt')
      expect(porcelain).toContain(' M README.md')
      expect(porcelain).not.toContain('committed.txt') // committed, not left staged

      // Polling must stay correct across runs — the index is reused, so a
      // second call has to see a subsequent edit rather than a stale snapshot.
      await execInJob(jobName, ['sh', '-c',
        'cd /workspace && rm -f untracked.txt && printf "second\\n" > later.txt',
      ])
      const res2 = await fetch(`${base}/worktree/${worktreeId}/changes`, { headers: auth })
      expect(res2.status).toBe(200)
      const body2 = await res2.json() as { files: Array<{ path: string }> }
      const paths2 = body2.files.map((f) => f.path)
      expect(paths2).toContain('later.txt')
      expect(paths2).toContain('committed.txt')
      expect(paths2).not.toContain('untracked.txt') // deletion picked up

      // Leave the worktree as we found it — later tests read git state.
      await execInJob(jobName, ['sh', '-c',
        'cd /workspace && rm -f later.txt && git checkout -- README.md'
        + ' && git reset -q --hard HEAD~1',
      ])
    }, 60_000)

    it('relay accepts sequential requests while the event loop stays responsive', async () => {
      // Regression: startPortForwarders needs the Node event loop to
      // accept TCP connections. A wedged event loop would let the first
      // request through and silently drop the rest.
      await startHttpServerInContainer(jobName, 8084, '127.0.0.1', 'sequential')
      const hostPort = hostPortFor.get(8084)!
      for (let i = 0; i < 3; i++) {
        const res = await httpGet(`http://127.0.0.1:${hostPort}/`)
        expect(res.status).toBe(200)
        expect(res.body).toBe('sequential')
      }
    }, 30_000)

    // ── Auto-detected unforwarded ports (streamd `ports` push) ──────────
    // Sequenced: detection first (it also pins down the denylist), then the
    // live forward, then persist, then dismiss.

    /** The kitchen session's snapshot row from /worktree/list. */
    async function kitchenSession(): Promise<{
      forwardedPorts: Array<{ containerPort: number; hostPort: number }>
      unforwardedPorts: number[]
    }> {
      const res = await fetch(`${base}/worktree/list?project=kitchen`, { headers: auth })
      expect(res.status).toBe(200)
      const body = await res.json() as {
        worktrees: Array<{
          forwardedPorts: Array<{ containerPort: number; hostPort: number }>
          unforwardedPorts: number[]
        }>
      }
      expect(body.worktrees).toHaveLength(1)
      return body.worktrees[0]
    }

    async function waitForUnforwarded(
      predicate: (ports: number[]) => boolean,
      what: string,
    ): Promise<number[]> {
      let ports: number[] = []
      for (let i = 0; i < 60; i++) {
        ports = (await kitchenSession()).unforwardedPorts
        if (predicate(ports)) return ports
        await sleep(1000)
      }
      throw new Error(`${what} — last unforwardedPorts: [${ports.join(', ')}]`)
    }

    it('detects unforwarded listeners, never surfacing denylisted or forwarded ports', async () => {
      // One ordinary listener plus one on the sensitive-port denylist
      // (9229, node --inspect). Detection rides streamd's in-pod poll →
      // relay push → server map → snapshot, so poll the list endpoint.
      await startHttpServerInContainer(jobName, 8090, '127.0.0.1', 'detected server')
      await startHttpServerInContainer(jobName, 9229, '127.0.0.1', 'sensitive server')

      const unforwarded = await waitForUnforwarded(
        (ports) => ports.includes(8090),
        'listener on 8090 never surfaced in unforwardedPorts',
      )
      // The sensitive listener is up (the helper curled it) but hidden, as
      // is yaac's own in-pod infra (streamd on 10300); the config-declared
      // forwards are subtracted as already forwarded.
      expect(unforwarded).not.toContain(9229)
      expect(unforwarded).not.toContain(10300)
      for (const { containerPort } of PORT_FORWARD) {
        expect(unforwarded).not.toContain(containerPort)
      }
    }, 90_000)

    it('forwards a detected port for this session and serves real traffic', async () => {
      const res = await fetch(`${base}/worktree/${worktreeId}/forward-port`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: 8090 }),
      })
      expect(res.status).toBe(200)
      const mapping = await res.json() as { containerPort: number; hostPort: number }
      expect(mapping.containerPort).toBe(8090)

      const page = await httpGet(`http://127.0.0.1:${mapping.hostPort}/`)
      expect(page.status).toBe(200)
      expect(page.body).toBe('detected server')

      // The snapshot moves the port from unforwarded to forwarded.
      const session = await kitchenSession()
      expect(session.unforwardedPorts).not.toContain(8090)
      expect(session.forwardedPorts).toContainEqual(mapping)

      // Now forwarded → subtracted from the offerable set, so a repeat
      // request is rejected.
      const again = await fetch(`${base}/worktree/${worktreeId}/forward-port`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: 8090 }),
      })
      expect(again.status).toBe(409)
    }, 60_000)

    it('rejects forwarding a port with no detected listener', async () => {
      const res = await fetch(`${base}/worktree/${worktreeId}/forward-port`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: 8099 }),
      })
      expect(res.status).toBe(409)
    }, 30_000)

    it('persists a detected port into the project config and forwards it live', async () => {
      await startHttpServerInContainer(jobName, 8091, '127.0.0.1', 'persisted server')
      await waitForUnforwarded(
        (ports) => ports.includes(8091),
        'listener on 8091 never surfaced in unforwardedPorts',
      )

      const res = await fetch(`${base}/worktree/${worktreeId}/forward-port`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: 8091, persist: true }),
      })
      expect(res.status).toBe(200)
      const mapping = await res.json() as { containerPort: number; hostPort: number }

      const page = await httpGet(`http://127.0.0.1:${mapping.hostPort}/`)
      expect(page.body).toBe('persisted server')

      // The project overlay gained the portForward entry (future sessions
      // inherit it), alongside the create-time entries.
      const configRaw = await fs.readFile(
        path.join(projectPath, 'config', 'yaac-config.json'), 'utf8',
      )
      const config = JSON.parse(configRaw) as {
        portForward: Array<{ containerPort: number; hostPortStart: number }>
      }
      expect(config.portForward).toContainEqual({ containerPort: 8091, hostPortStart: 8091 })
      for (const entry of PORT_FORWARD) {
        expect(config.portForward).toContainEqual(entry)
      }
    }, 90_000)

    it('dismisses a detected port so it stops being offered', async () => {
      await startHttpServerInContainer(jobName, 8092, '127.0.0.1', 'dismissed server')
      await waitForUnforwarded(
        (ports) => ports.includes(8092),
        'listener on 8092 never surfaced in unforwardedPorts',
      )

      const res = await fetch(`${base}/worktree/${worktreeId}/dismiss-port`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: 8092 }),
      })
      expect(res.status).toBe(204)
      expect((await kitchenSession()).unforwardedPorts).not.toContain(8092)

      // A dismissed port is also no longer forwardable.
      const forward = await fetch(`${base}/worktree/${worktreeId}/forward-port`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: 8092 }),
      })
      expect(forward.status).toBe(409)
    }, 90_000)

    it('routes session HTTPS through proxy→redirect→mock with credential injection', async () => {
      // Drive a single HTTPS request from inside the session pod through
      // the proxy: `curl -k` because we don't ship the proxy's CA into the
      // curl invocation (the proxy already installed it into the
      // container's trust store, but `-k` keeps the test deterministic).
      // We send the placeholder x-api-key sentinel that the proxy gates
      // credential injection on — the proxy swaps it for the real value
      // ('sk-ant-fake-real-key') on match. A unique marker in the body
      // distinguishes this probe from any calls the live claude-code makes
      // on its own.
      const marker = `curl-probe-${randomUUID().slice(0, 8)}`
      const { stdout: curlOut, stderr: curlErr } = await execInJob(jobName, [
        'curl', '-sS', '-k',
        '--max-time', '10',
        '-X', 'POST',
        '-H', 'x-api-key: yaac-ph-api-key',
        '-H', 'content-type: application/json',
        '-d', `{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"${marker}"}]}`,
        'https://api.anthropic.com/v1/messages',
      ], { timeout: 20_000 })

      if (!curlOut.includes('Hello from mock')) {
        console.error('curl stdout:\n' + curlOut)
        console.error('curl stderr:\n' + curlErr)
      }
      // The SSE stream carries the mock's text_delta — proves the response
      // reached the container.
      expect(curlOut).toContain('Hello from mock')

      // Mock transcript should show the swapped credential. The container
      // sent the placeholder sentinel; the proxy's dynamic MITM rule
      // (buildDynamicRules, hostname === ANTHROPIC_API_HOST) matches the
      // placeholder and swaps it to the on-disk api-key before forwarding.
      // That's the piece upstream-redirect composes with: MITM + inject +
      // redirect.
      const transcript = await mockLLM!.transcript()
      const probeCall = transcript.find((e) =>
        e.method === 'POST' && e.url.startsWith('/v1/messages') && e.body.includes(marker),
      )
      expect(probeCall).toBeDefined()
      expect(probeCall!.headers['x-api-key']).toBe('sk-ant-fake-real-key')
      expect(probeCall!.body).toContain('claude-sonnet-4-6')
    }, 60_000)

    it('boots claude-code and round-trips a prompt through the mock LLM', async () => {
      // The strongest test of the mocking infrastructure: the real tool,
      // not a curl stand-in. Onboarding was pre-seeded at create time so
      // claude-code lands directly on its chat prompt.
      const send = async (...keys: string[]): Promise<void> => {
        for (const k of keys) {
          await execInJob(jobName, [
            'tmux', '-S', CONTAINER_TMUX_SOCK, 'send-keys',
            '-t', 'yaac:claude', k,
          ])
          await sleep(400)
        }
      }
      const capturePane = async (): Promise<string> => {
        const { stdout } = await execInJob(jobName, [
          'sh', '-c',
          `tmux -S ${CONTAINER_TMUX_SOCK} capture-pane -t yaac:claude -p -S - -E - 2>&1`,
        ])
        return stdout
      }

      await send('hello mock')
      await sleep(500)
      await send('Enter')

      // Poll for claude rendering the mock's response text in its pane.
      // The mock always replies with "Hello from mock!" text_delta. The
      // initial Enter can land while claude-code is still finishing its
      // startup render — the "hello mock" characters always make it into
      // the prompt but the Enter is silently dropped in that window. Re-
      // sending Enter periodically keeps the test deterministic without
      // forcing every run to wait for a worst-case startup.
      let pane = ''
      let hitMockText = false
      for (let i = 0; i < 30; i++) {
        pane = await capturePane()
        if (pane.includes('Hello from mock')) { hitMockText = true; break }
        if (i > 0 && i % 3 === 0) await send('Enter')
        await sleep(500)
      }

      if (!hitMockText) {
        console.error('final pane:\n' + pane)
        const tx = await mockLLM!.transcript()
        console.error('mock transcript (' + tx.length + ' entries):')
        for (const e of tx) {
          const host = typeof e.headers.host === 'string' ? e.headers.host : '?'
          console.error('  ' + e.method + ' ' + host + e.url)
        }
      }
      expect(hitMockText).toBe(true)

      // The mock LLM must have received the /v1/messages call carrying the
      // typed prompt, with the proxy swapping the placeholder x-api-key for
      // the on-disk credential.
      const transcript = await mockLLM!.transcript()
      const promptCall = transcript.find((e) =>
        e.method === 'POST' && e.url.startsWith('/v1/messages') && e.body.includes('hello mock'),
      )
      expect(promptCall).toBeDefined()
      expect(promptCall!.headers['x-api-key']).toBe('sk-ant-fake-real-key')
    }, 120_000)

    it('writes a command over the PTY WebSocket and reads its output back', async () => {
      // The webapp's terminal path: create a scratch-shell window (the
      // webapp's "+" path), attach it over the WS, round-trip a command.
      // A shell window needs no agent auth — just the container and tmux.
      const createRes = await fetch(
        `${base}/worktree/${worktreeId}/terminals`,
        { method: 'POST', headers: auth },
      )
      expect(createRes.ok).toBe(true)
      const shell = await createRes.json() as { target: string; name: string }
      expect(shell.name).toBe('shell')
      expect(shell.target).toMatch(/^window:@\d+$/)
      const { ws, binary, opened } = openWs(
        `ws://127.0.0.1:${server!.lock.port}/pty/attach`
          + `?id=${worktreeId}&target=${encodeURIComponent(shell.target)}&cols=100&rows=30`,
        auth,
      )
      await opened
      await sleep(3000) // let the shell start and paint its prompt
      ws.send(Buffer.from('echo WS_ROUNDTRIP_$((40 + 2))\r'))
      for (let i = 0; i < 30 && !binary().includes('WS_ROUNDTRIP_42'); i++) await sleep(500)
      ws.close()
      expect(binary()).toContain('WS_ROUNDTRIP_42')

      // target=native — the CLI's `session attach` transport. Prefix keys
      // must be live (view sessions set `prefix None`, native must not):
      // C-b d detaches the grouped client, which exits the container-side
      // tmux client, ends the PTY, and closes the socket server-side.
      const native = openWs(
        `ws://127.0.0.1:${server!.lock.port}/pty/attach`
          + `?id=${worktreeId}&target=native&cols=100&rows=30`,
        auth,
      )
      const nativeClosed = new Promise<void>((resolve) => native.ws.on('close', () => resolve()))
      await native.opened
      for (let i = 0; i < 30 && native.binary().length === 0; i++) await sleep(500)
      expect(native.binary().length).toBeGreaterThan(0)
      native.ws.send(Buffer.from('\x02d')) // C-b d
      await Promise.race([
        nativeClosed,
        sleep(15_000).then(() => { throw new Error('C-b d did not close the native attach') }),
      ])

      // target=shell — the CLI's `session shell` transport: a raw zsh, no
      // tmux. `exit` ends the shell and closes the socket.
      const rawShell = openWs(
        `ws://127.0.0.1:${server!.lock.port}/pty/attach`
          + `?id=${worktreeId}&target=shell&cols=100&rows=30`,
        auth,
      )
      const shellClosed = new Promise<void>((resolve) => rawShell.ws.on('close', () => resolve()))
      await rawShell.opened
      await sleep(3000)
      rawShell.ws.send(Buffer.from('echo RAW_SHELL_$((20 + 3))\r'))
      for (let i = 0; i < 30 && !rawShell.binary().includes('RAW_SHELL_23'); i++) await sleep(500)
      expect(rawShell.binary()).toContain('RAW_SHELL_23')
      rawShell.ws.send(Buffer.from('exit\r'))
      await Promise.race([
        shellClosed,
        sleep(15_000).then(() => { throw new Error('exit did not close the raw shell attach') }),
      ])
    }, 120_000)

    it.skipIf(IS_NESTED_YAAC)('holds its streams with zero kubectl execs into session pods', async () => {
      // The stream relay's measurable claim: in steady state — status
      // watcher stream live, forward listeners registered, terminals just
      // exercised — the server holds NO kubectl exec into any session pod.
      // The long-lived `kubectl port-forward` children and the control
      // API's socat execs into the PROXY deployment are expected and
      // excluded by the job/ filter. (Skipped nested: the inner server dials
      // the inner proxy's pod IP — no port-forward child — and the base
      // image has no ps.)
      const { stdout } = await execFileAsync('ps', ['-A', '-o', 'ppid=,command='])
      const serverPid = String(server!.lock.pid)
      const children = stdout.split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith(`${serverPid} `))
      const sessionPodExecs = children.filter(
        (l) => /kubectl\s+exec\b/.test(l) && l.includes('job/'),
      )
      expect(sessionPodExecs).toEqual([])
      // Two forwards, one per purpose — #runtime/k8s/substrate's port-forward keeps
      // exactly one child per key, single-flighted: the relay's into the
      // proxy, and the image registry's into its Deployment (the server's
      // only route to it, spawned on the first push of this run). Matching
      // the TARGETS rather than counting is what makes this catch a leak: a
      // second child for either purpose is the failure worth naming, and a
      // bare count would also fail for a forward that legitimately does not
      // exist yet.
      const forwards = children.filter((l) => /kubectl\s+port-forward\b/.test(l))
      expect(forwards.filter((l) => /deploy\/yaac-proxy\b/.test(l))).toHaveLength(1)
      expect(forwards.filter((l) => /deploy\/yaac-registry\b/.test(l))).toHaveLength(1)
      expect(forwards).toHaveLength(2)
    })

    it.skipIf(IS_NESTED_YAAC)('locks streamd ingress to the proxy (session ingress lock policy)', async () => {
      const ns = k8sNamespace()
      const { stdout: ipOut } = await kubectlWithRetry([
        'get', 'pods', '-n', ns, '-l', `yaac.session-id=${worktreeId}`,
        '-o', 'jsonpath={.items[0].status.podIP}',
      ])
      const podIp = ipOut.trim()
      expect(podIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/)

      // Positive control: the proxy CAN dial streamd — proves the daemon is
      // up and the lock's allow rule admits proxy-identity traffic (so the
      // negative below measures the policy, not a dead daemon).
      const dialScript =
        `const s=require('net').connect(10300,'${podIp}');`
        + "s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});"
        + "s.on('error',(e)=>{console.log('ERR:'+e.code);process.exit(1)});"
        + "setTimeout(()=>{console.log('TIMEOUT');process.exit(1)},5000);"
      const { stdout: fromProxy } = await kubectlWithRetry([
        'exec', '-n', ns, 'deploy/yaac-proxy', '--', 'node', '-e', dialScript,
      ], { timeout: 30_000 })
      expect(fromProxy).toContain('CONNECTED')

      // Negative: a non-proxy pod dialing streamd is default-denied by the
      // session ingress lock (its SYN is dropped — nc times out). The probe
      // runs the session image (guaranteed present on the node, has nc).
      const { stdout: imgOut } = await kubectlWithRetry([
        'get', 'pods', '-n', ns, '-l', `yaac.session-id=${worktreeId}`,
        '-o', 'jsonpath={.items[0].spec.containers[0].image}',
      ])
      const probeName = `streamd-lock-probe-${randomUUID().slice(0, 8)}`
      try {
        const { stdout: probeOut } = await kubectlWithRetry([
          'run', probeName, '-n', ns, `--image=${imgOut.trim()}`,
          '--restart=Never', '--attach', '--rm', '--command', '--',
          'sh', '-c', `nc -w 5 ${podIp} 10300 </dev/null && echo STREAMD_OPEN || echo STREAMD_BLOCKED`,
        ], { timeout: 120_000 })
        expect(probeOut).toContain('STREAMD_BLOCKED')
        expect(probeOut).not.toContain('STREAMD_OPEN')
      } finally {
        await kubectlWithRetry([
          'delete', 'pod', probeName, '-n', ns, '--ignore-not-found', '--wait=false',
        ]).catch(() => { /* --rm usually got it */ })
      }
    }, 180_000)

    it('pushes pane-title flips into session list, sticky across a watcher stream kill', async () => {
      // The push-fed status path: the server holds a tmux control-mode
      // watcher per session (status-watcher.ts) subscribed to the agent
      // pane's `#{pane_title}`, and `session list` reads the watcher-fed
      // store — no per-list status probes. The test controls the pane title
      // directly (`tmux select-pane -T`) instead of driving the real agent:
      // what's under test is yaac's title→status plumbing, not claude's
      // title behavior (pinned by the classifyClaudeTitle unit fixtures).
      //
      // NOTE: this replaces claude with an inert placeholder, so it must run
      // after the round-trip tests above.
      //
      // The placeholder must NOT be `sleep`: `yaac:claude` is the window
      // `new-session` opened, i.e. `yaac:^`, and the stale-reaper's
      // half-provisioned sweep (probeAgentPaneState) reads that window's
      // `pane_current_command` and reaps any session still sitting on the
      // `sleep infinity` create-time placeholder. A `sleep` here is
      // indistinguishable from that, so the reaper deletes the Job mid-test
      // (every later exec then 404s) unless a probe happened to memoize
      // `started` first — a race against the background loop. `tail` reads
      // as a started agent and is just as inert.
      await execInJob(jobName, [
        'tmux', '-S', CONTAINER_TMUX_SOCK, 'set-option', '-t', 'yaac', 'remain-on-exit', 'on',
      ])
      await execInJob(jobName, [
        'tmux', '-S', CONTAINER_TMUX_SOCK, 'respawn-window', '-k', '-t', 'yaac:claude', 'tail -f /dev/null',
      ])

      const setTitle = (title: string): Promise<{ stdout: string }> => execInJob(jobName, [
        'tmux', '-S', CONTAINER_TMUX_SOCK, 'select-pane', '-t', 'yaac:claude.0', '-T', title,
      ])
      const waitForListStatus = async (
        expected: 'running' | 'waiting',
        timeoutMs: number,
      ): Promise<void> => {
        const deadline = Date.now() + timeoutMs
        let lastOut = ''
        for (;;) {
          const { stdout } = await runYaac(serverEnv, 'worktree', 'list', 'kitchen')
          lastOut = stdout
          const row = stdout.split('\n').find((l) => l.includes('kitchen') && !l.startsWith('WORKTREE'))
          if (row?.includes(expected)) return
          if (Date.now() > deadline) {
            throw new Error(`status never became ${expected} within ${timeoutMs}ms; last list:\n${lastOut}`)
          }
          await sleep(500)
        }
      }

      // Baseline: an idle-style title classifies as waiting.
      await setTitle('✳ marker-idle')
      await waitForListStatus('waiting', 20_000)

      // A Braille-spinner title must flip the list to running with no
      // probe in the path: title → tmux ~1s subscription check → watcher →
      // status store → list read.
      await setTitle('⠋ marker-busy')
      await waitForListStatus('running', 20_000)

      // Kill the watcher's stream at its IN-POD end (the tmux control-mode
      // client streamd spawned — there is no host-side kubectl child per
      // stream anymore). Status must stay sticky (never blank / never
      // reaped), and the watcher must respawn on its own — proven by the
      // next title flip still landing.
      await execInJob(jobName, ['pkill', '-f', 'tmux.*-C attach-session'])
      const { stdout: afterKill } = await runYaac(serverEnv, 'worktree', 'list', 'kitchen')
      const row = afterKill.split('\n').find((l) => l.includes('kitchen') && !l.startsWith('WORKTREE'))
      expect(row).toBeDefined()
      expect(row).toContain('running')

      await setTitle('✳ marker-done')
      await waitForListStatus('waiting', 30_000)
    }, 240_000)

    it('redirects /workspace/node_modules through .cached-packages and cleans up on delete', async () => {
      // LAST kitchen test: it deletes the session.
      // Inside the container: /workspace/node_modules is a real directory
      // backed by a bind mount — not a symlink (Node's fs.mkdir would
      // reject a symlink-to-dir with ENOTDIR, breaking pnpm).
      await expect(execInJob(jobName, [
        'readlink', '/workspace/node_modules',
      ])).rejects.toThrow()
      const { stdout: ftype } = await execInJob(jobName, [
        'stat', '-c', '%F', '/workspace/node_modules',
      ])
      expect(ftype.trim()).toBe('directory')

      // Write to the bind mount and confirm the bytes land in the
      // host-side .cached-packages tree, NOT in the worktree.
      await execInJob(jobName, [
        'sh', '-c',
        'echo hello > /workspace/node_modules/marker.txt',
      ])
      const hostBacking = path.join(
        projectPath, '.cached-packages', 'modules', worktreeId, 'root', 'marker.txt',
      )
      const hostMarker = await fs.readFile(hostBacking, 'utf8')
      expect(hostMarker.trim()).toBe('hello')

      // Host worktree's node_modules has no leaked content — the bind
      // mount shadows it from the container side only.
      const worktreeMarker = path.join(
        projectPath, 'worktrees', worktreeId, 'node_modules', 'marker.txt',
      )
      await expect(fs.access(worktreeMarker)).rejects.toThrow()

      // The nested redirect works the same way, and its mount TARGET is a
      // dir on the host worktree that exists before `git worktree add`
      // runs — which git refuses to check out into unless the add is
      // staged. Both are asserted here: the checkout populated the tracked
      // parent around the mount point, and the mount itself is live.
      const wtDir = path.join(projectPath, 'worktrees', worktreeId)
      expect(await fs.readFile(path.join(wtDir, 'frontends', 'app.txt'), 'utf8')).toBe('app\n')
      await execInJob(jobName, [
        'sh', '-c', 'echo nested > /workspace/frontends/node_modules/marker.txt',
      ])
      const nestedBacking = await fs.readFile(path.join(
        projectPath, '.cached-packages', 'modules', worktreeId,
        'frontends_node_modules', 'marker.txt',
      ), 'utf8')
      expect(nestedBacking.trim()).toBe('nested')
      await expect(
        fs.access(path.join(wtDir, 'frontends', 'node_modules', 'marker.txt')),
      ).rejects.toThrow()

      // node_modules is gitignored (via the seeded .gitignore), so a
      // populated bind mount doesn't surface in `git status`.
      const { stdout: gitStatus } = await execInJob(jobName, [
        'sh', '-c', 'cd /workspace && git status --porcelain',
      ])
      expect(gitStatus.trim()).toBe('')

      // Seed the pnpm-store so the post-delete assertion below can verify
      // that modules/<sid> is reaped while the shared store survives.
      await execInJob(jobName, [
        'sh', '-c',
        'mkdir -p /home/yaac/.cached-packages/pnpm-store && echo store-content > /home/yaac/.cached-packages/pnpm-store/src',
      ])

      // Delete the session; modules/<sid> goes away, pnpm-store survives.
      const { exitCode: delExit } = await runYaac(
        serverEnv, 'worktree', 'stop', worktreeId,
      )
      expect(delExit).toBe(0)

      const modulesRoot = path.join(projectPath, '.cached-packages', 'modules', worktreeId)
      // Cleanup is detached — poll briefly.
      let gone = false
      for (let i = 0; i < 40; i++) {
        try {
          await fs.access(modulesRoot)
          await sleep(250)
        } catch {
          gone = true
          break
        }
      }
      expect(gone).toBe(true)

      const pnpmStoreSrc = path.join(projectPath, '.cached-packages', 'pnpm-store', 'src')
      await expect(fs.access(pnpmStoreSrc)).resolves.toBeUndefined()
    }, 120_000)
  })

  describe('provisioning hand-off + ephemeralModulesPaths []', () => {
    it('a webapp create with a client id yields a real session of that id, and the provisioning row drops on hand-off', async () => {
      // Doubles as the ephemeralModulesPaths:[] coverage — the project
      // disables the node_modules redirect and we assert on the created pod
      // after the hand-off completes.
      await setupProject('no-ephemeral', {
        yaacConfig: { ephemeralModulesPaths: [] },
      })
      const worktreeId = randomUUID()

      // Watch the snapshot stream while the create runs.
      const sub = collectSnapshots(server!.lock.port, server!.lock.secret)
      await sub.opened

      // Fire the webapp create (don't await — we want to observe the in-flight row).
      const createDone = fetch(`${base}/worktree/create`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'no-ephemeral', tool: 'claude', worktreeId }),
      }).then((r) => r.text())

      // The provisioning row appears in the snapshot during creation.
      let sawProvisioning = false
      for (let i = 0; i < 100; i++) {
        const row = sub.latest()?.provisioning.find((p) => p.worktreeId === worktreeId)
        if (row) {
          expect(row.kind).toBe('create')
          expect(row.projectSlug).toBe('no-ephemeral')
          sawProvisioning = true
          break
        }
        await sleep(200)
      }
      expect(sawProvisioning).toBe(true)

      // Creation completes successfully (NDJSON ends with a result, not an error).
      const ndjson = await createDone
      expect(ndjson).toContain('"type":"result"')
      expect(ndjson).not.toContain('"type":"error"')

      // The real session exists under the SAME client-supplied id...
      const list = await (await fetch(`${base}/worktree/list?project=no-ephemeral`, { headers: auth })).json() as
        { worktrees: Array<{ worktreeId: string }> }
      expect(list.worktrees.some((s) => s.worktreeId === worktreeId)).toBe(true)

      // ...and the provisioning row drops on hand-off (the create route
      // removes it when createWorktree resolves; until then buildSnapshot
      // hides the session so no snapshot ever carries both — no double row,
      // and no terminals mounted against a half-built session).
      let droppedFromProvisioning = false
      for (let i = 0; i < 100; i++) {
        const snap = sub.latest()
        if (snap && snap.worktrees.some((s) => s.worktreeId === worktreeId)
          && !snap.provisioning.some((p) => p.worktreeId === worktreeId)) {
          droppedFromProvisioning = true
          break
        }
        await sleep(200)
      }
      expect(droppedFromProvisioning).toBe(true)
      sub.ws.close()

      // /workspace/node_modules should not exist at all when the redirect
      // is disabled — the worktree is a fresh git checkout with no
      // node_modules in it and no bind mount is installed.
      const pod = await findWorktreePod('no-ephemeral')
      await expect(execInJob(pod.jobName, [
        'test', '-e', '/workspace/node_modules',
      ])).rejects.toThrow()
    }, 240_000)
  })

  describe('codex session', () => {
    let jobName = ''

    beforeAll(async () => {
      const projectPath = await setupProject('codex-demo')
      // The codex host dir drives session-create down the
      // writeProjectCodexPlaceholder path, which seeds a ChatGPT-mode
      // auth.json that codex can load without running its native login
      // flow. `/repo` (not `/workspace`) is the key codex sees because the
      // session worktree's .git file points at /repo/.git.
      await fs.mkdir(path.join(projectPath, 'codex'), { recursive: true })
      const created = await createWorktree('codex-demo', '--tool', 'codex')
      jobName = created.jobName
    }, 240_000)

    it('mounts shared Claude and Codex state', async () => {
      const pod = await findWorktreePod('codex-demo')
      expect(pod.labels['yaac.tool']).toBe('codex')
      await execInJob(jobName, ['test', '-d', '/home/yaac/.claude'])
      await execInJob(jobName, ['test', '-f', '/home/yaac/.claude.json'])
      await execInJob(jobName, ['test', '-d', '/home/yaac/.codex'])
    }, 60_000)

    it('boots codex-cli and round-trips a prompt through the mock LLM', async () => {
      // Codex-specific paths: the ChatGPT-shaped `auth.json` placeholder,
      // the `Authorization: Bearer` swap on `chatgpt.com`, and the
      // Responses-API SSE shape.
      //
      // No warm-up sleep before the dispatch loop below: it already polls
      // the pane for whichever state codex is in — including "nothing
      // rendered yet" — so a blind wait only ever cost time.
      const send = async (...keys: string[]): Promise<void> => {
        for (const k of keys) {
          await execInJob(jobName, [
            'tmux', '-S', CONTAINER_TMUX_SOCK, 'send-keys',
            '-t', 'yaac:codex', k,
          ])
          await sleep(400)
        }
      }
      // Capture only the visible window, not scrollback history. Dismissed
      // dialogs stay visible in scrollback and would otherwise cause the
      // dispatch loop to keep matching them.
      const capturePane = async (): Promise<string> => {
        try {
          const { stdout } = await execInJob(jobName, [
            'sh', '-c',
            `tmux -S ${CONTAINER_TMUX_SOCK} capture-pane -t yaac:codex -p 2>&1`,
          ])
          return stdout
        } catch (err) {
          return '[capture failed: ' + (err instanceof Error ? err.message : String(err)) + ']'
        }
      }
      // Codex greets new sessions with modal prompts we need to dismiss
      // before the chat composer is reachable:
      //   1. "Do you trust the contents of this directory?" — accept default
      //      (Yes, continue) with Enter.
      //   2. "Hooks need review" — pick "Trust all and continue" (option 2).
      //   3. "Introducing GPT-5.4 … 1. Try new model, 2. Use existing model"
      //      — Down + Enter ("Use existing model") so the test isn't coupled
      //      to a specific default model name in the mock.
      // Dialogs render synchronously after codex's startup HTTP probes, but
      // we don't know which is on screen at a given moment, so watch the
      // pane and dispatch until the chat-composer prompt appears.
      let sawTrust = false
      let sawUpgrade = false
      let sawHooks = false
      let inChat = false
      let lastPane = ''
      for (let i = 0; i < 60 && !inChat; i++) {
        lastPane = await capturePane()
        if (/Do you trust the contents of this directory/i.test(lastPane)) {
          if (!sawTrust) {
            await send('Enter')
            sawTrust = true
          }
        } else if (/Hooks need review|Trust all and continue/i.test(lastPane)) {
          if (!sawHooks) {
            await send('Down', 'Enter')
            sawHooks = true
          }
        } else if (/Introducing GPT|Try new model|Use existing model/i.test(lastPane)) {
          if (!sawUpgrade) {
            await send('Down', 'Enter')
            sawUpgrade = true
          }
        } else if (/OpenAI Codex|gpt-5|YOLO mode/i.test(lastPane)) {
          inChat = true
          break
        }
        await sleep(500)
      }
      if (!inChat) {
        console.error('chat composer never appeared (trust=' + sawTrust + ', hooks=' + sawHooks + ', upgrade=' + sawUpgrade + ')')
        console.error('final pane:\n' + lastPane)
      }
      expect(inChat).toBe(true)
      // Let the chat UI fully render.
      await sleep(1000)

      await send('hello mock')
      await sleep(500)
      await send('Enter')

      // Poll for codex rendering the mock's response text in its pane.
      let pane = ''
      let hitMockText = false
      for (let i = 0; i < 30; i++) {
        pane = await capturePane()
        if (pane.includes('Hello from mock')) { hitMockText = true; break }
        await sleep(500)
      }

      if (!hitMockText) {
        console.error('final pane:\n' + pane)
        const tx = await mockLLM!.transcript()
        console.error('mock transcript (' + tx.length + ' entries):')
        for (const e of tx) {
          const host = typeof e.headers.host === 'string' ? e.headers.host : '?'
          console.error('  ' + e.method + ' ' + host + e.url)
        }
      }
      expect(hitMockText).toBe(true)

      // The mock must have received the Responses-API call carrying the
      // typed prompt, and the proxy must have swapped the placeholder
      // Bearer for the real on-disk token.
      const transcript = await mockLLM!.transcript()
      const promptCall = transcript.find((e) =>
        e.method === 'POST' && e.url.startsWith('/backend-api/codex/responses')
        && e.body.includes('hello mock'),
      )
      expect(promptCall).toBeDefined()
      const authHeader = promptCall!.headers['authorization']
      const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader
      expect(authStr).toBe('Bearer ' + CODEX_REAL_ACCESS_TOKEN)
    }, 180_000)
  })

  describe('opencode session', () => {
    let jobName = ''
    let projectPath = ''

    beforeAll(async () => {
      projectPath = await setupProject('oc-demo')
      const created = await createWorktree('oc-demo', '--tool', 'opencode')
      jobName = created.jobName
    }, 240_000)

    it('boots opencode and exposes its HTTP API on 127.0.0.1:4096 inside the container', async () => {
      // The yaac status + first-message helpers in
      // packages/server/src/features/agents/opencode.ts depend on these endpoints being
      // reachable via `kubectl exec curl` — without this test the entire
      // opencode status pipeline is unverified by CI.
      //
      // Poll the in-container HTTP server. opencode bootstraps the worker +
      // SQLite migrations before binding, so allow generous time. -sf
      // suppresses output on connect-refused. This also doubles as a
      // wait-for-container-ready barrier — by the time the probe answers,
      // the tmux session and `opencode` window must be set up.
      let probeOk = false
      let lastStdout = ''
      let lastStderr = ''
      for (let i = 0; i < 60 && !probeOk; i++) {
        try {
          const { stdout } = await execInJob(jobName, [
            'sh', '-c',
            'curl -sf -o /dev/stdout -w "\\n%{http_code}" http://127.0.0.1:4096/session 2>&1',
          ])
          lastStdout = stdout
          // Expect a 200 status code on the trailing line and a JSON-array
          // body (empty array is fine — no user turn has been sent yet).
          const trimmed = stdout.trim()
          const lastNewline = trimmed.lastIndexOf('\n')
          const body = lastNewline >= 0 ? trimmed.slice(0, lastNewline) : ''
          const code = lastNewline >= 0 ? trimmed.slice(lastNewline + 1) : trimmed
          if (code === '200') {
            const parsed: unknown = JSON.parse(body || '[]')
            expect(Array.isArray(parsed)).toBe(true)
            probeOk = true
            break
          }
        } catch (err) {
          lastStderr = err instanceof Error ? err.message : String(err)
        }
        await sleep(1000)
      }

      if (!probeOk) {
        // Diagnostic dump before failing — the most common causes are
        // opencode crashing at startup (TUI couldn't init, missing native
        // module, etc.) or the wrong package name in Dockerfile.default.
        try {
          const { stdout: pane } = await execInJob(jobName, [
            'tmux', 'capture-pane', '-p', '-t', 'yaac:opencode',
          ])
          console.error('opencode tmux pane:\n' + pane)
        } catch { /* ignore */ }
        try {
          const { stdout: ps } = await execInJob(jobName, [
            'sh', '-c', 'ps -ef | grep -i opencode | grep -v grep',
          ])
          console.error('opencode processes:\n' + ps)
        } catch { /* ignore */ }
        console.error('last curl stdout: ' + lastStdout)
        console.error('last curl stderr: ' + lastStderr)
      }
      expect(probeOk).toBe(true)

      // `/session` above is the load-bearing endpoint: it is what the
      // server's opencode first-message probe (runProbe in
      // features/agents/opencode.ts) parses; busy/idle status
      // comes from the tmux pane, not HTTP. `/session/status` is probed
      // only as a liveness signal — its SHAPE is version-dependent (the
      // pinned 1.0.142 returns an array; later releases an object), so
      // assert just that it answers parseable JSON.
      const { stdout: statusOut } = await execInJob(jobName, [
        'sh', '-c',
        'curl -sf http://127.0.0.1:4096/session/status',
      ])
      expect(() => { JSON.parse(statusOut.trim()) }).not.toThrow()
    }, 180_000)

    it('mounts the shared opencode-config dir with websearch + provider wiring', async () => {
      // The shared opencode-config directory persists across sessions so
      // that model selection, permissions, and other settings written to
      // ~/.config/opencode/opencode.json via Config.updateGlobal() survive
      // pod teardown.
      const hostOcConfigDir = path.join(projectPath, 'opencode-config')
      const hostConfigStat = await fs.stat(hostOcConfigDir)
      expect(hostConfigStat.isDirectory()).toBe(true)

      // Websearch wiring: yaac seeds `permission.websearch` into the shared
      // opencode.json and sets the env var gating the Exa-backed tool
      // registration. The pinned opencode 1.0.142 PREDATES websearch: it
      // normalizes opencode.json at boot and drops the (to it) unknown
      // permission key, so the file's content cannot be asserted here —
      // only that the shared file survives as valid JSON. The env wiring
      // below is forward-compat and takes effect when the pin moves past
      // the gVisor renderer bug (see dockerfiles/Dockerfile.tools).
      const seededRaw = await fs.readFile(
        path.join(hostOcConfigDir, 'opencode.json'),
        'utf8',
      )
      expect(() => { JSON.parse(seededRaw) }).not.toThrow()

      const { stdout: envOut } = await execInJob(jobName, [
        'sh', '-c', 'printenv OPENCODE_ENABLE_EXA',
      ])
      expect(envOut.trim()).toBe('true')

      // opencode is pinned to the last release whose TUI renders under gVisor;
      // this env var stops it from self-upgrading past that pin on launch (a
      // newer opencode leaves the agent pane blank — its native renderer never
      // draws in the headless session tmux).
      const { stdout: autoUpdOut } = await execInJob(jobName, [
        'sh', '-c', 'printenv OPENCODE_DISABLE_AUTOUPDATE',
      ])
      expect(autoUpdOut.trim()).toBe('1')

      // The seeded opencode credential names OpenRouter, so the container
      // carries the OPENROUTER_API_KEY placeholder (the proxy swaps it for
      // the real key on openrouter.ai) and not the NeuralWatt one — the env
      // var is the credential's provider, never a fixed name.
      const { stdout: orKeyOut } = await execInJob(jobName, [
        'sh', '-c', 'printenv OPENROUTER_API_KEY',
      ])
      expect(orKeyOut.trim()).toBe('yaac-ph-api-key')
      const { stdout: nwKeyOut } = await execInJob(jobName, [
        'sh', '-c', 'printenv NEURALWATT_API_KEY || true',
      ])
      expect(nwKeyOut.trim()).toBe('')

      // Write a config on the host and verify it's visible inside the container.
      await fs.writeFile(
        path.join(hostOcConfigDir, 'opencode.json'),
        JSON.stringify({ model: 'anthropic/claude-sonnet-4-5' }),
      )
      const { stdout: catOut } = await execInJob(jobName, [
        'cat', '/home/yaac/.config/opencode/opencode.json',
      ])
      const inside: unknown = JSON.parse(catOut.trim())
      expect(inside).toEqual({ model: 'anthropic/claude-sonnet-4-5' })
    }, 60_000)
  })

  /**
   * --prompt, --model and the configured referenceBranch on ONE session.
   * The three are orthogonal create-time knobs whose assertions read
   * different surfaces of the same pod (the agent pane, the window's
   * start command, the worktree's upstream), so a session apiece bought
   * nothing but two more pod bring-ups.
   */
  describe('create-time overrides (--prompt, --model, referenceBranch)', () => {
    const SLUG = 'overridden'
    let jobName = ''
    let createStdout = ''
    const marker = 'summarize the pinned issues'

    beforeAll(async () => {
      const projectPath = await setupProject(SLUG, {
        yaacConfig: { referenceBranch: 'dev' },
        extraBranches: { dev: { 'dev-only.txt': 'dev content\n' } },
      })
      // Pre-seed claude's onboarding state (same as the kitchen-sink
      // session) so the TUI lands directly on its chat prompt — a
      // headless create has no user to click through wizards.
      await fs.writeFile(path.join(projectPath, 'claude.json'), JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: '2.1.116',
        customApiKeyResponses: { approved: ['yaac-ph-api-key'], rejected: [] },
        projects: {
          '/repo': { hasTrustDialogAccepted: true },
          '/workspace': { hasTrustDialogAccepted: true },
        },
      }) + '\n')
      await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
      await fs.writeFile(path.join(projectPath, 'claude', 'settings.json'), JSON.stringify({
        skipDangerousModePermissionPrompt: true,
      }) + '\n')

      const created = await createWorktree(
        SLUG, '--tool', 'claude', '--prompt', marker, '--model', 'claude-opus-4-8',
      )
      jobName = created.jobName
      createStdout = created.stdout
    }, 240_000)

    it('types the prompt into the agent pane and submits it, no attach needed', async () => {
      // The prompt is pasted + submitted server-side (buildPromptPasteCmd)
      // with nobody attached; claude sends it to the (mock) LLM, whose
      // reply rendering in the pane proves the full type-and-submit path.
      let pane = ''
      let ok = false
      for (let i = 0; i < 60; i++) {
        const { stdout } = await execInJob(jobName, [
          'sh', '-c',
          `tmux -S ${CONTAINER_TMUX_SOCK} capture-pane -t yaac:claude -p -S - -E - 2>&1`,
        ])
        pane = stdout
        if (pane.includes(marker) && pane.includes('Hello from mock')) { ok = true; break }
        await sleep(1000)
      }
      if (!ok) console.error('final pane:\n' + pane)
      expect(ok).toBe(true)
    }, 240_000)

    it('launches claude with the requested --model', async () => {
      // The agent window's launch command carries the override — the flag
      // claude was actually started with, whatever the TUI renders.
      const { stdout: startCmd } = await execInJob(jobName, [
        'sh', '-c',
        `tmux -S ${CONTAINER_TMUX_SOCK} display -p -t yaac:claude "#{pane_start_command}"`,
      ])
      expect(startCmd).toContain('claude --dangerously-skip-permissions --model claude-opus-4-8')
    }, 60_000)

    it('lands on the configured referenceBranch and tracks it', async () => {
      // The --branch override's happy path (on a prewarmed claim) lives in
      // worktree-prewarm.test.ts; this is the config-default path on a
      // cold create.
      expect(createStdout).toContain('Creating worktree from dev...')

      const { stdout: upstream } = await execInJob(jobName, [
        'git', '-C', '/workspace', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}',
      ])
      expect(upstream.trim()).toBe('origin/dev')
      const { stdout: devFile } = await execInJob(jobName, ['cat', '/workspace/dev-only.txt'])
      expect(devFile).toBe('dev content\n')
    }, 60_000)

    it('--branch rejects a branch missing from origin, leaving no pod and no checkout', async () => {
      // The create stages its worktree dir (and the ephemeral mount points
      // inside it) before provisioning starts, so a create that dies this
      // late has something on disk to collect. Its row is rolled back with
      // it, and every sweep that could name a leftover works from rows — so
      // whatever survives here survives forever. Counted rather than named
      // because the CLI mints the id server-side.
      const worktreesRoot = path.join(testEnv.dataDir, 'projects', SLUG, 'worktrees')
      const adminRoot = path.join(testEnv.dataDir, 'projects', SLUG, 'repo', '.git', 'worktrees')
      const ls = async (dir: string): Promise<string[]> =>
        (await fs.readdir(dir).catch((): string[] => [])).sort()
      const [checkoutsBefore, adminBefore] = [await ls(worktreesRoot), await ls(adminRoot)]
      const podsBefore = (await listWorktreePods(SLUG)).length

      const bad = await runYaac(serverEnv, 'worktree', 'create', SLUG, '--branch', 'ghost')
      expect(bad.exitCode).not.toBe(0)
      expect(bad.stdout + bad.stderr).toContain('branch "ghost" not found on origin')
      expect((await listWorktreePods(SLUG)).length).toBe(podsBefore)

      // Polled, not asserted outright: the removal is chained off the
      // checkout leg settling rather than run inline, so that a create whose
      // leg is still mid-fetch can't have a full checkout staged *after* the
      // rm. Here that leg is the very thing that failed, so this settles at
      // once — the poll is for the ordering, not for slowness.
      for (let i = 0; i < 50 && (await ls(worktreesRoot)).length > checkoutsBefore.length; i++) {
        await sleep(100)
      }
      expect(await ls(worktreesRoot)).toEqual(checkoutsBefore)
      expect(await ls(adminRoot)).toEqual(adminBefore)
    }, 60_000)
  })
  describe('agent mode (--mode acp)', () => {
    const SLUG = 'acped'
    let jobName = ''
    let worktreeId = ''
    let agentSessionId = ''

    // Its own session, unlike the describes above: an ACP worktree is a
    // different pod (a different launch command and a different pod label),
    // so no shared TUI fixture can stand in for it. One create for the whole
    // block, and both cases below only read it.
    beforeAll(async () => {
      await setupProject(SLUG)
      const created = await createWorktree(SLUG, '--tool', 'claude', '--mode', 'acp')
      jobName = created.jobName
      worktreeId = (await findWorktreePod(SLUG)).worktreeId

      // The ACP handshake mints the conversation id, and the registry records
      // it — ACP mode's replacement for the in-pod hook and its log, so
      // this is also the proof that replacement works.
      for (let i = 0; i < 120 && agentSessionId === ''; i++) {
        const res = await fetch(`${base}/worktree/list?project=${SLUG}`, { headers: auth })
        const body = await res.json() as {
          worktrees: Array<{
            worktreeId: string
            agentSessions: Array<{ agentSessionId: string; mode?: string }>
          }>
        }
        agentSessionId = body.worktrees
          .find((w) => w.worktreeId === worktreeId)
          ?.agentSessions.find((a) => a.mode === 'acp')?.agentSessionId ?? ''
        if (agentSessionId === '') await sleep(1000)
      }
    }, 300_000)

    it('runs the agent under acpd, not a TUI, with its socket in the pod', async () => {
      // tmux still supervises the agent — that is what lets a dropped
      // connection (or a restarted server) leave a running turn alone. Only
      // the window's command differs from a TUI session's.
      const { stdout: startCmd } = await execInJob(jobName, [
        'sh', '-c',
        `tmux -S ${CONTAINER_TMUX_SOCK} display -p -t yaac:claude "#{pane_start_command}"`,
      ])
      expect(startCmd).toContain('/opt/yaac/acpd/main.js')
      expect(startCmd).toContain('claude-agent-acp')

      // A UNIX socket rather than a port, so the conversation's endpoint never
      // lands in the auto-forward port scan.
      const { stdout: socks } = await execInJob(jobName, [
        'sh', '-c', 'ls /tmp/yaac-acp/ 2>/dev/null || true',
      ])
      expect(socks).toContain('claude.sock')
      expect(agentSessionId).not.toBe('')
    }, 120_000)

    it('records the conversation to a host-mounted file, named for the conversation', async () => {
      // The record is the conversation's history — the server holds none — so
      // this is the load-bearing artifact of the whole mode. It has to exist
      // in the pod, carry the ACP stream verbatim, and be named for the
      // conversation rather than the window it runs in.
      const { stdout: files } = await execInJob(jobName, [
        'sh', '-c', 'ls /home/yaac/.yaac-acp/ 2>/dev/null || true',
      ])
      expect(files).toContain(`${agentSessionId}.jsonl`)

      const { stdout: recorded } = await execInJob(jobName, [
        'sh', '-c', `cat /home/yaac/.yaac-acp/${agentSessionId}.jsonl`,
      ])
      // Both directions: acpd's own life marker, our handshake going out, and
      // the agent's reply coming back. Without the client's own lines a
      // replayed conversation would show no user turns at all.
      expect(recorded).toContain('_acpd/life')
      expect(recorded).toContain('"method":"initialize"')
      expect(recorded).toContain('"method":"session/new"')
      expect(recorded).toContain(agentSessionId)
    }, 120_000)

    it('carries a message from the pane through to the agent, and records it', async () => {
      // The full loop in one assertion: pane → server → ctrl stream → acpd →
      // agent, with acpd teeing it on the way past. Deliberately asserts the
      // RECORD rather than a reply, so it proves the path without depending on
      // what the agent decides to answer.
      const { ws, opened } = openWs(
        `ws://127.0.0.1:${server!.lock.port}/acp/attach`
          + `?id=${worktreeId}&session=${encodeURIComponent(agentSessionId)}`,
        auth,
      )
      await opened
      await sleep(1000)
      ws.send(JSON.stringify({ type: 'prompt', text: 'e2e recorded prompt' }))

      let recorded = ''
      for (let i = 0; i < 60 && !recorded.includes('e2e recorded prompt'); i++) {
        await sleep(1000)
        recorded = (await execInJob(jobName, [
          'sh', '-c', `cat /home/yaac/.yaac-acp/${agentSessionId}.jsonl`,
        ])).stdout
      }
      ws.close()
      expect(recorded).toContain('"method":"session/prompt"')
      expect(recorded).toContain('e2e recorded prompt')
    }, 180_000)

    it('replays the record to a pane that attaches after the fact', async () => {
      // A fresh attach reads the record from the start, so a pane that was not
      // there when something was said still sees it. This is what the
      // in-memory event log used to do, badly.
      const { ws, text, opened } = openWs(
        `ws://127.0.0.1:${server!.lock.port}/acp/attach`
          + `?id=${worktreeId}&session=${encodeURIComponent(agentSessionId)}`,
        auth,
      )
      await opened
      for (let i = 0; i < 60 && !text.some((l) => l.includes('e2e recorded prompt')); i++) await sleep(500)
      ws.close()

      const hello = text.map((l) => JSON.parse(l) as { type: string; events?: Array<{ type: string }> })
        .find((m) => m.type === 'hello')
      expect(hello).toBeDefined()
      // The user turn is reconstructed from the client's own `session/prompt`
      // line in the record — the agent only echoes user messages when
      // replaying under `session/load`.
      expect(text.some((l) => l.includes('e2e recorded prompt'))).toBe(true)
    }, 120_000)

    it('serves the conversation over /acp/attach', async () => {
      const { ws, text, opened } = openWs(
        `ws://127.0.0.1:${server!.lock.port}/acp/attach`
          + `?id=${worktreeId}&session=${encodeURIComponent(agentSessionId)}`,
        auth,
      )
      await opened
      for (let i = 0; i < 30 && text.length === 0; i++) await sleep(500)
      ws.close()

      // `hello` carries the replayable event log — what a chat pane renders on
      // attach, and what makes a reconnect idempotent.
      expect(text.length).toBeGreaterThan(0)
      const hello = JSON.parse(text[0]) as {
        type: string
        agentSessionId?: string
        events?: unknown[]
      }
      expect(hello.type).toBe('hello')
      expect(hello.agentSessionId).toBe(agentSessionId)
      expect(Array.isArray(hello.events)).toBe(true)
    }, 60_000)

    it('refuses a tool with no ACP adapter before provisioning anything', async () => {
      await setupProject('acp-unsupported')
      const podsBefore = (await listWorktreePods('acp-unsupported')).length
      const bad = await runYaac(
        serverEnv, 'worktree', 'create', 'acp-unsupported', '--tool', 'opencode', '--mode', 'acp',
      )
      expect(bad.exitCode).not.toBe(0)
      expect(bad.stdout + bad.stderr).toMatch(/no ACP adapter/)
      // The check runs before the worktree, the Job, or a database row exists.
      expect((await listWorktreePods('acp-unsupported')).length).toBe(podsBefore)
    }, 120_000)
  })
})
