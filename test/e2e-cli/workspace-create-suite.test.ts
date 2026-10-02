import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import WebSocket from 'ws'
import { git } from '@yaac/test-utils/git'
import { freeLocalPort } from '@yaac/test-utils/kubectl-forward'
import { cloneRepo } from '@yaac/server/domain/git'
import { ensureNpmCache } from '@yaac/server/drivers/k8s/cluster'
import { reapNodeLocal } from '@yaac/server/drivers/k8s/images'
import { listWorkspacePods, type PodInfo } from '@yaac/server/drivers/k8s/substrate/pods'
import {
  createYaacTestEnv,
  spawnYaacServer,
  setTestGitIdentity,
  runYaac,
  TEST_CLI_ENTRY,
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
import { k8sNamespace, kubectlWithRetry } from '@yaac/server/drivers/k8s/substrate/kubectl'
import { nodeLocalNodePath } from '@yaac/server/drivers/k8s/substrate/mount-sources'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'
import { AGENT_CLIS } from '@yaac/shared/types'
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
 * `yaac workspace create` and everything that needs a live workspace, on a
 * real cluster. The proxy's upstream redirects send every outbound host
 * (GitHub, Anthropic, OpenAI) to mock pods in the test namespace.
 *
 * One server and one mock-LLM/mock-Git pair serve the whole file, and one
 * claude workspace carries every independent per-workspace feature (env
 * vars and secrets, cacheVolumes, initCommands, portForward, the
 * node_modules redirect) to avoid a pod per feature.
 *
 * Within a describe, tests run in declaration order and some depend on it:
 * the claude round trip needs the live agent, the status-watcher test then
 * replaces it with a sleep, and the node_modules test stops the workspace.
 *
 * Not covered here: nestedContainers (nested-containers.test.ts), and a
 * full opencode turn through the mock LLM.
 */

const execFileAsync = promisify(execFile)

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
function openWs(url: string, headers: Record<string, string> = {}): {
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

/** Enough of a PNG to pass the server's magic-byte check. */
const E2E_PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('e2e pixels')])

