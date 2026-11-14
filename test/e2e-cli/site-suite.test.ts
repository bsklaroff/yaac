import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import type net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { git } from '@yaac/test-utils/git'
import { cloneRepo } from '@yaac/server/domain/git'
import { createYaacTestEnv, spawnYaacServer, setTestGitIdentity, runYaac, TEST_CLI_ENTRY, type YaacTestEnv } from '#support/cli'
import { asTailnet, assignTestGitCredential, makeServerApiClient, registerTestProject, type SpawnedServer } from '@yaac/test-utils/api'
import { requireCluster, testContainerOwnerLabel } from '@yaac/test-utils/setup'
import { contextHash } from '@yaac/server/drivers/k8s/cluster'
import { listWorkspacePods } from '@yaac/server/drivers/k8s/substrate/pods'
import { SSH_TUNNEL_SENTINEL, TUNNEL_INGRESS_PORT } from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import { readObject } from '@yaac/server/drivers/k8s/substrate/api'
import { TAILGATE_DIR } from '@yaac/shared/project-paths'
import { requirePodman, cleanupWorkspaceJobs, execInJob } from '#support/cluster'
import { freeLocalPort, startKubectlForward } from '@yaac/test-utils/kubectl-forward'
import { k8sNamespace } from '@yaac/server/drivers/k8s/substrate/api'
import { startMockGit, seedMockGitRepo, cleanupMocks, type MockGit } from '#support/mock-remotes'

/**
 * `yaac site` (docs/public-sites.md): every command and option, on one
 * project and one site whose releases serve a one-line node server, and
 * the deployed release reached through the router by its hostname, as
 * cloudflared would reach it. No tunnel token is given, so `site create`
 * warns that the install has none.
 *
 * Cases run in declaration order over the one site: create, read, edit,
 * a failing then a succeeding deploy, stop and start, following a branch,
 * and delete, then a tailnet site on the server redeployed in tailnet mode.
 */

const execFileAsync = promisify(execFile)

const NAME = 'site-demo'
const DOCS = 'site-demo-docs'
const DOMAIN = 'example.test'

/** GET `/` from the router at `origin` as `host`: status and body. */
function viaRouter(origin: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`${origin}/`, { headers: { host } }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => { body += chunk.toString() })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', reject)
  })
}

/**
 * A graph whose one service, waiting on the volume, appends `text` to a
 * marker there and answers the marker's contents on `port`: what one
 * release wrote, the next one reads.
 */
function servingVolume(port: number, text: string): object {
  const script = `require('http').createServer((q, s) => s.end(require('fs').readFileSync(process.env.YAAC_VOLUME_DIR + '/marker', 'utf8'))).listen(${port})`
  return {
    server: {
      run: [`echo ${text} >> "$YAAC_VOLUME_DIR/marker"`, `node -e "${script}"`],
      service: true, needs: ['volume'], ready: `curl -sf localhost:${port}`,
    },
  }
}

/** A graph whose one service, `step`, answers `text` on `port`. */
function serving(port: number, text: string, step = 'server'): object {
  const script = `require('http').createServer((q, s) => s.end('${text}')).listen(${port})`
  return { [step]: { run: `node -e "${script}"`, service: true, ready: `curl -sf localhost:${port}` } }
}