describe('yaac workspace create suite (real CLI + real server + mocked remotes)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let serverEnv: NodeJS.ProcessEnv
  let base = ''
  /** Every `yaac forward` child, killed in afterAll. */
  const forwardChildren: ChildProcess[] = []

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()

    testEnv = await createYaacTestEnv()

    // Fake credentials for every tool. The proxy swaps the workspace's
    // placeholders for these, which is what the tests assert.
    const credsDir = path.join(testEnv.dataDir, 'server-local', '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
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
    // `provider` is required, or the credential is dropped at load.
    await fs.writeFile(path.join(credsDir, 'opencode.json'), JSON.stringify({
      kind: 'api-key',
      provider: 'openrouter',
      savedAt: new Date().toISOString(),
      apiKey: 'sk-or-v1-fake-test-key',
    }) + '\n')


    mockLLM = await startMockLLM()
    mockGit = await startMockGit()

    // Redirect every host the tools touch at startup. A missing claude or
    // statsig host makes claude exit; `auth.openai.com` covers codex's
    // background refresh.
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
      YAAC_TEST_VAR: 'hello-from-host',
    }
    server = await spawnYaacServer(serverEnv)
    await setTestGitIdentity(serverEnv)
    base = `http://127.0.0.1:${server.lock.port}`
  })

  afterAll(async () => {
    // Kill forwarders before the server so none outlives it.
    for (const child of forwardChildren) child.kill('SIGKILL')
    forwardChildren.length = 0
    if (server) await server.stop()
    server = null
    await cleanupWorkspaceJobs()
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  /**
   * Stage a project as `yaac project add` would for
   * github.com/test-org/<slug>.git: clone the local bare repo, then set the
   * remote to the github URL so the proxy treats it as github.
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

    const projectPath = path.join(testEnv.dataDir, 'global', 'projects', slug)
    const repoPath = path.join(projectPath, 'repo')
    await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit!.reposDir, `${slug}.git`), repoPath, null)
    const fakeRemote = `https://github.com/test-org/${slug}.git`
    await git(repoPath, ['remote', 'set-url', 'origin', fakeRemote])
    await registerTestProject(server!, slug, fakeRemote)
    await assignTestGitCredential(server!, slug, 'fake-ghp-token')

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

  /** The kind node (a podman container) a workspace's pod runs on. */
  async function podNode(workspaceId: string): Promise<string> {
    const { stdout } = await kubectlWithRetry([
      'get', 'pods', '-n', k8sNamespace(), '-l', `yaac.workspace-id=${workspaceId}`,
      '-o', 'jsonpath={.items[0].spec.nodeName}',
    ])
    if (!stdout.trim()) throw new Error(`no pod found for workspace ${workspaceId}`)
    return stdout.trim()
  }

  async function findWorkspacePod(slug: string, exclude = new Set<string>()): Promise<PodInfo> {
    // Scoped to this data dir's pods. Oldest first; callers that keep an
    // older workspace alive in the project pass its id in `exclude`.
    const pods = (await listWorkspacePods(slug)).filter((p) => !exclude.has(p.workspaceId))
    const pod = pods.sort((a, b) => a.createdAtMs - b.createdAtMs)[0]
    if (!pod) throw new Error(`no session pod found for project ${slug}`)
    return pod
  }

  async function createWorkspace(
    slug: string,
    ...extraArgs: string[]
  ): Promise<{ jobName: string; stdout: string }> {
    const { stdout, stderr, exitCode } = await runYaac(
      serverEnv, 'workspace', 'create', slug, ...extraArgs,
    )
    if (exitCode !== 0) {
      throw new Error(`session create failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    return { jobName: (await findWorkspacePod(slug)).jobName, stdout }
  }


  /**
   * Run `yaac forward` as a long-lived child, with a wait for its
   * "forwarding" lines. The server binds no host port for forwards
   * (docs/port-forward-tunnel.md), so the HTTP tests below need a client
   * like this holding the listener.
   */
  function startForwardCli(...args: string[]): {
    ready: (count: number) => Promise<string[]>
    output: () => string
    stop: () => Promise<void>
  } {
    const child = spawn(process.execPath, [TEST_CLI_ENTRY, 'forward', ...args], {
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
    child.stderr.on('data', (c: Buffer) => { out += c.toString('utf8') })
    forwardChildren.push(child)
    return {
      output: () => out,
      ready: (count) => vi.waitFor(() => {
        const lines = out.split('\n').filter((l) => l.startsWith('forwarding '))
        if (lines.length < count) {
          throw new Error(`yaac forward never bound ${String(count)} port(s). Output:\n${out}`)
        }
        return lines
      }, { timeout: 30_000, interval: 200 }),
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill('SIGTERM')
        await new Promise<void>((resolve) => child.once('close', () => resolve()))
      },
    }
  }

  /**
   * Wait until something on this machine accepts on `hostPort`. A newly
   * offered port is bound only once the client forwarder notices it.
   */
  async function waitForLocalListener(hostPort: number): Promise<void> {
    await vi.waitFor(() => new Promise<void>((resolve, reject) => {
      const socket = net.connect(hostPort, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('error', (err) => { socket.destroy(); reject(err) })
    }), { timeout: 20_000, interval: 250 })
  }

  /**
   * Start an HTTP server in a workspace pod (with nohup, since kubectl exec
   * cannot detach) and wait for it to accept. Use a unique `containerPort`
   * per call.
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
    await vi.waitFor(async () => {
      const { stdout } = await execInJob(jobName, [
        'sh', '-c',
        `curl -sf http://${curlHost}:${containerPort}/`,
      ], { timeout: 5000 })
      expect(stdout, `HTTP server on ${bindAddress}:${containerPort}`).toBe(responseText)
    }, { timeout: 30_000, interval: 250 })
  }

  describe('kitchen-sink claude session', () => {
    // Host ports are picked free in beforeAll, since another rig may run
    // this file on the same host at the same time.
    const PORT_FORWARD = [8080, 8081, 8082, 8083, 8084]
      .map((containerPort) => ({ containerPort, hostPortStart: 0 }))
    // Detected ports are offered at their own number, so pick them free too.
    let detectedPort = 0
    let persistedPort = 0
    // Container port to host port, parsed from the create output.
    const hostPortFor = new Map<number, number>()
    let jobName = ''
    let workspaceId = ''
    let forwarder: ReturnType<typeof startForwardCli> | null = null
    let projectPath = ''

    beforeAll(async () => {
      for (const entry of PORT_FORWARD) entry.hostPortStart = await freeLocalPort()
      detectedPort = await freeLocalPort()
      persistedPort = await freeLocalPort()
      projectPath = await setupProject('kitchen', {
        // node_modules is gitignored so `git status` stays clean. The
        // tracked `frontends/` makes the checkout populate a dir whose mount
        // point already exists.
        files: { '.gitignore': 'node_modules\n', 'frontends/app.txt': 'app\n' },
        yaacConfig: {
          // A root path and a nested one under a tracked dir.
          ephemeralModulesPaths: ['node_modules', 'frontends/node_modules'],
          // Stored under the project dir, so removed with the temp data dir.
          cacheVolumes: { 'test-cache': '/tmp/test-cache' },
          // `sleep` keeps the init window alive long enough for the server
          // to set remain-on-exit on it.
          initCommands: ['touch /tmp/init-ran && sleep 30'],
          portForward: PORT_FORWARD,
        },
      })

      // Project env vars, set over the API. A plain variable is placed in
      // the workspace; a secret is not, and the proxy injects it into
      // matching requests.
      for (const body of [
        { name: 'YAAC_TEST_VAR', value: 'hello-from-host' },
        {
          name: 'KITCHEN_SECRET',
          value: 'the-real-secret',
          secret: true,
          rule: { hosts: ['api.github.com'], header: 'x-kitchen-key' },
        },
      ]) {
        const res = await fetch(`${base}/api/project/kitchen/env`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(res.status).toBe(200)
      }

      // Pre-seed claude's onboarding state to skip the first-run wizard.
      // The claude home is CLAUDE_CONFIG_DIR in the pod, so its config is
      // `.claude.json` there, keyed by the checkout path /workspace.
      await fs.writeFile(path.join(projectPath, 'claude', '.claude.json'), JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: AGENT_CLIS.claude.version,
        customApiKeyResponses: { approved: ['yaac-ph-api-key'], rejected: [] },
        projects: {
          '/workspace': { hasTrustDialogAccepted: true },
        },
      }) + '\n')
      await fs.writeFile(path.join(projectPath, 'claude', 'settings.json'), JSON.stringify({
        skipDangerousModePermissionPrompt: true,
      }) + '\n')

      // An install provides the npm cache; this namespace needs its own for
      // the pnpm install in the last test.
      await ensureNpmCache()

      const created = await createWorkspace('kitchen', '--tool', 'claude')
      jobName = created.jobName

      // One "Offering host port" line per portForward entry. Nothing is
      // bound until the forwarder below starts.
      for (const line of created.stdout.split('\n')) {
        const m = line.match(/Offering host port (\d+) -> container port (\d+)/)
        if (m) hostPortFor.set(Number(m[2]), Number(m[1]))
      }
      expect(hostPortFor.size).toBe(PORT_FORWARD.length)

      workspaceId = (await findWorkspacePod('kitchen')).workspaceId
      expect(workspaceId).toBeTruthy()

      // Held for the whole describe; every HTTP test dials through it.
      forwarder = startForwardCli(workspaceId)
      await forwarder.ready(PORT_FORWARD.length)
    }, 240_000)

    afterAll(async () => {
      await forwarder?.stop()
      forwarder = null
    })

    it('provisions pod, workspace, mounts, git, and tmux', async () => {
      const pod = await findWorkspacePod('kitchen')
      expect(pod.running).toBe(true)
      expect(pod.labels['yaac.project']).toBe('kitchen')
      expect(pod.labels['yaac.tool']).toBe('claude')

      await execInJob(jobName, ['test', '-d', '/home/yaac/.claude'])
      await execInJob(jobName, ['test', '-f', '/home/yaac/.claude.json'])
      await execInJob(jobName, ['test', '-d', '/home/yaac/.codex'])
      // Writable, not just present: the runtime would create a missing
      // mount parent as root. ~/.yaac is also a nested server's data dir.
      await execInJob(jobName, ['test', '-w', '/home/yaac/.yaac'])
      await execInJob(jobName, ['test', '-w', '/home/yaac/.config'])
      await execInJob(jobName, ['test', '-w', '/home/yaac/.local/share'])

      const { stdout: lsOut } = await execInJob(jobName, ['ls', '/workspace'])
      expect(lsOut).toContain('README.md')

      const { stdout: gitStatus } = await execInJob(jobName, [
        'sh', '-c', 'cd /workspace && git status --porcelain',
      ])
      expect(gitStatus.trim()).toBe('')
      const { stdout: branch } = await execInJob(jobName, [
        'sh', '-c', 'cd /workspace && git rev-parse --abbrev-ref HEAD',
      ])
      expect(branch.trim()).toBe(`agent/${workspaceId}`)

      const { stdout: tmuxList } = await execInJob(jobName, [
        'tmux', '-S', CONTAINER_TMUX_SOCK, 'list-sessions',
      ])
      expect(tmuxList).toContain('yaac')

      await expect(execInJob(jobName, [
        'test', '-f', '/tmp/yaac-prompt',
      ])).rejects.toThrow()

      // Every volume is the global claim, the node-local tree, an emptyDir or
      // the CA ConfigMap; nothing is a hostPath into the data dir
      // (docs/server-in-cluster.md, "Storage is two claims").
      const { stdout: jobJson } = await kubectlWithRetry([
        'get', 'job', jobName, '-n', k8sNamespace(), '-o', 'json',
      ])
      const volumes = (JSON.parse(jobJson) as {
        spec: { template: { spec: {
          initContainers?: Array<{ name: string }>
          volumes: Array<{ name: string; hostPath?: { path: string }; persistentVolumeClaim?: { claimName: string }; emptyDir?: unknown; configMap?: unknown }>
        } } }
      }).spec.template.spec
      for (const v of volumes.volumes) {
        const ok = v.persistentVolumeClaim?.claimName === 'yaac-global'
          || v.hostPath?.path.startsWith(nodeLocalNodePath()) === true
          || v.emptyDir !== undefined || v.configMap !== undefined
        expect(ok, `volume ${v.name}: ${JSON.stringify(v)}`).toBe(true)
        expect(v.hostPath?.path.startsWith(testEnv.dataDir)).not.toBe(true)
      }
      expect(volumes.initContainers?.map((c) => c.name)).toEqual(['node-dirs'])
    }, 60_000)

    it('mounts each builtin skill over a mountpoint the SERVER made', async () => {
      // The kubelet would create a missing mountpoint root-owned, and a later
      // containerless run (which symlinks skills) could not remove it. So
      // the server creates each one, and the mounts must still land on them.
      const skillsRoot = path.join(projectPath, 'claude', 'skills')
      const entries = await fs.readdir(skillsRoot, { withFileTypes: true })
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        expect(entry.isDirectory()).toBe(true)
        expect((await fs.stat(path.join(skillsRoot, entry.name))).uid).toBe(process.getuid?.())
      }
      for (const entry of entries) {
        await execInJob(jobName, ['test', '-f', `/home/yaac/.claude/skills/${entry.name}/SKILL.md`])
      }
    }, 60_000)

    it('puts a plain project variable in the container', async () => {
      const { stdout } = await execInJob(jobName, ['env'])
      expect(stdout).toContain('YAAC_TEST_VAR=hello-from-host')
    }, 60_000)

    it('keeps a proxied secret out of the container entirely', async () => {
      // The workspace holds a placeholder; the proxy swaps in the real value.
      const { stdout } = await execInJob(jobName, ['env'])
      expect(stdout).toContain('KITCHEN_SECRET=placeholder')
      expect(stdout).not.toContain('the-real-secret')
      const { stdout: grepped } = await execInJob(jobName, [
        'sh', '-c', 'grep -rl the-real-secret /workspace /home/yaac 2>/dev/null || true',
      ])
      expect(grepped.trim()).toBe('')
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
      // Init commands run in a background tmux window, so poll.
      await vi.waitFor(() => execInJob(jobName, ['test', '-f', '/tmp/init-ran']), { timeout: 30_000, interval: 250 })
    }, 60_000)

    it('surfaces forwarded host ports in the tmux status bar', async () => {
      // The pod spec has no port mappings, so status-right is where the
      // offered host ports show, set at create time.
      const { stdout: statusRight } = await execInJob(jobName, [
        'tmux', '-S', CONTAINER_TMUX_SOCK,
        'show-option', '-t', 'yaac', 'status-right',
      ])
      expect(statusRight).toContain(workspaceId.slice(0, 8))
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

    it('surfaces the offered forwards on /workspace/list (feeds the webapp snapshot)', async () => {
      const res = await fetch(`${base}/api/workspace/list?project=kitchen`)
      expect(res.status).toBe(200)
      const body = await res.json() as {
        workspaces: Array<{ forwardedPorts: Array<{ containerPort: number; hostPort: number }> }>
      }
      expect(body.workspaces).toHaveLength(1)
      const got = new Map(body.workspaces[0].forwardedPorts.map((p) => [p.containerPort, p.hostPort]))
      expect(got).toEqual(hostPortFor)
    }, 30_000)

    // `yaac forward`: one case per argument and option.

    it('forwards every running workspace when told no session, on the address asked for', async () => {
      // With no workspace named it asks the server what to bind. `--bind`
      // also avoids colliding with the forwarder already on 127.0.0.1.
      const everything = startForwardCli('--bind', '127.0.0.3')
      try {
        const lines = await everything.ready(PORT_FORWARD.length)
        for (const [containerPort, hostPort] of hostPortFor) {
          expect(lines.join('\n')).toContain(`127.0.0.3:${hostPort} -> `)
          expect(lines.join('\n')).toContain(`:${containerPort}`)
        }

        await startHttpServerInContainer(jobName, 8085, '127.0.0.1', 'hello bind')
        const res = await httpGet(`http://127.0.0.3:${hostPortFor.get(8080)!}/`)
        expect(res.status).toBe(200)
        expect(res.body).toBe('hello ipv4')
      } finally {
        await everything.stop()
      }
    }, 60_000)

    it('forwards exactly the ports --port names, on the local port it names', async () => {
      // Explicit ports override what the server offers.
      const [local, bare] = [await freeLocalPort(), await freeLocalPort()]
      const explicit = startForwardCli(workspaceId, '--port', `8080:${local}`, '-p', String(bare))
      try {
        const lines = await explicit.ready(2)
        expect(lines.join('\n')).toContain(`127.0.0.1:${local} -> `)
        // A bare `-p <n>` uses the same port on both sides.
        expect(lines.join('\n')).toContain(`127.0.0.1:${bare} -> `)

        const res = await httpGet(`http://127.0.0.1:${local}/`)
        expect(res.status).toBe(200)
        expect(res.body).toBe('hello ipv4')
      } finally {
        await explicit.stop()
      }
    }, 60_000)

    it('refuses to tunnel onto a port the workspace neither declared nor surfaced', async () => {
      // 10300 is streamd, which is listening, so the refusal comes from the
      // tunnel's port check.
      const local = await freeLocalPort()
      const stray = startForwardCli(workspaceId, '--port', `10300:${local}`)
      try {
        await stray.ready(1)
        await expect(httpGet(`http://127.0.0.1:${local}/`)).rejects.toThrow()
        expect(stray.output()).toMatch(/dial failed/)
      } finally {
        await stray.stop()
      }
    }, 60_000)

    it('refuses a session it cannot resolve, rather than binding nothing forever', async () => {
      const { stdout, stderr, exitCode } = await runYaac(serverEnv, 'forward', 'no-such-session')
      expect(exitCode).not.toBe(0)
      expect(`${stdout}${stderr}`).toMatch(/no-such-session|not found/i)
    }, 30_000)

    // The review pane's data: the in-pod script finds the fork point and
    // snapshots the checkout into a separate index.
    it('reports committed and uncommitted workspace changes on /workspace/:id/changes', async () => {
      await execInJob(jobName, ['sh', '-c',
        'cd /workspace && printf "committed\\n" > committed.txt'
        + ' && git add committed.txt && git -c user.email=t@t -c user.name=t commit -qm "add committed.txt"'
        + ' && printf "working\\n" > untracked.txt'
        + ' && printf "\\nappended\\n" >> README.md',
      ])

      const res = await fetch(`${base}/api/workspace/${workspaceId}/changes`)
      expect(res.status).toBe(200)
      const body = await res.json() as {
        base: string
        baseResolved: boolean
        files: Array<{ path: string; status: string; additions: number }>
        diff: string
        truncated: boolean
      }

      // With a real fork point, committed work is in the diff too.
      expect(body.baseResolved).toBe(true)
      expect(body.base).toMatch(/^[0-9a-f]{40}$/)
      const byPath = new Map(body.files.map((f) => [f.path, f]))
      expect(byPath.get('committed.txt')?.status).toBe('added')
      expect(byPath.get('untracked.txt')?.status).toBe('added')
      expect(byPath.get('README.md')?.status).toBe('modified')
      expect(body.diff).toContain('+committed')
      expect(body.diff).toContain('+working')
      expect(body.truncated).toBe(false)

      // The snapshot leaves the agent's own index and HEAD alone.
      const { stdout: porcelain } = await execInJob(jobName, [
        'sh', '-c', 'cd /workspace && git status --porcelain',
      ])
      expect(porcelain).toContain('?? untracked.txt')
      expect(porcelain).toContain(' M README.md')
      expect(porcelain).not.toContain('committed.txt') // committed, not left staged

      // The index is reused, so a second call must see later edits.
      await execInJob(jobName, ['sh', '-c',
        'cd /workspace && rm -f untracked.txt && printf "second\\n" > later.txt',
      ])
      const res2 = await fetch(`${base}/api/workspace/${workspaceId}/changes`)
      expect(res2.status).toBe(200)
      const body2 = await res2.json() as { files: Array<{ path: string }> }
      const paths2 = body2.files.map((f) => f.path)
      expect(paths2).toContain('later.txt')
      expect(paths2).toContain('committed.txt')
      expect(paths2).not.toContain('untracked.txt') // deletion picked up

      // Restore git state for later tests.
      await execInJob(jobName, ['sh', '-c',
        'cd /workspace && rm -f later.txt && git checkout -- README.md'
        + ' && git reset -q --hard HEAD~1',
      ])
    }, 60_000)

    // The file editor works on the server pod's own mount of the checkout
    // (docs/file-editor.md). Checks that a save is visible in the pod, an
    // in-pod edit is visible to the next read, and git status stays clean
    // although in-pod git wrote the index through a different mount.
    it('edits the checkout from the server, visibly to the pod and back', async () => {
      const files = await (await fetch(`${base}/api/workspace/${workspaceId}/files`)).json() as {
        paths: string[]; status: Record<string, string>
      }
      expect(files.paths).toContain('README.md')
      expect(files.status['README.md']).toBeUndefined()

      const read = await (await fetch(`${base}/api/workspace/${workspaceId}/file?path=README.md`))
        .json() as { version: string; content: string }
      const saved = await fetch(`${base}/api/workspace/${workspaceId}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'README.md', content: `${read.content}saved by the server\n`, baseVersion: read.version }),
      })
      expect(saved.status).toBe(200)
      const { version } = await saved.json() as { version: string }
      const { stdout: inPod } = await execInJob(jobName, ['cat', '/workspace/README.md'])
      expect(inPod).toContain('saved by the server')

      await execInJob(jobName, ['sh', '-c', 'printf "edited in the pod\\n" >> /workspace/README.md'])
      const reread = await (await fetch(
        `${base}/api/workspace/${workspaceId}/file?path=README.md&known=${version}`,
      )).json() as { version: string; content?: string }
      expect(reread.version).not.toBe(version)
      expect(reread.content).toContain('edited in the pod')

      // Restore git state for later tests.
      await execInJob(jobName, ['sh', '-c', 'cd /workspace && git checkout -- README.md'])
    }, 60_000)

    // An unknown base is a client error, not a server fault.
    it('answers 400 for a ?base= ref that resolves nowhere', async () => {
      const res = await fetch(
        `${base}/api/workspace/${workspaceId}/changes?base=no-such-branch`,
      )
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('VALIDATION')
      expect(body.error.message).toContain('no-such-branch')
    }, 30_000)

    it('relay accepts sequential requests while the event loop stays responsive', async () => {
      // A blocked event loop would let only the first request through.
      await startHttpServerInContainer(jobName, 8084, '127.0.0.1', 'sequential')
      const hostPort = hostPortFor.get(8084)!
      for (let i = 0; i < 3; i++) {
        const res = await httpGet(`http://127.0.0.1:${hostPort}/`)
        expect(res.status).toBe(200)
        expect(res.body).toBe('sequential')
      }
    }, 30_000)

    // Auto-detected ports (pushed by streamd). These run in order: detect,
    // forward, persist, dismiss.

    /** The kitchen workspace's row from /workspace/list. */
    async function kitchenSession(): Promise<{
      forwardedPorts: Array<{ containerPort: number; hostPort: number }>
      unforwardedPorts: number[]
    }> {
      const res = await fetch(`${base}/api/workspace/list?project=kitchen`)
      expect(res.status).toBe(200)
      const body = await res.json() as {
        workspaces: Array<{
          forwardedPorts: Array<{ containerPort: number; hostPort: number }>
          unforwardedPorts: number[]
        }>
      }
      expect(body.workspaces).toHaveLength(1)
      return body.workspaces[0]
    }

    /** Waits for `port`'s listener to surface in unforwardedPorts. */
    async function waitForUnforwarded(port: number): Promise<number[]> {
      return vi.waitFor(async () => {
        const ports = (await kitchenSession()).unforwardedPorts
        expect(ports).toContain(port)
        return ports
      }, { timeout: 120_000, interval: 1000 })
    }

    it('detects unforwarded listeners, never surfacing denylisted or forwarded ports', async () => {
      // An ordinary listener and one on the denylist (9229, node --inspect).
      // Detection is asynchronous, so poll.
      await startHttpServerInContainer(jobName, detectedPort, '127.0.0.1', 'detected server')
      await startHttpServerInContainer(jobName, 9229, '127.0.0.1', 'sensitive server')

      const unforwarded = await waitForUnforwarded(detectedPort)
      // Hidden: the denylisted port, streamd (10300), and ports already
      // forwarded by config.
      expect(unforwarded).not.toContain(9229)
      expect(unforwarded).not.toContain(10300)
      for (const { containerPort } of PORT_FORWARD) {
        expect(unforwarded).not.toContain(containerPort)
      }
    }, 90_000)

    it('forwards a detected port for this session and serves real traffic', async () => {
      const res = await fetch(`${base}/api/workspace/${workspaceId}/forward-port`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: detectedPort }),
      })
      expect(res.status).toBe(200)
      const mapping = await res.json() as { containerPort: number; hostPort: number }
      expect(mapping.containerPort).toBe(detectedPort)

      await waitForLocalListener(mapping.hostPort)
      const page = await httpGet(`http://127.0.0.1:${mapping.hostPort}/`)
      expect(page.status).toBe(200)
      expect(page.body).toBe('detected server')

      const session = await kitchenSession()
      expect(session.unforwardedPorts).not.toContain(detectedPort)
      expect(session.forwardedPorts).toContainEqual(mapping)

      // Already forwarded, so a repeat is rejected.
      const again = await fetch(`${base}/api/workspace/${workspaceId}/forward-port`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: detectedPort }),
      })
      expect(again.status).toBe(409)
    }, 60_000)

    it('rejects forwarding a port with no detected listener', async () => {
      const res = await fetch(`${base}/api/workspace/${workspaceId}/forward-port`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: 8099 }),
      })
      expect(res.status).toBe(409)
    }, 30_000)

    it('persists a detected port into the project config and forwards it live', async () => {
      await startHttpServerInContainer(jobName, persistedPort, '127.0.0.1', 'persisted server')
      await waitForUnforwarded(persistedPort)

      const res = await fetch(`${base}/api/workspace/${workspaceId}/forward-port`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: persistedPort, persist: true }),
      })
      expect(res.status).toBe(200)
      const mapping = await res.json() as { containerPort: number; hostPort: number }

      await waitForLocalListener(mapping.hostPort)
      const page = await httpGet(`http://127.0.0.1:${mapping.hostPort}/`)
      expect(page.body).toBe('persisted server')

      // The project config gained the entry, keeping the existing ones.
      const configRaw = await fs.readFile(
        path.join(projectPath, 'config', 'yaac-config.json'), 'utf8',
      )
      const config = JSON.parse(configRaw) as {
        portForward: Array<{ containerPort: number; hostPortStart: number }>
      }
      expect(config.portForward).toContainEqual({ containerPort: persistedPort, hostPortStart: persistedPort })
      for (const entry of PORT_FORWARD) {
        expect(config.portForward).toContainEqual(entry)
      }
    }, 90_000)

    it('dismisses a detected port so it stops being offered', async () => {
      await startHttpServerInContainer(jobName, 8092, '127.0.0.1', 'dismissed server')
      await waitForUnforwarded(8092)

      const res = await fetch(`${base}/api/workspace/${workspaceId}/dismiss-port`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: 8092 }),
      })
      expect(res.status).toBe(204)
      expect((await kitchenSession()).unforwardedPorts).not.toContain(8092)

      const forward = await fetch(`${base}/api/workspace/${workspaceId}/forward-port`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ containerPort: 8092 }),
      })
      expect(forward.status).toBe(409)
    }, 90_000)

    it('routes session HTTPS through proxy→redirect→mock with credential injection', async () => {
      // Send the placeholder x-api-key, which the proxy swaps for the real
      // key. The marker tells this request apart from claude's own.
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
      expect(curlOut).toContain('Hello from mock')

      // The mock received the real key.
      const transcript = await mockLLM!.transcript()
      const probeCall = transcript.find((e) =>
        e.method === 'POST' && e.url.startsWith('/v1/messages') && e.body.includes(marker),
      )
      expect(probeCall).toBeDefined()
      expect(probeCall!.headers['x-api-key']).toBe('sk-ant-fake-real-key')
      expect(probeCall!.body).toContain('claude-sonnet-4-6')
    }, 60_000)

    it('swaps in a credential updated through the running server, with no restart', async () => {
      // A new key reaches the proxy through its credentials Secret; nothing
      // restarts.
      const probe = async (): Promise<string | undefined> => {
        const marker = `rotate-probe-${randomUUID().slice(0, 8)}`
        await execInJob(jobName, [
          'curl', '-sS', '-k', '--max-time', '10', '-X', 'POST',
          '-H', 'x-api-key: yaac-ph-api-key', '-H', 'content-type: application/json',
          '-d', `{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"${marker}"}]}`,
          'https://api.anthropic.com/v1/messages',
        ], { timeout: 20_000 })
        const transcript = await mockLLM!.transcript()
        const key = transcript.find((e) => e.body.includes(marker))?.headers['x-api-key']
        return Array.isArray(key) ? key[0] : key
      }
      const putKey = async (apiKey: string): Promise<void> => {
        const res = await fetch(`${base}/api/auth/claude`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'api-key', apiKey }),
        })
        expect(res.status).toBe(204)
      }
      const seen: string[] = []
      const untilSwapped = (expected: string): Promise<void> => vi.waitFor(async () => {
        const key = await probe()
        if (key !== undefined) seen.push(key)
        expect(seen.at(-1), `saw ${seen.join(', ')}`).toBe(expected)
      }, { timeout: 30_000, interval: 500 })

      await putKey('sk-ant-fake-rotated-key')
      await untilSwapped('sk-ant-fake-rotated-key')
      // Restore it for later cases.
      await putKey('sk-ant-fake-real-key')
      await untilSwapped('sk-ant-fake-real-key')
    }, 120_000)

    it('boots claude-code and round-trips a prompt through the mock LLM', async () => {
      // The real claude against the mock. Onboarding was pre-seeded, so it
      // starts at its prompt.
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

      // Poll for the mock's "Hello from mock!" reply. An Enter sent during
      // claude's startup render can be dropped, so resend it periodically.
      let pane = ''
      let polls = 0
      const hitMockText = await vi.waitFor(async () => {
        pane = await capturePane()
        if (pane.includes('Hello from mock')) return
        if (++polls % 3 === 0) await send('Enter')
        throw new Error('no reply from the mock yet')
      }, { timeout: 30_000, interval: 500 }).then(() => true, () => false)

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

      // The prompt reached the mock with the real key swapped in.
      const transcript = await mockLLM!.transcript()
      const promptCall = transcript.find((e) =>
        e.method === 'POST' && e.url.startsWith('/v1/messages') && e.body.includes('hello mock'),
      )
      expect(promptCall).toBeDefined()
      expect(promptCall!.headers['x-api-key']).toBe('sk-ant-fake-real-key')
    }, 120_000)

    it('writes a command over the PTY WebSocket and reads its output back', async () => {
      // The webapp's terminal path: create a shell window (the "+" button),
      // attach over the WS, and round-trip a command.
      const createRes = await fetch(
        `${base}/api/workspace/${workspaceId}/terminals`,
        { method: 'POST' },
      )
      expect(createRes.ok).toBe(true)
      const shell = await createRes.json() as { target: string; name: string }
      expect(shell.name).toBe('shell')
      expect(shell.target).toMatch(/^window:@\d+$/)
      const { ws, binary, opened } = openWs(
        `ws://127.0.0.1:${server!.lock.port}/api/pty/attach`
          + `?id=${workspaceId}&target=${encodeURIComponent(shell.target)}&cols=100&rows=30`,
      )
      await opened
      await sleep(3000) // let the shell start and paint its prompt
      ws.send(Buffer.from('echo WS_ROUNDTRIP_$((40 + 2))\r'))
      await vi.waitFor(() => expect(binary()).toContain('WS_ROUNDTRIP_42'), { timeout: 15_000, interval: 500 })
      ws.close()

      // target=native, used by `yaac workspace attach`. The tmux prefix
      // must work here (view sessions disable it), so C-b d detaches and
      // the server closes the socket.
      const native = openWs(
        `ws://127.0.0.1:${server!.lock.port}/api/pty/attach`
          + `?id=${workspaceId}&target=native&cols=100&rows=30`,
      )
      let nativeClosed = false
      native.ws.on('close', () => { nativeClosed = true })
      await native.opened
      await vi.waitFor(() => expect(native.binary().length).toBeGreaterThan(0), { timeout: 15_000, interval: 500 })
      native.ws.send(Buffer.from('\x02d')) // C-b d
      await vi.waitFor(() => expect(nativeClosed, 'C-b d did not close the native attach').toBe(true),
        { timeout: 15_000, interval: 100 })

      // target=shell, used by `yaac workspace shell`: a plain zsh with no
      // tmux. `exit` closes the socket.
      const rawShell = openWs(
        `ws://127.0.0.1:${server!.lock.port}/api/pty/attach`
          + `?id=${workspaceId}&target=shell&cols=100&rows=30`,
      )
      let shellClosed = false
      rawShell.ws.on('close', () => { shellClosed = true })
      await rawShell.opened
      await sleep(3000)
      rawShell.ws.send(Buffer.from('echo RAW_SHELL_$((20 + 3))\r'))
      await vi.waitFor(() => expect(rawShell.binary()).toContain('RAW_SHELL_23'), { timeout: 15_000, interval: 500 })
      rawShell.ws.send(Buffer.from('exit\r'))
      await vi.waitFor(() => expect(shellClosed, 'exit did not close the raw shell attach').toBe(true),
        { timeout: 15_000, interval: 100 })
    }, 120_000)

    it('holds its streams with no kubectl child at all', async () => {
      // With status watching, forwards and terminals all live, the server
      // pod runs no `kubectl exec` into a workspace and no `kubectl
      // port-forward`: it dials Services directly
      // (docs/server-in-cluster.md). Read from /proc since the image has no
      // procps.
      const { stdout } = await kubectlWithRetry([
        'exec', '-n', k8sNamespace(), 'deployment/yaac-server', '--',
        'sh', '-c', 'for p in /proc/[0-9]*; do tr "\\0" " " < "$p/cmdline" 2>/dev/null; echo; done',
      ], { timeout: 60_000 })
      const cmdlines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
      expect(cmdlines.some((l) => /node .*cli\.js/.test(l))).toBe(true)

      expect(cmdlines.filter((l) => /kubectl\s+exec\b/.test(l) && l.includes('job/'))).toEqual([])
      expect(cmdlines.filter((l) => /kubectl\s+port-forward\b/.test(l))).toEqual([])
    })

    it('locks streamd ingress to the proxy (session ingress lock policy)', async () => {
      const ns = k8sNamespace()
      const { stdout: ipOut } = await kubectlWithRetry([
        'get', 'pods', '-n', ns, '-l', `yaac.workspace-id=${workspaceId}`,
        '-o', 'jsonpath={.items[0].status.podIP}',
      ])
      const podIp = ipOut.trim()
      expect(podIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/)

      // The proxy can dial streamd, so the negative case below measures the
      // policy, not a dead daemon.
      const dialScript =
        `const s=require('net').connect(10300,'${podIp}');`
        + "s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});"
        + "s.on('error',(e)=>{console.log('ERR:'+e.code);process.exit(1)});"
        + "setTimeout(()=>{console.log('TIMEOUT');process.exit(1)},5000);"
      const { stdout: fromProxy } = await kubectlWithRetry([
        'exec', '-n', ns, 'deploy/yaac-proxy', '--', 'node', '-e', dialScript,
      ], { timeout: 30_000 })
      expect(fromProxy).toContain('CONNECTED')

      // Any other pod is dropped (nc times out). The probe uses the
      // workspace image, which is on the node and has nc.
      const { stdout: imgOut } = await kubectlWithRetry([
        'get', 'pods', '-n', ns, '-l', `yaac.workspace-id=${workspaceId}`,
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
      // The server's per-workspace tmux control-mode watcher
      // (runtime/status/status-watcher.ts) follows the agent pane's title,
      // and `workspace list` reads what it stores. The test sets the title
      // itself; claude's own titles are covered by unit tests.
      //
      // This replaces claude, so it runs after the round-trip tests. The
      // stand-in must not be `sleep`: the stale reaper
      // (probeAgentPaneState) treats a pane still running the create-time
      // `sleep` placeholder as half-provisioned and deletes the Job.
      await execInJob(jobName, [
        'tmux', '-S', CONTAINER_TMUX_SOCK, 'set-option', '-t', 'yaac', 'remain-on-exit', 'on',
      ])
      await execInJob(jobName, [
        'tmux', '-S', CONTAINER_TMUX_SOCK, 'respawn-window', '-k', '-t', 'yaac:claude', 'tail -f /dev/null',
      ])

      const setTitle = (title: string): Promise<{ stdout: string }> => execInJob(jobName, [
        'tmux', '-S', CONTAINER_TMUX_SOCK, 'select-pane', '-t', 'yaac:claude.0', '-T', title,
      ])
      const waitForListStatus = (expected: 'running' | 'waiting', timeout: number): Promise<void> =>
        vi.waitFor(async () => {
          const { stdout } = await runYaac(serverEnv, 'workspace', 'list', 'kitchen')
          const row = stdout.split('\n').find((l) => l.includes('kitchen') && !l.startsWith('WORKSPACE'))
          if (!row?.includes(expected)) throw new Error(`status is not ${expected}; list:\n${stdout}`)
        }, { timeout, interval: 500 })

      await setTitle('✳ marker-idle')
      await waitForListStatus('waiting', 20_000)

      // A spinner title means running. Both of claude's spinner glyph sets
      // (Braille and circle phases) are checked.
      await setTitle('⠋ marker-busy')
      await waitForListStatus('running', 20_000)

      await setTitle('✳ marker-idle-again')
      await waitForListStatus('waiting', 20_000)

      await setTitle('◐ marker-busy-circle')
      await waitForListStatus('running', 20_000)

      // Kill the watcher's in-pod tmux client. Status must keep its last
      // value, and the watcher must reconnect (the next title change lands).
      await execInJob(jobName, ['pkill', '-f', 'tmux.*-C attach-session'])
      const { stdout: afterKill } = await runYaac(serverEnv, 'workspace', 'list', 'kitchen')
      const row = afterKill.split('\n').find((l) => l.includes('kitchen') && !l.startsWith('WORKSPACE'))
      expect(row).toBeDefined()
      expect(row).toContain('running')

      await setTitle('✳ marker-done')
      await waitForListStatus('waiting', 30_000)
    }, 240_000)

    it('keeps each module dir and pnpm\'s store on pod-local volumes, installing through the npm cache', async () => {
      // Last kitchen test: it stops the workspace.
      // Each module dir is a real directory on its own tmpfs, not a symlink
      // (which would break pnpm's mkdir).
      await expect(execInJob(jobName, [
        'readlink', '/workspace/node_modules',
      ])).rejects.toThrow()
      const { stdout: mounts } = await execInJob(jobName, ['cat', '/proc/mounts'])
      for (const dir of ['/workspace/node_modules', '/workspace/frontends/node_modules']) {
        expect(mounts.split('\n').find((l) => l.split(' ')[1] === dir)?.split(' ')[2]).toBe('tmpfs')
      }

      // Writes stay in the pod, not the checkout on the global claim.
      await execInJob(jobName, [
        'sh', '-c',
        'echo hello > /workspace/node_modules/marker.txt && echo nested > /workspace/frontends/node_modules/marker.txt',
      ])
      const wtDir = path.join(projectPath, 'workspaces', workspaceId)
      await expect(fs.access(path.join(wtDir, 'node_modules', 'marker.txt'))).rejects.toThrow()
      await expect(fs.access(path.join(wtDir, 'frontends', 'node_modules', 'marker.txt'))).rejects.toThrow()
      // The nested mount point exists before the checkout, which must still
      // populate the tracked dir around it.
      expect(await fs.readFile(path.join(wtDir, 'frontends', 'app.txt'), 'utf8')).toBe('app\n')
      const { stdout: gitStatus } = await execInJob(jobName, [
        'sh', '-c', 'cd /workspace && git status --porcelain',
      ])
      expect(gitStatus.trim()).toBe('')

      // A second workspace installs concurrently. Each pod needs its own
      // pnpm store, since pnpm's SQLite index cannot be shared across pods.
      await createWorkspace('kitchen', '--tool', 'claude')
      const secondPod = await findWorkspacePod('kitchen', new Set([workspaceId]))
      const install = (job: string): Promise<{ stdout: string }> => execInJob(job, [
        'sh', '-c',
        'cd /workspace && printf \'{"name":"kitchen","private":true,"dependencies":{"is-number":"7.0.0"}}\' > package.json'
        + ' && pnpm install 2>&1'
        + ' && stat -c %h node_modules/.pnpm/is-number@7.0.0/node_modules/is-number/package.json'
        + ' && echo "store=$pnpm_config_store_dir registry=$(pnpm config get registry)"',
      ], { timeout: 180_000 })
      const [first, other] = await Promise.all([install(jobName), install(secondPod.jobName)])
      for (const { stdout } of [first, other]) {
        // Link count 2: hardlinked, so the store is on the same mount.
        expect(stdout).toMatch(/^2$/m)
        expect(stdout).toContain('store=/workspace/node_modules/.pnpm-store')
        expect(stdout).toContain(`registry=http://yaac-npm-cache.${k8sNamespace()}.svc.cluster.local:4873/`)
      }
      // The fetch went through the cache.
      const { stdout: cacheLog } = await kubectlWithRetry([
        'logs', '-n', k8sNamespace(), 'deployment/yaac-npm-cache',
      ])
      expect(cacheLog).toContain('is-number')
      // A project .npmrc registry overrides the cache.
      const { stdout: projectRegistry } = await execInJob(jobName, [
        'sh', '-c',
        "cd /workspace && printf 'registry=https://registry.npmjs.org/\\n' > .npmrc && pnpm config get registry",
      ])
      expect(projectRegistry.trim()).toBe('https://registry.npmjs.org/')

      const node = await podNode(workspaceId)
      for (const id of [workspaceId, secondPod.workspaceId]) {
        const { exitCode } = await runYaac(serverEnv, 'workspace', 'stop', id)
        expect(exitCode).toBe(0)
      }

      // The node-local sweep removes a stale opencode dir (untouched for two
      // days) and a removed project's tree, but keeps a fresh dir (a create
      // may be staging into it) and live projects' trees.
      const kitchenTree = `${nodeLocalNodePath()}/projects/${secondPod.projectId}`
      const opencodeData = `${kitchenTree}/opencode-data`
      const removedTree = `${nodeLocalNodePath()}/projects/${randomUUID()}`
      await execFileAsync('podman', ['exec', node, 'sh', '-c',
        `mkdir -p ${opencodeData}/dead-workspace ${opencodeData}/staging-workspace ${removedTree}/.cached-packages`
        + ` && touch ${opencodeData}/dead-workspace/opencode.db ${opencodeData}/staging-workspace/opencode.db`
        + ` && find ${opencodeData}/dead-workspace ${removedTree} -exec touch -d '2 days ago' {} +`])
      const pods = await listWorkspacePods()
      await reapNodeLocal({
        projectIds: new Set([secondPod.projectId, ...pods.map((p) => p.projectId)]),
        workspaceIds: new Set(pods.map((p) => p.workspaceId)),
      })
      const onNode = (p: string): Promise<boolean> =>
        execFileAsync('podman', ['exec', node, 'test', '-e', p]).then(() => true, () => false)
      expect(await onNode(`${opencodeData}/dead-workspace`)).toBe(false)
      expect(await onNode(`${opencodeData}/staging-workspace`)).toBe(true)
      expect(await onNode(kitchenTree)).toBe(true)
      expect(await onNode(removedTree)).toBe(false)
    }, 360_000)
  })

  describe('provisioning hand-off + ephemeralModulesPaths [] + npmCache false', () => {
    it('a webapp create with a client id yields a real session of that id, and the provisioning row drops on hand-off', async () => {
      // Also covers ephemeralModulesPaths: [] and npmCache: false. The cache
      // exists, so only the project setting keeps this pod off it.
      await ensureNpmCache()
      await setupProject('no-ephemeral', {
        yaacConfig: { ephemeralModulesPaths: [], npmCache: false },
      })
      const workspaceId = randomUUID()

      const sub = collectSnapshots(server!.lock.port)
      await sub.opened

      // Not awaited, to observe the in-flight row.
      const createDone = fetch(`${base}/api/workspace/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'no-ephemeral', tool: 'claude', workspaceId }),
      }).then((r) => r.text())

      await vi.waitFor(() => expect(sub.latest()?.provisioning.find((p) => p.workspaceId === workspaceId))
        .toMatchObject({ kind: 'create', projectSlug: 'no-ephemeral' }), { timeout: 20_000, interval: 200 })

      const ndjson = await createDone
      expect(ndjson).toContain('"type":"result"')
      expect(ndjson).not.toContain('"type":"error"')

      // The workspace has the client-supplied id...
      const list = await (await fetch(`${base}/api/workspace/list?project=no-ephemeral`)).json() as
        { workspaces: Array<{ workspaceId: string }> }
      expect(list.workspaces.some((s) => s.workspaceId === workspaceId)).toBe(true)

      // ...and replaces the provisioning row; buildSnapshot never shows
      // both.
      await vi.waitFor(() => {
        const snap = sub.latest()
        expect(snap?.workspaces.some((s) => s.workspaceId === workspaceId)).toBe(true)
        expect(snap?.provisioning.some((p) => p.workspaceId === workspaceId)).toBe(false)
      }, { timeout: 20_000, interval: 200 })
      sub.ws.close()

      // No redirect, so no node_modules at all.
      const pod = await findWorkspacePod('no-ephemeral')
      await expect(execInJob(pod.jobName, [
        'test', '-e', '/workspace/node_modules',
      ])).rejects.toThrow()

      // npmCache: false uses npmjs, and the pod lacks the label the cache's
      // policy admits.
      const { stdout: registry } = await execInJob(pod.jobName, ['pnpm', 'config', 'get', 'registry'])
      expect(registry.trim()).toBe('https://registry.npmjs.org/')
      const { stdout: dial } = await execInJob(pod.jobName, [
        'sh', '-c',
        `curl -s -o /dev/null -m 5 -w '%{http_code}' http://yaac-npm-cache.${k8sNamespace()}.svc.cluster.local:4873/-/ping || true`,
      ])
      expect(dial.trim()).toBe('000')
    }, 240_000)
  })

  describe('codex session', () => {
    let jobName = ''

    beforeAll(async () => {
      const projectPath = await setupProject('codex-demo')
      // With a codex dir, create writes a placeholder ChatGPT-mode
      // auth.json (writeProjectCodexPlaceholder) so codex skips its login.
      await fs.mkdir(path.join(projectPath, 'codex'), { recursive: true })
      const created = await createWorkspace('codex-demo', '--tool', 'codex')
      jobName = created.jobName
    }, 240_000)

    it('mounts shared Claude and Codex state', async () => {
      const pod = await findWorkspacePod('codex-demo')
      expect(pod.labels['yaac.tool']).toBe('codex')
      await execInJob(jobName, ['test', '-d', '/home/yaac/.claude'])
      await execInJob(jobName, ['test', '-f', '/home/yaac/.claude.json'])
      await execInJob(jobName, ['test', '-d', '/home/yaac/.codex'])
    }, 60_000)

    it('boots codex-cli and round-trips a prompt through the mock LLM', async () => {
      // Covers the placeholder auth.json, the Bearer swap on chatgpt.com,
      // and the Responses-API SSE shape.
      const send = async (...keys: string[]): Promise<void> => {
        for (const k of keys) {
          await execInJob(jobName, [
            'tmux', '-S', CONTAINER_TMUX_SOCK, 'send-keys',
            '-t', 'yaac:codex', k,
          ])
          await sleep(400)
        }
      }
      // Visible window only: dismissed dialogs linger in scrollback.
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
      // Codex may show modal prompts, possibly after the composer has
      // rendered: folder trust (Enter), hook review ("Trust all and
      // continue"), and a model upgrade ("Use existing model"). Modals are
      // dismissed as they appear and the prompt is typed only when the
      // composer's placeholder shows, since the banner and the `\u203a`
      // marker also appear under a modal.
      const DIALOGS = [
        { name: 'trust', match: /Trust this folder\?/i, keys: ['Enter'] },
        { name: 'hooks', match: /Hooks need review|Trust all and continue/i, keys: ['Down', 'Enter'] },
        { name: 'upgrade', match: /Introducing GPT|Try new model|Use existing model/i, keys: ['Down', 'Enter'] },
      ] as const
      const seen = new Set<string>()
      let lastPane = ''
      // Polls to wait before re-typing, so a slow render is not typed twice.
      let cooldown = 0
      // Done only once the typed text echoes in the composer.
      const typed = await vi.waitFor(async () => {
        lastPane = await capturePane()
        if (lastPane.includes('hello mock')) return
        const dialog = DIALOGS.find((d) => d.match.test(lastPane))
        if (dialog) {
          seen.add(dialog.name)
          await send(...dialog.keys)
          // Anything typed before this modal went to the modal.
          cooldown = 0
        } else if (/Ask Codex to do anything/i.test(lastPane)) {
          if (cooldown === 0) {
            await send('hello mock')
            cooldown = 6
          } else cooldown--
        }
        throw new Error('prompt not typed yet')
      }, { timeout: 120_000, interval: 500 }).then(() => true, () => false)
      if (!typed) {
        console.error('composer never echoed the prompt (dialogs seen: '
          + (Array.from(seen).join(', ') || 'none') + ')')
        console.error('final pane:\n' + lastPane)
      }
      expect(typed).toBe(true)
      await send('Enter')

      // Poll for the reply, resending Enter as in the claude case.
      let pane = ''
      let polls = 0
      const hitMockText = await vi.waitFor(async () => {
        pane = await capturePane()
        if (pane.includes('Hello from mock')) return
        if (++polls % 3 === 0) await send('Enter')
        throw new Error('no reply from the mock yet')
      }, { timeout: 120_000, interval: 500 }).then(() => true, () => false)

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

      // The prompt reached the mock with the real token swapped in.
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
      const created = await createWorkspace('oc-demo', '--tool', 'opencode')
      jobName = created.jobName
    }, 240_000)

    it('boots opencode and answers a session probe from inside the container', async () => {
      // Wait for the TUI's prompt box: some opencode releases never draw
      // under gVisor. Wait before starting any other opencode server, too:
      // two servers creating the SQLite schema at once race, and if the
      // TUI's loses, the TUI and the tmux server exit.
      await vi.waitFor(async () => {
        const { stdout: pane } = await execInJob(jobName, [
          'sh', '-c', `tmux -S ${CONTAINER_TMUX_SOCK} capture-pane -t yaac:opencode -p`,
        ])
        expect(pane).toMatch(/Ask anything/)
      }, { timeout: 30_000, interval: 1000 })

      // The server's opencode probe (runtime/agents/opencode.ts) uses this
      // same `opencode api session.get` command.
      const { stdout: created } = await execInJob(jobName, [
        'sh', '-c', 'opencode api --standalone session.create -d \'{"title":"probe-me"}\'',
      ])
      const id = (JSON.parse(created.trim()) as { data?: { id?: string } }).data?.id ?? ''
      const { stdout } = await execInJob(jobName, [
        'sh', '-c', `opencode api --standalone session.get --param sessionID=${id}`,
      ])
      expect((JSON.parse(stdout.trim()) as { data?: { title?: unknown } }).data?.title).toBe('probe-me')
    }, 180_000)

    it('mounts the shared opencode-config dir and pins the install', async () => {
      // Shared across workspaces so opencode's settings survive the pod.
      const hostOcConfigDir = path.join(projectPath, 'opencode-config')
      const hostConfigStat = await fs.stat(hostOcConfigDir)
      expect(hostConfigStat.isDirectory()).toBe(true)

      // Keeps opencode on the pinned release.
      const { stdout: autoUpdOut } = await execInJob(jobName, [
        'sh', '-c', 'printenv OPENCODE_DISABLE_AUTOUPDATE',
      ])
      expect(autoUpdOut.trim()).toBe('1')

      // The env var follows the credential's provider (OpenRouter here).
      const { stdout: orKeyOut } = await execInJob(jobName, [
        'sh', '-c', 'printenv OPENROUTER_API_KEY',
      ])
      expect(orKeyOut.trim()).toBe('yaac-ph-api-key')
      const { stdout: nwKeyOut } = await execInJob(jobName, [
        'sh', '-c', 'printenv NEURALWATT_API_KEY || true',
      ])
      expect(nwKeyOut.trim()).toBe('')

      // A host write shows up in the pod, allowing for NFS attribute
      // caching (up to a second on the e2e-byo tier).
      await fs.writeFile(
        path.join(hostOcConfigDir, 'opencode.json'),
        JSON.stringify({ model: 'anthropic/claude-sonnet-4-5' }),
      )
      await vi.waitFor(async () => {
        const { stdout } = await execInJob(jobName, ['cat', '/home/yaac/.config/opencode/opencode.json'])
        expect(JSON.parse(stdout.trim())).toEqual({ model: 'anthropic/claude-sonnet-4-5' })
      }, { timeout: 30_000, interval: 500 })
    }, 60_000)

    it('checkpoints its history to the global tier at stop, leaves nothing on the node, and resumes from it', async () => {
      // Last opencode test: it stops and restarts the workspace. The pod
      // works on a node-local copy of its opencode data and the global
      // checkpoint is the durable one (docs/workspace-storage.md). A stop
      // must checkpoint the database and empty the node copy; a restart
      // must restore from the checkpoint, ignoring anything on the node.
      const { workspaceId, projectId } = await findWorkspacePod('oc-demo')
      const node = await podNode(workspaceId)
      // A row to look for after the round trip.
      const { stdout: created } = await execInJob(jobName, [
        'sh', '-c', 'opencode api --standalone session.create -d \'{"title":"checkpoint-me"}\'',
      ], { timeout: 60_000 })
      const sessionId = (JSON.parse(created.trim()) as { data?: { id?: string }; id?: string })
      const createdId = sessionId.data?.id ?? sessionId.id
      expect(createdId).toBeTruthy()
      const nodeCopy = `${nodeLocalNodePath()}/projects/${projectId}/opencode-data/${workspaceId}`
      const checkpoint = path.join(projectPath, 'opencode-data', workspaceId)
      const onNode = (p: string): Promise<boolean> =>
        execFileAsync('podman', ['exec', node, 'test', '-e', p]).then(() => true, () => false)
      expect(await onNode(nodeCopy)).toBe(true)

      const stopped = await runYaac(serverEnv, 'workspace', 'stop', workspaceId)
      expect(stopped.exitCode, stopped.stderr).toBe(0)
      // Stop returns before teardown finishes; the preStop hook checkpoints
      // and then empties the node copy.
      await vi.waitFor(async () => expect((await fs.readdir(checkpoint)).some((f) => f.endsWith('.db'))).toBe(true),
        { timeout: 60_000, interval: 500 })
      await vi.waitFor(async () => {
        const { stdout } = await execFileAsync('podman', ['exec', node, 'sh', '-c', `ls -A ${nodeCopy} 2>/dev/null | wc -l`])
        expect(stdout.trim()).toBe('0')
      }, { timeout: 60_000, interval: 250 })

      // A checkpoint can have a WAL beside its db. Commit a title change to
      // the WAL only (exit without closing); the restore must include it.
      await execFileAsync('python3', ['-c', [
        'import os, sqlite3, sys',
        'c = sqlite3.connect(sys.argv[1], isolation_level=None)',
        "c.execute('pragma journal_mode=wal')",
        "c.execute('update session_v2 set title = ? where id = ?', ('wal-only-title', sys.argv[2]))",
        'os._exit(0)',
      ].join('\n'), path.join(checkpoint, 'opencode.db'), createdId ?? ''])
      await expect(fs.stat(path.join(checkpoint, 'opencode.db-wal'))).resolves.toBeTruthy()

      // Node leftovers must be discarded on the next start.
      await execFileAsync('podman', ['exec', node, 'sh', '-c', `mkdir -p ${nodeCopy} && echo junk > ${nodeCopy}/junk.txt`])

      // A host path in alternates, as a containerless launch leaves it. The
      // restart must rewrite it to the pod's mount of the main clone
      // (buildCloneLinkExec).
      const alternates = path.join(projectPath, 'workspaces', workspaceId, '.git', 'objects', 'info', 'alternates')
      await fs.writeFile(alternates, `${path.join(projectPath, 'repo', '.git', 'objects')}\n`)

      const restarted = await runYaac(serverEnv, 'workspace', 'restart', workspaceId)
      expect(restarted.exitCode, restarted.stderr).toBe(0)
      jobName = (await findWorkspacePod('oc-demo')).jobName
      const line = (await fs.readFile(alternates, 'utf8')).trim()
      expect(line).toMatch(/\/projects\/oc-demo\/repo\/\.git\/objects$/)
      expect(line).not.toBe(path.join(projectPath, 'repo', '.git', 'objects'))
      await execInJob(jobName, ['git', '-C', '/workspace', 'status', '--porcelain'])
      // The main clone is read-only.
      await expect(execInJob(jobName, ['touch', path.join(path.dirname(line), 'planted')])).rejects.toThrow()
      await expect(execInJob(jobName, ['test', '-e', '/repo'])).rejects.toThrow()
      await expect(execInJob(jobName, ['test', '-e', '/home/yaac/.local/share/opencode/junk.txt'])).rejects.toThrow()
      const listed = await vi.waitFor(async () => {
        const { stdout } = await execInJob(jobName, ['sh', '-c', 'opencode api --standalone session.list'], { timeout: 60_000 })
        expect(stdout).toContain(createdId)
        return stdout
      }, { timeout: 180_000, interval: 1000 })
      expect(listed).toContain('wal-only-title')
      // A fresh checkpoint removes the stale WAL.
      await vi.waitFor(async () => {
        await execInJob(jobName, ['/usr/local/bin/yaac-opencode-checkpoint'], { timeout: 60_000 })
        await expect(fs.stat(path.join(checkpoint, 'opencode.db-wal'))).rejects.toThrow()
      }, { timeout: 120_000, interval: 500 })
    }, 300_000)
  })

  /** --prompt, --model, --permission-mode and --branch on one workspace. */
  describe('create-time overrides (--prompt, --model, --branch)', () => {
    const SLUG = 'overridden'
    let jobName = ''
    let createStdout = ''
    const marker = 'summarize the pinned issues'

    beforeAll(async () => {
      const projectPath = await setupProject(SLUG, {
        extraBranches: { dev: { 'dev-only.txt': 'dev content\n' } },
      })
      // Skip claude's onboarding, as in the kitchen-sink workspace.
      await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
      await fs.writeFile(path.join(projectPath, 'claude', '.claude.json'), JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: AGENT_CLIS.claude.version,
        customApiKeyResponses: { approved: ['yaac-ph-api-key'], rejected: [] },
        projects: {
          '/workspace': { hasTrustDialogAccepted: true },
        },
      }) + '\n')
      await fs.writeFile(path.join(projectPath, 'claude', 'settings.json'), JSON.stringify({
        skipDangerousModePermissionPrompt: true,
      }) + '\n')

      const created = await createWorkspace(
        SLUG, '--tool', 'claude', '--prompt', marker, '--model', 'claude-opus-4-8',
        '--permission-mode', 'accept-edits', '--branch', 'dev',
      )
      jobName = created.jobName
      createStdout = created.stdout
    }, 240_000)

    it('types the prompt into the agent pane and submits it, no attach needed', async () => {
      // The server pastes and submits the prompt (buildPromptPasteCmd); the
      // mock's reply in the pane shows it was sent.
      await vi.waitFor(async () => {
        const { stdout: pane } = await execInJob(jobName, [
          'sh', '-c',
          `tmux -S ${CONTAINER_TMUX_SOCK} capture-pane -t yaac:claude -p -S - -E - 2>&1`,
        ])
        if (!pane.includes(marker) || !pane.includes('Hello from mock')) throw new Error(`final pane:\n${pane}`)
      }, { timeout: 120_000, interval: 1000 })
    }, 240_000)

    it('launches claude with the requested --model and --permission-mode', async () => {
      // Check the flags claude was launched with, not what its TUI shows.
      const { stdout: startCmd } = await execInJob(jobName, [
        'sh', '-c',
        `tmux -S ${CONTAINER_TMUX_SOCK} display -p -t yaac:claude "#{pane_start_command}"`,
      ])
      expect(startCmd).toContain(
        'claude --permission-mode acceptEdits --model claude-opus-4-8',
      )
    }, 60_000)


    it('--branch lands on the requested branch and tracks it', async () => {
      // The prewarmed path is in workspace-prewarm.test.ts.
      expect(createStdout).toContain('Creating workspace from dev...')

      const { stdout: upstream } = await execInJob(jobName, [
        'git', '-C', '/workspace', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}',
      ])
      expect(upstream.trim()).toBe('origin/dev')
      const { stdout: devFile } = await execInJob(jobName, ['cat', '/workspace/dev-only.txt'])
      expect(devFile).toBe('dev content\n')
    }, 60_000)

    it('--branch rejects a branch missing from origin, leaving no pod and no checkout', async () => {
      // The checkout dir is staged before provisioning, and its row is
      // rolled back on failure, so no later sweep would find a leftover dir.
      // Counted, since the server picks the id.
      const workspacesRoot = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces')
      const ls = async (dir: string): Promise<string[]> =>
        (await fs.readdir(dir).catch((): string[] => [])).sort()
      const checkoutsBefore = await ls(workspacesRoot)
      const podsBefore = (await listWorkspacePods(SLUG)).length

      const bad = await runYaac(serverEnv, 'workspace', 'create', SLUG, '--branch', 'ghost')
      expect(bad.exitCode).not.toBe(0)
      expect(bad.stdout + bad.stderr).toContain('branch "ghost" not found on origin')
      expect((await listWorkspacePods(SLUG)).length).toBe(podsBefore)

      // Polled: removal waits for the checkout step to settle, so it cannot
      // run before a still-fetching checkout lands.
      await vi.waitFor(async () => expect(await ls(workspacesRoot)).toEqual(checkoutsBefore),
        { timeout: 5_000, interval: 100 })
    }, 60_000)
  })
  describe('agent mode (--mode acp)', () => {
    const SLUG = 'acped'
    let jobName = ''
    let workspaceId = ''
    let agentSessionId = ''

    // An ACP workspace has its own launch command and label, so it gets its
    // own pod, shared by the cases below. It uses `accept-edits` rather than
    // `bypass` so the enforcement path runs: the posture is sent over
    // `session/set_mode` and unsettled asks go to the pane. No case needs a
    // turn to finish.
    beforeAll(async () => {
      await setupProject(SLUG)
      const created = await createWorkspace(
        SLUG, '--tool', 'claude', '--mode', 'acp', '--permission-mode', 'accept-edits',
      )
      jobName = created.jobName
      workspaceId = (await findWorkspacePod(SLUG)).workspaceId

      // The ACP handshake creates the conversation id, which gets recorded.
      agentSessionId = await vi.waitFor(async () => {
        const res = await fetch(`${base}/api/workspace/list?project=${SLUG}`)
        const body = await res.json() as {
          workspaces: Array<{
            workspaceId: string
            agentSessions: Array<{ agentSessionId: string; mode?: string }>
          }>
        }
        const id = body.workspaces
          .find((w) => w.workspaceId === workspaceId)
          ?.agentSessions.find((a) => a.mode === 'acp')?.agentSessionId
        if (!id) throw new Error('no acp conversation recorded yet')
        return id
      }, { timeout: 120_000, interval: 1000 })
    }, 300_000)

    it('runs the agent under acpd, not a TUI, with its socket in the pod', async () => {
      // tmux still supervises the agent, so a dropped connection or server
      // restart leaves a running turn alone. Only the command differs.
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
      // The record is the conversation's only history (the server keeps
      // none). It must hold the ACP stream verbatim, named for the
      // conversation.
      const { stdout: files } = await execInJob(jobName, [
        'sh', '-c', 'ls /home/yaac/.yaac-acp/ 2>/dev/null || true',
      ])
      expect(files).toContain(`${agentSessionId}.jsonl`)

      const { stdout: recorded } = await execInJob(jobName, [
        'sh', '-c', `cat /home/yaac/.yaac-acp/${agentSessionId}.jsonl`,
      ])
      // Both directions are recorded; replay needs the client's own lines to
      // show user turns.
      expect(recorded).toContain('_acpd/life')
      expect(recorded).toContain('"method":"initialize"')
      expect(recorded).toContain('"method":"session/new"')
      expect(recorded).toContain(agentSessionId)
    }, 120_000)

    it('carries a message from the pane through to the agent, and records it', async () => {
      // Pane to server to acpd to agent, checked in acpd's record so it does
      // not depend on the agent's reply.
      const { ws, opened } = openWs(
        `ws://127.0.0.1:${server!.lock.port}/api/acp/attach`
          + `?id=${workspaceId}&session=${encodeURIComponent(agentSessionId)}`,
      )
      await opened
      await sleep(1000)
      // The image travels inline as an ACP image block.
      ws.send(JSON.stringify({
        type: 'prompt',
        text: 'e2e recorded prompt',
        images: [{ type: 'image', mimeType: 'image/png', data: E2E_PNG.toString('base64') }],
      }))

      const recorded = await vi.waitFor(async () => {
        const { stdout } = await execInJob(jobName, ['sh', '-c', `cat /home/yaac/.yaac-acp/${agentSessionId}.jsonl`])
        expect(stdout).toContain('e2e recorded prompt')
        return stdout
      }, { timeout: 120_000, interval: 1000 })
      ws.close()
      expect(recorded).toContain('"method":"session/prompt"')
      expect(recorded).toContain('e2e recorded prompt')
      expect(recorded).toContain(`{"type":"image","mimeType":"image/png","data":"${E2E_PNG.toString('base64')}"}`)
    }, 180_000)

    it('replays the record to a pane that attaches after the fact', async () => {
      // A new attach replays the record from the start.
      const { ws, text, opened } = openWs(
        `ws://127.0.0.1:${server!.lock.port}/api/acp/attach`
          + `?id=${workspaceId}&session=${encodeURIComponent(agentSessionId)}`,
      )
      await opened
      await vi.waitFor(() => expect(text.some((l) => l.includes('e2e recorded prompt'))).toBe(true),
        { timeout: 30_000, interval: 500 })
      ws.close()

      const hello = text.map((l) => JSON.parse(l) as { type: string; events?: Array<{ type: string }> })
        .find((m) => m.type === 'hello')
      expect(hello).toBeDefined()
      // The user turn, image included, comes from the recorded
      // `session/prompt`; the agent echoes user messages only under
      // `session/load`.
      expect(text.some((l) => l.includes('e2e recorded prompt'))).toBe(true)
      expect(text.some((l) => l.includes(E2E_PNG.toString('base64')))).toBe(true)
    }, 120_000)

    it('mounts a pasted image where the pod reads it, at the path the pane pastes', async () => {
      const res = await fetch(`${base}/api/workspace/${workspaceId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: E2E_PNG,
      })
      expect(res.status).toBe(200)
      const { path: pasted } = await res.json() as { path: string }
      expect(pasted.startsWith('/home/yaac/.yaac-attachments/')).toBe(true)
      const { stdout } = await execInJob(jobName, ['sh', '-c', `base64 -w0 ${pasted}`])
      expect(stdout.trim()).toBe(E2E_PNG.toString('base64'))
    }, 60_000)

    it('serves the conversation over /acp/attach', async () => {
      const { ws, text, opened } = openWs(
        `ws://127.0.0.1:${server!.lock.port}/api/acp/attach`
          + `?id=${workspaceId}&session=${encodeURIComponent(agentSessionId)}`,
      )
      await opened
      // `hello` carries the event log a chat pane renders on attach.
      await vi.waitFor(() => expect(text.length).toBeGreaterThan(0), { timeout: 15_000, interval: 500 })
      ws.close()
      const hello = JSON.parse(text[0]) as {
        type: string
        agentSessionId?: string
        events?: unknown[]
      }
      expect(hello.type).toBe('hello')
      expect(hello.agentSessionId).toBe(agentSessionId)
      expect(Array.isArray(hello.events)).toBe(true)
    }, 60_000)

    /**
     * The other three adapters, using the real pinned binaries. Only the
     * handshake runs: by then the launch command, the conversation id and the
     * posture are all settled. These are claims about upstream packages that a
     * version bump could break, which unit tests check only against tables.
     */
    const REAL_ADAPTERS: Array<{
      tool: 'codex' | 'opencode' | 'pi'
      posture: string
      launch: string[]
      /** The mode id the adapter is told, where it has one for the posture. */
      modeId?: string
      /** A protocol call the adapter needs because it takes no model at launch. */
      method?: string
      /** The mode the adapter reports at `session/new`, where yaac relies on it. */
      defaultModeId?: string
    }> = [
      {
        // Not `auto`: codex-acp already defaults to `agent`, so no
        // `session/set_mode` would be sent. `accept-edits` maps to
        // `workspace-write`, where a failed switch would leave the
        // conversation looser than requested.
        tool: 'codex',
        posture: 'accept-edits',
        launch: ['NO_BROWSER=1', 'CODEX_PATH=codex', 'codex-acp'],
        modeId: 'workspace-write',
        // A failed mode switch is reported in the pane because this default
        // is looser than `accept-edits`; a release changing it must be caught.
        defaultModeId: 'agent',
      },
      {
        // The posture uses the same config document as the TUI. The ACP path
        // ignores the config's `model`, so the model is sent after the
        // handshake.
        tool: 'opencode',
        posture: 'accept-edits',
        launch: ['OPENCODE_CONFIG_CONTENT=', 'opencode acp'],
      },
      {
        // pi has no permission system and cannot take a model at launch, so
        // the model is set with the `model` config option (pi-acp does not
        // route `session/set_model`). That lets the proxy swap the right key.
        tool: 'pi',
        posture: 'bypass',
        launch: ['pi-acp'],
        method: '"method":"session/set_config_option"',
      },
    ]

    it.each(REAL_ADAPTERS)('drives $tool through its real adapter',
      async ({ tool, posture, launch, modeId, method, defaultModeId }) => {
        // Exclude existing pods to find the new one.
        const older = new Set((await listWorkspacePods(SLUG)).map((p) => p.workspaceId))
        await createWorkspace(
          SLUG, '--tool', tool, '--mode', 'acp', '--permission-mode', posture,
        )
        const job = (await findWorkspacePod(SLUG, older)).jobName
        const { stdout: startCmd } = await execInJob(job, [
          'sh', '-c',
          `tmux -S ${CONTAINER_TMUX_SOCK} display -p -t yaac:${tool} "#{pane_start_command}"`,
        ])
        expect(startCmd).toContain('/opt/yaac/acpd/main.js')
        for (const fragment of launch) expect(startCmd).toContain(fragment)

        // A `session/new` reply with an id means the adapter started and
        // accepted yaac declining the `fs/*` and `terminal/*` capabilities.
        const recorded = await vi.waitFor(async () => {
          const { stdout } = await execInJob(job, ['sh', '-c', 'cat /home/yaac/.yaac-acp/*.jsonl 2>/dev/null || true'])
          expect(stdout).toContain('"sessionId"')
          return stdout
        }, { timeout: 180_000, interval: 2000 })
        expect(recorded).toContain('"method":"initialize"')
        if (modeId !== undefined) expect(recorded).toContain(`"modeId":"${modeId}"`)
        if (method !== undefined) expect(recorded).toContain(method)
        // An unrouted call gets "Method not found" and is otherwise silent.
        expect(recorded).not.toContain('-32601')
        if (defaultModeId !== undefined) {
          expect(recorded).toContain(`"currentModeId":"${defaultModeId}"`)
        }
      }, 600_000)

    // A posture the tool lacks would otherwise be a launch flag that silently
    // does nothing.
    it('refuses a posture the tool does not have', async () => {
      await setupProject('no-posture')
      const podsBefore = (await listWorkspacePods('no-posture')).length
      // pi has no permission system, so no `plan`.
      const noPlan = await runYaac(
        serverEnv, 'workspace', 'create', 'no-posture',
        '--tool', 'pi', '--permission-mode', 'plan',
      )
      expect(noPlan.exitCode).not.toBe(0)
      expect(noPlan.stdout + noPlan.stderr).toMatch(/pi has no "plan" permission mode/)
      expect((await listWorkspacePods('no-posture')).length).toBe(podsBefore)
    }, 120_000)

    // Under acp the posture is not a launch flag but a `session/set_mode`
    // call after the handshake.
    it('tells the adapter its posture over the protocol, not on the command line', async () => {
      const { stdout: startCmd } = await execInJob(jobName, [
        'sh', '-c',
        `tmux -S ${CONTAINER_TMUX_SOCK} display -p -t yaac:claude "#{pane_start_command}"`,
      ])
      expect(startCmd).not.toContain('--permission-mode')

      // `accept-edits` is `acceptEdits` on the wire.
      const recorded = await vi.waitFor(async () => {
        const { stdout } = await execInJob(jobName, ['sh', '-c', `cat /home/yaac/.yaac-acp/${agentSessionId}.jsonl`])
        expect(stdout).toContain('session/set_mode')
        return stdout
      }, { timeout: 120_000, interval: 1000 })
      const lines = recorded.split('\n').flatMap((l) => {
        try { return [JSON.parse(l) as Record<string, unknown>] } catch { return [] }
      })
      const setMode = lines.find((m) => m.method === 'session/set_mode')
      expect(setMode?.params).toMatchObject({ modeId: 'acceptEdits' })

      // Check the parsed reply (a substring would also match the request).
      // A refused mode leaves the conversation in its default posture.
      const reply = lines.find((m) =>
        m.method === undefined && m.id === setMode?.id && 'result' in m)
      expect(reply, `no reply to session/set_mode in:\n${recorded}`).toBeDefined()
      expect(reply?.error).toBeUndefined()
    }, 180_000)

    // commander rejects values outside the enum before calling the server.
    it('rejects an unknown --permission-mode at the CLI', async () => {
      const bad = await runYaac(
        serverEnv, 'workspace', 'create', 'no-posture', '--permission-mode', 'yolo',
      )
      expect(bad.exitCode).not.toBe(0)
      expect(bad.stdout + bad.stderr).toMatch(/Allowed choices are bypass, auto, accept-edits/)
    }, 60_000)
  })
})