describe('yaac site (real CLI + real server)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockGit: MockGit | null = null
  let serverEnv: NodeJS.ProcessEnv
  let sha = ''
  let projectId = ''
  let repoPath = ''
  /** The project's second repo, linked in the folder `docs`, at its head. */
  let docsSha = ''
  /** That repo's own project, which allows no tailnet site. */
  let docsProjectId = ''

  const yaac = async (...args: string[]): Promise<string> => {
    const { stdout, stderr, exitCode } = await runYaac(serverEnv, ...args)
    if (exitCode !== 0) throw new Error(`yaac ${args.join(' ')} failed (exit ${exitCode}):\n${stderr}`)
    return stdout
  }
  const refused = async (...args: string[]): Promise<string> => {
    const { stderr, exitCode } = await runYaac(serverEnv, ...args)
    expect(exitCode, args.join(' ')).not.toBe(0)
    return stderr
  }
  /** `yaac forward` of one port of a release onto a free local port, once
   *  it is bound. */
  const forwardRelease = async (release: string, port: number): Promise<{
    origin: string
    output: () => string
    stop: () => void
  }> => {
    const local = await freeLocalPort()
    const child = spawn(process.execPath, [TEST_CLI_ENTRY, 'forward', release, '--port', `${String(port)}:${String(local)}`], {
      env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
    child.stderr.on('data', (c: Buffer) => { out += c.toString('utf8') })
    try {
      await vi.waitFor(() => {
        if (!out.includes('forwarding ')) throw new Error(`yaac forward never bound ${String(port)}:\n${out}`)
      }, { timeout: 30_000, interval: 200 })
    } catch (err) {
      child.kill('SIGTERM')
      throw err
    }
    return { origin: `http://127.0.0.1:${String(local)}`, output: () => out, stop: () => child.kill('SIGTERM') }
  }
  /** A named workflow of `graph`, made or changed, answering its name. */
  const workflowOf = async (name: string, graph: object): Promise<string> => {
    const file = await stepsFile(`${name}.json`, graph)
    const made = await runYaac(serverEnv, 'workflow', 'create', NAME, name, '--file', file)
    if (made.exitCode !== 0) await yaac('workflow', 'edit', NAME, name, '--file', file)
    return name
  }
  const stepsFile = async (file: string, graph: object): Promise<string> => {
    const at = path.join(testEnv.scratchDir, file)
    await fs.writeFile(at, JSON.stringify(graph))
    return at
  }

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
    testEnv = await createYaacTestEnv()
    mockGit = await startMockGit()
    const gitTarget = { host: mockGit.host, port: mockGit.port, tls: false }
    serverEnv = {
      ...testEnv.env,
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify({ 'github.com': gitTarget, 'api.github.com': gitTarget }),
      YAAC_E2E_SKIP_FETCH: '1',
    }
    server = await spawnYaacServer(serverEnv)
    await setTestGitIdentity(serverEnv)

    // Staged as `yaac project add` would stage github.com/test-org/<NAME>.
    await seedMockGitRepo(mockGit, NAME, { files: { 'README.md': '# site\n' } })
    projectId = randomUUID()
    // The main clone of the project's repo, which carries the project's id.
    repoPath = path.join(testEnv.dataDir, 'global', 'repos', projectId)
    await cloneRepo(path.join(mockGit.reposDir, `${NAME}.git`), repoPath, null)
    const remote = `https://github.com/test-org/${NAME}.git`
    await git(repoPath, ['remote', 'set-url', 'origin', remote])
    await registerTestProject(server, projectId, NAME, remote)
    await assignTestGitCredential(server, projectId, 'fake-ghp-token')
    sha = (await git(repoPath, ['rev-parse', 'HEAD'])).trim()

    // A second repo, linked as `docs`: a staged project's repo carries the
    // project's id.
    await seedMockGitRepo(mockGit, DOCS, { files: { 'docs.md': '# docs\n' } })
    const docsId = randomUUID()
    docsProjectId = docsId
    const docsPath = path.join(testEnv.dataDir, 'global', 'repos', docsId)
    await cloneRepo(path.join(mockGit.reposDir, `${DOCS}.git`), docsPath, null)
    await git(docsPath, ['remote', 'set-url', 'origin', `https://github.com/test-org/${DOCS}.git`])
    await registerTestProject(server, docsId, DOCS, `https://github.com/test-org/${DOCS}.git`)
    await assignTestGitCredential(server, docsId, 'fake-ghp-token')
    await yaac('project', 'repo', 'add', NAME, '--repo-id', docsId.slice(0, 8), '--dir', 'docs')
    docsSha = (await git(docsPath, ['rev-parse', 'HEAD'])).trim()

    await yaac('volume', 'create', NAME, 'data', '--size', '1Gi')
  }, 300_000)

  afterAll(async () => {
    if (server) await server.stop()
    server = null
    await cleanupWorkspaceJobs()
    await cleanupMocks([mockGit])
    mockGit = null
    await testEnv.cleanup()
  })

  it('create needs --hostname, --port, --workflow and --repo, refuses a malformed hostname, port or repo, and prints the tunnel\'s settings', async () => {
    const steps = await workflowOf('v1', serving(3000, 'v1'))
    const repo = ['--repo', `${NAME}@main`]
    expect(await refused('site', 'create', NAME, 'web', '--port', '3000', '--workflow', steps, ...repo))
      .toContain('--hostname <host>')
    expect(await refused('site', 'create', NAME, 'web', '--hostname', `app.${DOMAIN}`, '--port', 'http', '--workflow', steps, ...repo))
      .toContain('--port takes a port number')
    expect(await refused('site', 'create', NAME, 'web', '--hostname', `app.${DOMAIN}`, '--port', '3000', '--admin-port', 'x', '--workflow', steps, ...repo))
      .toContain('--admin-port takes a port number')
    expect(await refused('site', 'create', NAME, 'web', '--hostname', `https://app.${DOMAIN}`, '--port', '3000', '--workflow', steps, ...repo))
      .toContain('is not a hostname')
    // Its repos are required, each at a branch or commit, and none falls
    // back to a default branch.
    expect(await refused('site', 'create', NAME, 'web', '--hostname', `app.${DOMAIN}`, '--port', '3000', '--workflow', steps))
      .toContain('Name the repos')
    expect(await refused('site', 'create', NAME, 'web', '--hostname', `app.${DOMAIN}`, '--port', '3000', '--workflow', steps, '--repo', NAME))
      .toContain('--repo takes <dir>@<branch or full commit>')
    expect(await refused('site', 'create', NAME, 'web', '--hostname', `app.${DOMAIN}`, '--port', '3000', '--workflow', steps, '--no-repos'))
      .toContain('at least one repo')
    expect(await refused('site', 'create', NAME, 'web', '--hostname', `app.${DOMAIN}`, '--port', '3000', '--workflow', steps, '--repo', `${NAME}@a..b`))
      .toContain('is not a branch name')
    expect(await refused('site', 'create', NAME, 'web', '--hostname', `app.${DOMAIN}`, '--port', '3000', '--workflow', steps, '--repo', 'nope@main'))
      .toContain('has no repo "nope"')
    expect(await yaac('site', 'list', NAME)).toContain(`No sites in ${NAME}`)

    // --repo names a repo its releases start with, by its folder.
    const created = await yaac('site', 'create', NAME, 'web', '--hostname', `app.${DOMAIN}`, '--port', '3000',
      '--admin-port', '3002', '--workflow', steps, '--volume', 'data', ...repo)
    expect(created).toContain('Created site "web"')
    expect(created).toContain(`hostname  app.${DOMAIN}`)
    expect(created).toContain('service   http://yaac-site-router:8080')
    expect(created).toContain('no tunnel yet')
  })

  it('list and show name its hostname, ports, workflow and volume before any deploy', async () => {
    expect(await yaac('site', 'list', NAME))
      .toMatch(/NAME\s+HOSTNAME\s+EDGE\s+PORT\s+LIVE[\s\S]*web\s+app\.example\.test\s+public\s+3000\s+-/)
    const shown = await yaac('site', 'show', NAME, 'web')
    expect(shown).toContain(`https://app.${DOMAIN} -> port 3000`)
    expect(shown).toMatch(/edge\s+public/)
    expect(shown).toMatch(/admin port\s+3002/)
    expect(shown).toMatch(/workflow\s+v1 \(server\)/)
    expect(shown).toMatch(/volume\s+data/)
    expect(shown).toMatch(new RegExp(`repos\\s+${NAME}@main`))
    expect(shown).toMatch(/follow\s+no/)
  })

  it('edit changes --hostname, --port, --workflow and --volume, and --no-admin-port and --no-volume drop theirs', async () => {
    expect(await refused('site', 'edit', NAME, 'web')).toContain('Nothing to change')
    const failing = await workflowOf('failing', { build: { run: 'exit 3' }, ...serving(3001, 'v2') })
    await yaac('site', 'edit', NAME, 'web', '--hostname', `www.${DOMAIN}`, '--port', '3001', '--workflow', failing,
      '--no-admin-port', '--no-volume')
    let shown = await yaac('site', 'show', NAME, 'web')
    expect(shown).toContain(`https://www.${DOMAIN} -> port 3001`)
    expect(shown).toMatch(/admin port\s+-/)
    expect(shown).toMatch(/workflow\s+failing \(build, server\)/)
    expect(shown).toMatch(/volume\s+-/)
    await yaac('site', 'edit', NAME, 'web', '--volume', 'data')
    expect(await yaac('site', 'show', NAME, 'web')).toMatch(/volume\s+data/)
    await yaac('site', 'edit', NAME, 'web', '--no-volume')
    shown = await yaac('site', 'show', NAME, 'web')
    expect(shown).toMatch(/volume\s+-/)
  })

  it('deploy --wait exits non-zero when the release fails, and 0 once it serves --ref, its admin port to its owner alone', async () => {
    const failed = await runYaac(serverEnv, 'site', 'deploy', NAME, 'web', '--wait')
    expect(failed.exitCode).not.toBe(0)
    expect(failed.stdout).toContain('The deploy failed')
    expect(await yaac('site', 'list', NAME)).toMatch(/web\s+www\.example\.test\s+public\s+3001\s+-\s+failed/)

    const withAdmin = { ...serving(3001, 'v2'), ...serving(3002, 'admin', 'admin') }
    // A workflow gives the site's releases a run secret as it is; the
    // owner's deploy below approves its commit.
    const given = await runYaac(serverEnv, 'config', 'env', NAME, 'RELAY_KEY', '--run-secret', { stdin: 'relay-key-value\n' })
    expect(given.exitCode, given.stderr).toBe(0)
    await yaac('workflow', 'create', NAME, 'web', '--file', await stepsFile('v2.json', withAdmin), '--secret', 'RELAY_KEY')
    await yaac('site', 'edit', NAME, 'web', '--admin-port', '3002', '--workflow', 'web')
    const deployed = await runYaac(serverEnv, 'site', 'deploy', NAME, 'web', '--ref', sha, '--timeout', '10m', '--wait')
    expect(deployed.exitCode, deployed.stderr).toBe(0)
    expect(deployed.stdout).toContain(`Deploying ${sha.slice(0, 8)} to site "web"`)
    expect(deployed.stdout).toContain(`Deployed: https://www.${DOMAIN} serves ${sha.slice(0, 8)}.`)
    expect(await yaac('site', 'list', NAME)).toMatch(new RegExp(`web\\s+www\\.example\\.test\\s+public\\s+3001\\s+${sha.slice(0, 8)} running`))
    const shown = await yaac('site', 'show', NAME, 'web')
    expect(shown).toMatch(/RELEASE\s+COMMITS\s+STARTED\s+STOPPED/)
    expect(shown).toContain(sha.slice(0, 8))

    // The router serves the release at its hostname (a new route reaches it
    // within the kubelet's ConfigMap sync), and nothing at any other.
    const router = await startKubectlForward({ namespace: k8sNamespace(), target: 'service/yaac-site-router', remotePort: 8080 })
    try {
      await vi.waitFor(async () => {
        expect(await viaRouter(router.origin, `www.${DOMAIN}`)).toEqual({ status: 200, body: 'v2' })
      }, { timeout: 120_000, interval: 2_000 })
      expect((await viaRouter(router.origin, `nope.${DOMAIN}`)).status).toBe(404)
    } finally {
      await router.stop()
    }

    // Code facing the internet may not act on yaac.
    const release = /live\s+\S+ running in (\S+),/.exec(shown)?.[1]
    expect(release).toBeDefined()
    const { stdout } = await execInJob(`yaac-${release}`, [
      'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', '-H', 'content-type: application/json',
      '-d', '{"command":"list"}', 'http://yaac.internal/api/workspace/mama',
    ])
    expect(stdout).toBe('403')
    expect((await execInJob(`yaac-${release}`, ['printenv', 'RELAY_KEY'])).stdout.trim()).toBe('relay-key-value')

    // The admin port is the one port the release offers, and its owner
    // reaches it as any workspace's forward.
    const api = makeServerApiClient(server!)
    const { workspaces } = await (await api.workspace.list.$get({ query: { project: projectId } })).json()
    expect(workspaces.find((w) => w.workspaceId === release)?.forwardedPorts.map((p) => p.containerPort)).toEqual([3002])
    const admin = await forwardRelease(release!, 3002)
    try {
      await vi.waitFor(async () => {
        expect(await viaRouter(admin.origin, 'localhost')).toEqual({ status: 200, body: 'admin' })
      }, { timeout: 30_000, interval: 500 })
    } finally {
      admin.stop()
    }
    // Nothing else of the release is: not the port the internet reaches,
    // nor streamd, though both listen.
    for (const port of [3001, 10300]) {
      const stray = await forwardRelease(release!, port)
      try {
        await expect(viaRouter(stray.origin, 'localhost')).rejects.toThrow()
        expect(stray.output()).toMatch(/dial failed/)
      } finally {
        stray.stop()
      }
    }
  }, 600_000)

  it('stop takes the live release down, and start brings one back at its commits', async () => {
    expect(await yaac('site', 'stop', NAME, 'web')).toContain('Stopped site "web"')
    expect(await yaac('site', 'list', NAME)).toMatch(/web\s+www\.example\.test\s+public\s+3001\s+-\s/)
    expect(await yaac('site', 'start', NAME, 'web')).toMatch(new RegExp(`Starting site "web" at ${sha.slice(0, 8)} in release \\S+`))
    await vi.waitFor(async () => {
      expect(await yaac('site', 'list', NAME)).toContain(`${sha.slice(0, 8)} running`)
    }, { timeout: 300_000, interval: 2_000 })
  }, 360_000)

  // The server here never fetches, so the tip moves in the main clone as a
  // fetch would move it, and the next reconcile pass sees it.
  it('edit --follow deploys each move of its branch, deploy refuses another ref, and --no-follow stops following', async () => {
    expect(await refused('site', 'edit', NAME, 'web', '--repo', `${NAME}@origin/main`)).toContain('by its own name')
    expect(await yaac('site', 'edit', NAME, 'web', '--follow')).toContain('it deploys whenever one of its branches moves')
    expect(await yaac('site', 'show', NAME, 'web')).toMatch(/follow\s+yes/)
    expect(await refused('site', 'deploy', NAME, 'web', '--ref', sha)).toContain('follows its repos\' branches')

    const next = (await git(repoPath, ['commit-tree', `${sha}^{tree}`, '-p', sha, '-m', 'next'])).trim()
    await git(repoPath, ['update-ref', 'refs/remotes/origin/main', next])
    await vi.waitFor(async () => {
      expect(await yaac('site', 'list', NAME)).toContain(`${next.slice(0, 8)} running`)
    }, { timeout: 300_000, interval: 2_000 })

    await yaac('site', 'edit', NAME, 'web', '--no-follow')
    expect(await yaac('site', 'show', NAME, 'web')).toMatch(/follow\s+no/)
  }, 360_000)

  it('deploys a release of two repos, each in its folder, at a --ref per repo, and shows its commits', async () => {
    await yaac('site', 'edit', NAME, 'web', '--repo', `${NAME}@main`, '--repo', `docs@${docsSha}`)
    expect(await yaac('site', 'show', NAME, 'web')).toMatch(new RegExp(`repos\\s+${NAME}@main docs@${docsSha}`))
    const deployed = await runYaac(serverEnv, 'site', 'deploy', NAME, 'web', '--ref', `${NAME}@${sha}`, '--timeout', '10m', '--wait')
    expect(deployed.exitCode, deployed.stderr).toBe(0)
    const commits = `docs@${docsSha.slice(0, 8)} ${NAME}@${sha.slice(0, 8)}`
    expect(deployed.stdout).toContain(`Deploying ${commits} to site "web"`)
    const shown = await yaac('site', 'show', NAME, 'web')
    expect(shown).toContain(`live         ${commits} running`)
    expect(shown).toMatch(new RegExp(`\\S+\\s+${commits}\\s`))
    // Back to its one repo for the cases after.
    await yaac('site', 'edit', NAME, 'web', '--repo', `${NAME}@main`)
  }, 600_000)

  // The staged handoff (docs/public-sites.md "Volumes: a staged handoff"):
  // the second release mounts the volume while the first holds it, waits
  // for the first's pod to be gone, then takes the lease and reads what the
  // first wrote. The site answers 503 only in that gap.
  it('hands the volume from one release to the next, which reads what the first wrote', async () => {
    const api = makeServerApiClient(server!)
    await yaac('site', 'edit', NAME, 'web', '--volume', 'data', '--workflow', await workflowOf('vol1', servingVolume(3001, 'one')))
    const first = await runYaac(serverEnv, 'site', 'deploy', NAME, 'web', '--wait')
    expect(first.exitCode, first.stderr).toBe(0)
    const firstRelease = /in release (\S+)\./.exec(first.stdout)?.[1]

    const router = await startKubectlForward({ namespace: k8sNamespace(), target: 'service/yaac-site-router', remotePort: 8080 })
    try {
      await vi.waitFor(async () => {
        expect(await viaRouter(router.origin, `www.${DOMAIN}`)).toEqual({ status: 200, body: 'one\n' })
      }, { timeout: 120_000, interval: 2_000 })

      await yaac('site', 'edit', NAME, 'web', '--workflow', await workflowOf('vol2', servingVolume(3001, 'two')))
      const seen = new Set<number>()
      let polling = true
      const poller = (async () => {
        while (polling) {
          seen.add((await viaRouter(router.origin, `www.${DOMAIN}`).catch(() => ({ status: 0 }))).status)
          await new Promise((r) => setTimeout(r, 200))
        }
      })()
      const second = await runYaac(serverEnv, 'site', 'deploy', NAME, 'web', '--wait')
      expect(second.exitCode, second.stderr).toBe(0)
      const secondRelease = /in release (\S+)\./.exec(second.stdout)?.[1]
      await vi.waitFor(async () => {
        expect(await viaRouter(router.origin, `www.${DOMAIN}`)).toEqual({ status: 200, body: 'one\ntwo\n' })
      }, { timeout: 60_000, interval: 1_000 })
      polling = false
      await poller
      expect(seen.has(503)).toBe(true)

      // The lease ended on the new release, whose volume step started only
      // once the old release had stopped.
      const volumes = await (await api.volume.list.$get({ query: { project: projectId } })).json()
      expect(volumes.find((v) => v.name === 'data')?.holder?.workspaceId).toBe(secondRelease)
      const shown = await (await api.site.show.$get({ query: { project: projectId, name: 'web' } })).json()
      const stoppedAt = shown.releases.find((r) => r.workspaceId === firstRelease)?.stoppedAt
      const { workspaces } = await (await api.workspace.list.$get({ query: { project: projectId } })).json()
      const startedAt = workspaces.find((w) => w.workspaceId === secondRelease)?.steps?.find((st) => st.name === 'vol2.server')?.startedAt
      expect(stoppedAt).toBeDefined()
      expect(new Date(startedAt!).getTime()).toBeGreaterThan(new Date(stoppedAt!).getTime())
    } finally {
      await router.stop()
    }
  }, 900_000)

  // Last: it removes the site every case above reads.
  it('delete removes the site', async () => {
    expect(await yaac('site', 'delete', NAME, 'web')).toContain('Deleted site "web"')
    expect(await yaac('site', 'list', NAME)).toContain(`No sites in ${NAME}`)
    expect(await refused('site', 'show', NAME, 'web')).toContain('web')
  }, 120_000)

  /**
   * A tailnet site (docs/public-sites.md "Tailnet sites"). Runs last: it
   * redeploys the file's server in tailnet mode with a site domain, which
   * refuses the loopback CLI the cases above use, so the CLI goes through a
   * stand-in for tailscale serve as alice, whom the built-in user, owner of
   * the project, becomes. No tier has a tailnet, so tailscaled never runs: a
   * workspace reaches the site through the egress proxy, and tailgate's
   * image runs on its own beside a stand-in for tailscaled's local API.
   */
  describe('a tailnet site', () => {
    const HOST = 'srv.tailnet.ts.net'
    const ZONE = 'apps.example.test'
    const SITE = `kanban.${ZONE}`
    const ALICE = asTailnet('alice@example.com', HOST)
    let serve: http.Server | null = null
    let aliceEnv: NodeJS.ProcessEnv
    let routerIp = ''
    let release = ''
    const as = async (...args: string[]): Promise<string> => {
      const { stdout, stderr, exitCode } = await runYaac(aliceEnv, ...args)
      if (exitCode !== 0) throw new Error(`yaac ${args.join(' ')} failed (exit ${exitCode}):\n${stderr}`)
      return stdout
    }
    /** A new workspace of `project`, with no agent, and its pod's job. */
    const workspaceOf = async (project: string, projectId: string): Promise<string> => {
      const before = new Set((await listWorkspacePods(projectId)).map((p) => p.workspaceId))
      await as('workspace', 'create', project, '--no-session')
      return vi.waitFor(async () => {
        const pod = (await listWorkspacePods(projectId)).find((p) => !before.has(p.workspaceId))
        if (!pod) throw new Error(`no new workspace pod in ${project}`)
        return pod.jobName
      }, { timeout: 120_000, interval: 1_000 })
    }
    /** curl from `job`, answering what it printed and its exit code. */
    const curlFrom = async (job: string, args: string[]): Promise<{ out: string; exit: number }> => {
      const { stdout } = await execInJob(job, ['sh', '-c', `curl -sS --max-time 20 ${args.join(' ')} 2>&1; echo "EXIT:$?"`], { timeout: 40_000 })
      const at = stdout.lastIndexOf('EXIT:')
      return { out: stdout.slice(0, at), exit: Number(stdout.slice(at + 5).trim()) }
    }

    beforeAll(async () => {
      await server!.stop()
      server = await spawnYaacServer({
        ...serverEnv,
        YAAC_ACCESS_MODE: 'tailnet',
        YAAC_ACCESS_ADMINS: 'alice@example.com',
        YAAC_ALLOWED_HOSTS: HOST,
        YAAC_SITE_DOMAIN: ZONE,
      })
      const port = server.lock.port
      serve = http.createServer((req, res) => {
        const upstream = http.request({
          host: '127.0.0.1', port, path: req.url, method: req.method, headers: { ...req.headers, ...ALICE },
        }, (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers)
          up.pipe(res)
        })
        req.pipe(upstream)
      })
      await new Promise<void>((resolve) => serve!.listen(0, '127.0.0.1', resolve))
      aliceEnv = { ...serverEnv, YAAC_SERVER_URL: `http://127.0.0.1:${String((serve.address() as net.AddressInfo).port)}` }
      const router = await readObject<{ spec?: { clusterIP?: string } }>({
        apiVersion: 'v1', kind: 'Service', name: 'yaac-site-router', namespace: k8sNamespace(),
      })
      routerIp = router?.spec?.clusterIP ?? ''
      // The zone is the owner's consent to send their login there; the
      // router's exact address would admit a direct dial to it, but for
      // its tailnet port.
      await as('config', 'egress-allowlist', NAME, `*.${ZONE}`, routerIp)
    }, 360_000)

    afterAll(async () => {
      if (serve) await new Promise((resolve) => serve!.close(resolve))
    })

    it('create says a name under the site domain is a tailnet site, and deploy serves it on the tailnet listener only', async () => {
      const echo = `require('http').createServer((q, s) => s.end(JSON.stringify(q.headers))).listen(3000)`
      const file = await stepsFile('echo.json', { server: { run: `node -e "${echo}"`, service: true, ready: 'curl -sf localhost:3000' } })
      await as('workflow', 'create', NAME, 'echo', '--file', file)
      const created = await as('site', 'create', NAME, 'kanban', '--hostname', SITE, '--port', '3000', '--workflow', 'echo',
        '--repo', `${NAME}@main`)
      expect(created).toContain(`Created site "kanban", a tailnet site: https://${SITE} answers only users on this install's tailnet.`)
      expect(created).toContain('no tailnet tunnel yet')
      expect(await as('site', 'list', NAME)).toMatch(/kanban\s+kanban\.apps\.example\.test\s+tailnet\s+3000/)
      expect(await as('site', 'show', NAME, 'kanban')).toMatch(/edge\s+tailnet/)
      const deployed = await runYaac(aliceEnv, 'site', 'deploy', NAME, 'kanban', '--timeout', '10m', '--wait')
      expect(deployed.exitCode, deployed.stderr).toBe(0)
      const shown = await (await makeServerApiClient(server!, ALICE).site.show.$get({ query: { project: projectId, name: 'kanban' } })).json()
      release = shown.live?.workspaceId ?? ''
      expect(release).not.toBe('')

      // The public listener has no virtual host for it.
      const router = await startKubectlForward({ namespace: k8sNamespace(), target: 'service/yaac-site-router', remotePort: 8080 })
      try {
        await vi.waitFor(async () => {
          expect((await viaRouter(router.origin, SITE)).status).toBe(404)
        }, { timeout: 30_000, interval: 1_000 })
      } finally {
        await router.stop()
      }
    }, 900_000)

    it('a workspace reaches it as its owner whatever it sends; a release, a project that has not allowed it and a direct dial to its listener are refused', async () => {
      const job = await workspaceOf(NAME, projectId)
      // The proxy stamps the owner's login over whatever the workspace sent.
      const seen = await vi.waitFor(async () => {
        const r = await curlFrom(job, ['-H', "'Tailscale-User-Login: mallory@example.com'", '-H', "'X-Forwarded-For: 203.0.113.9'", `https://${SITE}/`])
        expect(r.exit, r.out).toBe(0)
        return JSON.parse(r.out) as Record<string, string>
      }, { timeout: 120_000, interval: 2_000 })
      expect(seen['tailscale-user-login']).toBe('alice@example.com')
      expect(seen.host).toBe(SITE)
      expect(seen['x-forwarded-for']).not.toContain('203.0.113.9')

      // Plain HTTP would carry the login in the clear.
      const plain = await curlFrom(job, [`http://${SITE}/`])
      expect(plain.out).toContain(`use https://${SITE}/`)

      // The router's address is allowed exactly, but not on its tailnet port.
      const direct = await curlFrom(job, ['-v', '--proxytunnel', '--proxy', `http://${SSH_TUNNEL_SENTINEL}:${String(TUNNEL_INGRESS_PORT)}`,
        '-H', `'Host: ${SITE}'`, '-H', "'Tailscale-User-Login: mallory@example.com'", `http://${routerIp}:8081/`])
      expect(direct.exit).not.toBe(0)
      expect(direct.out).toMatch(/CONNECT tunnel failed, response 403/)

      // A release acts for no one.
      const releaseJob = (await listWorkspacePods(projectId)).find((p) => p.workspaceId === release)?.jobName ?? ''
      const fromRelease = await curlFrom(releaseJob, ['-o', '/dev/null', '-w', "'%{http_code}'", `https://${SITE}/`])
      expect(fromRelease.out).toBe('403')

      // Another project has not consented to send its owner's login there.
      const other = await workspaceOf(DOCS, docsProjectId)
      const refused = await curlFrom(other, [`https://${SITE}/`])
      expect(refused.exit).not.toBe(0)
      expect(refused.out).not.toContain('alice@example.com')
    }, 600_000)

    it('tailgate\'s image, as the global setup built it, answers the zone and stamps a user\'s request', async () => {
      const dir = await fs.mkdtemp(path.join(testEnv.scratchDir, 'tailgate-'))
      await execFileAsync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-days', '1', '-subj', `/CN=*.${ZONE}`, '-keyout', path.join(dir, 'tls.key'), '-out', path.join(dir, 'tls.crt')])
      await fs.chmod(path.join(dir, 'tls.key'), 0o644)
      // A stand-in for tailscaled's local API and for the router, then a
      // client that dials 443 as tailscaled's serve does: a PROXY line, then
      // TLS.
      await fs.writeFile(path.join(dir, 'stand-ins.mjs'), `
        import http from 'node:http'
        http.createServer((q, s) => s.end(q.url.startsWith('/localapi/v0/status')
          ? JSON.stringify({ TailscaleIPs: ['100.64.0.9'] })
          : JSON.stringify({ Node: {}, UserProfile: { LoginName: 'alice@example.com', DisplayName: 'Alice' } }))).listen('/tmp/ts/tailscaled.sock')
        http.createServer((q, s) => s.end(JSON.stringify(q.headers))).listen(9000, '127.0.0.1')
      `)
      await fs.writeFile(path.join(dir, 'client.mjs'), `
        import net from 'node:net'
        import tls from 'node:tls'
        import dgram from 'node:dgram'
        const name = Buffer.concat('site1.${ZONE}'.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])))
        const q = Buffer.concat([Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), name, Buffer.from([0, 0, 1, 0, 1])])
        const raw = net.connect(8443, '127.0.0.2', () => {
          raw.write('PROXY TCP4 100.64.0.1 100.64.0.9 41000 8443\\r\\n')
          const t = tls.connect({ socket: raw, servername: 'site1.${ZONE}', rejectUnauthorized: false }, () => {
            t.write('GET / HTTP/1.1\\r\\nHost: site1.${ZONE}\\r\\nTailscale-User-Login: mallory\\r\\nConnection: close\\r\\n\\r\\n')
          })
          let out = ''
          t.on('data', (c) => { out += c })
          t.on('close', () => {
            const udp = dgram.createSocket('udp4')
            udp.on('message', (m) => { console.log(out.slice(out.indexOf('\\r\\n\\r\\n') + 4)); console.log('DNS ' + [...m.subarray(m.length - 4)].join('.')); process.exit(0) })
            udp.send(q, 53, '127.0.0.1')
          })
        })
      `)
      const image = `yaac-test-tailgate:${await contextHash(TAILGATE_DIR)}`
      const script = 'mkdir -p /tmp/ts && node /work/stand-ins.mjs & '
        + 'until [ -S /tmp/ts/tailscaled.sock ]; do sleep 0.2; done && node_modules/.bin/tsx /app/main.ts & '
        + 'until node -e "require(\'http\').get(\'http://127.0.0.1:9003/ready\', (r) => process.exit(r.statusCode === 200 ? 0 : 1))'
        + '.on(\'error\', () => process.exit(1))"; do sleep 0.5; done && node /work/client.mjs'
      const { stdout } = await execFileAsync('podman', [
        'run', '--rm', '--label', testContainerOwnerLabel(), '--network', 'none',
        '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0', '-v', `${dir}:/work:ro,Z`,
        '-e', `TAILGATE_SITE_DOMAIN=${ZONE}`, '-e', 'TAILGATE_TAILSCALE_SOCKET=/tmp/ts/tailscaled.sock',
        '-e', 'TAILGATE_ROUTER=127.0.0.1:9000', '-e', 'TAILGATE_TLS_DIR=/work',
        '-e', 'TAILGATE_SERVE_HOST=127.0.0.2', '-e', 'TAILGATE_HTTPS_PORT=8443', '-e', 'TAILGATE_HTTP_PORT=8080', '-e', 'TAILGATE_HEALTH_PORT=9003',
        '-e', 'TAILGATE_IDLE_SECONDS=3600',
        image, 'sh', '-c', script,
      ], { timeout: 120_000 })
      const [body, dns] = stdout.trim().split('\n').slice(-2)
      expect(JSON.parse(body)).toMatchObject({ 'tailscale-user-login': 'alice@example.com', host: `site1.${ZONE}` })
      expect(dns).toBe('DNS 100.64.0.9')
    }, 180_000)
  })
})
