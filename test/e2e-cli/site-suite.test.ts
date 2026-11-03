import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { git } from '@yaac/test-utils/git'
import { cloneRepo } from '@yaac/server/domain/git'
import { createYaacTestEnv, spawnYaacServer, setTestGitIdentity, runYaac, type YaacTestEnv } from '#support/cli'
import { assignTestGitCredential, makeServerApiClient, registerTestProject, type SpawnedServer } from '@yaac/test-utils/api'
import { requireCluster } from '@yaac/test-utils/setup'
import { requirePodman, cleanupWorkspaceJobs, execInJob } from '#support/cluster'
import { startKubectlForward } from '@yaac/test-utils/kubectl-forward'
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
 * a failing then a succeeding deploy, stop and start, and delete last.
 */

const NAME = 'site-demo'
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

/** A graph whose one service answers `text` on `port`. */
function serving(port: number, text: string): object {
  const script = `require('http').createServer((q, s) => s.end('${text}')).listen(${port})`
  return { server: { run: `node -e "${script}"`, service: true, ready: `curl -sf localhost:${port}` } }
}

describe('yaac site (real CLI + real server)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockGit: MockGit | null = null
  let serverEnv: NodeJS.ProcessEnv
  let sha = ''
  let projectId = ''

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
      YAAC_SITE_DOMAINS: DOMAIN,
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify({ 'github.com': gitTarget, 'api.github.com': gitTarget }),
      YAAC_E2E_SKIP_FETCH: '1',
    }
    server = await spawnYaacServer(serverEnv)
    await setTestGitIdentity(serverEnv)

    // Staged as `yaac project add` would stage github.com/test-org/<NAME>.
    await seedMockGitRepo(mockGit, NAME, { files: { 'README.md': '# site\n' } })
    projectId = randomUUID()
    const repoPath = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'repo')
    await cloneRepo(path.join(mockGit.reposDir, `${NAME}.git`), repoPath, null)
    const remote = `https://github.com/test-org/${NAME}.git`
    await git(repoPath, ['remote', 'set-url', 'origin', remote])
    await registerTestProject(server, projectId, NAME, remote)
    await assignTestGitCredential(server, projectId, 'fake-ghp-token')
    sha = (await git(repoPath, ['rev-parse', 'HEAD'])).trim()

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

  it('create needs --hostname, --port and --steps, refuses a hostname outside the site domains, and prints the tunnel\'s settings', async () => {
    const steps = await stepsFile('v1.json', serving(3000, 'v1'))
    expect(await refused('site', 'create', NAME, 'web', '--port', '3000', '--steps', steps))
      .toContain('--hostname <host>')
    expect(await refused('site', 'create', NAME, 'web', '--hostname', `app.${DOMAIN}`, '--port', 'http', '--steps', steps))
      .toContain('--port takes a port number')
    await refused('site', 'create', NAME, 'web', '--hostname', 'app.elsewhere.test', '--port', '3000', '--steps', steps)
    expect(await yaac('site', 'list', NAME)).toContain(`No sites in ${NAME}`)

    const created = await yaac('site', 'create', NAME, 'web', '--hostname', `app.${DOMAIN}`, '--port', '3000',
      '--steps', steps, '--volume', 'data')
    expect(created).toContain('Created site "web"')
    expect(created).toContain(`hostname  app.${DOMAIN}`)
    expect(created).toContain('service   http://yaac-site-router:8080')
    expect(created).toContain('no tunnel yet')
  })

  it('list and show name its hostname, port, steps and volume before any deploy', async () => {
    expect(await yaac('site', 'list', NAME))
      .toMatch(/NAME\s+HOSTNAME\s+PORT\s+LIVE[\s\S]*web\s+app\.example\.test\s+3000\s+-/)
    const shown = await yaac('site', 'show', NAME, 'web')
    expect(shown).toContain(`https://app.${DOMAIN} -> port 3000`)
    expect(shown).toMatch(/steps\s+server/)
    expect(shown).toMatch(/volume\s+data/)
  })

  it('edit changes --hostname, --port, --steps and --volume, and --no-volume drops it', async () => {
    expect(await refused('site', 'edit', NAME, 'web')).toContain('Nothing to change')
    const failing = await stepsFile('failing.json', { build: { run: 'exit 3' }, ...serving(3001, 'v2') })
    await yaac('site', 'edit', NAME, 'web', '--hostname', `www.${DOMAIN}`, '--port', '3001', '--steps', failing, '--no-volume')
    let shown = await yaac('site', 'show', NAME, 'web')
    expect(shown).toContain(`https://www.${DOMAIN} -> port 3001`)
    expect(shown).toMatch(/steps\s+build, server/)
    expect(shown).toMatch(/volume\s+-/)
    await yaac('site', 'edit', NAME, 'web', '--volume', 'data')
    expect(await yaac('site', 'show', NAME, 'web')).toMatch(/volume\s+data/)
    await yaac('site', 'edit', NAME, 'web', '--no-volume')
    shown = await yaac('site', 'show', NAME, 'web')
    expect(shown).toMatch(/volume\s+-/)
  })

  it('deploy --wait exits non-zero when the release fails, and 0 once it serves --ref', async () => {
    const failed = await runYaac(serverEnv, 'site', 'deploy', NAME, 'web', '--wait')
    expect(failed.exitCode).not.toBe(0)
    expect(failed.stdout).toContain('The deploy failed')
    expect(await yaac('site', 'list', NAME)).toMatch(/web\s+www\.example\.test\s+3001\s+-\s+failed/)

    await yaac('site', 'edit', NAME, 'web', '--steps', await stepsFile('v2.json', serving(3001, 'v2')))
    const deployed = await runYaac(serverEnv, 'site', 'deploy', NAME, 'web', '--ref', sha, '--timeout', '10m', '--wait')
    expect(deployed.exitCode, deployed.stderr).toBe(0)
    expect(deployed.stdout).toContain(`Deploying ${sha.slice(0, 7)} to site "web"`)
    expect(deployed.stdout).toContain(`Deployed: https://www.${DOMAIN} serves ${sha.slice(0, 7)}.`)
    expect(await yaac('site', 'list', NAME)).toMatch(new RegExp(`web\\s+www\\.example\\.test\\s+3001\\s+${sha.slice(0, 7)} running`))
    const shown = await yaac('site', 'show', NAME, 'web')
    expect(shown).toMatch(/RELEASE\s+COMMIT\s+STARTED\s+STOPPED/)
    expect(shown).toContain(sha.slice(0, 7))

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
  }, 600_000)

  it('stop takes the live release down, and start brings one back at its commit', async () => {
    expect(await yaac('site', 'stop', NAME, 'web')).toContain('Stopped site "web"')
    expect(await yaac('site', 'list', NAME)).toMatch(/web\s+www\.example\.test\s+3001\s+-\s/)
    expect(await yaac('site', 'start', NAME, 'web')).toMatch(new RegExp(`Starting site "web" at ${sha.slice(0, 7)} in release \\S+`))
    await vi.waitFor(async () => {
      expect(await yaac('site', 'list', NAME)).toContain(`${sha.slice(0, 7)} running`)
    }, { timeout: 300_000, interval: 2_000 })
  }, 360_000)

  // The staged handoff (docs/public-sites.md "Volumes: a staged handoff"):
  // the second release mounts the volume while the first holds it, waits
  // for the first's pod to be gone, then takes the lease and reads what the
  // first wrote. The site answers 503 only in that gap.
  it('hands the volume from one release to the next, which reads what the first wrote', async () => {
    const api = makeServerApiClient(server!)
    await yaac('site', 'edit', NAME, 'web', '--volume', 'data', '--steps', await stepsFile('vol1.json', servingVolume(3001, 'one')))
    const first = await runYaac(serverEnv, 'site', 'deploy', NAME, 'web', '--wait')
    expect(first.exitCode, first.stderr).toBe(0)
    const firstRelease = /in release (\S+)\./.exec(first.stdout)?.[1]

    const router = await startKubectlForward({ namespace: k8sNamespace(), target: 'service/yaac-site-router', remotePort: 8080 })
    try {
      await vi.waitFor(async () => {
        expect(await viaRouter(router.origin, `www.${DOMAIN}`)).toEqual({ status: 200, body: 'one\n' })
      }, { timeout: 120_000, interval: 2_000 })

      await yaac('site', 'edit', NAME, 'web', '--steps', await stepsFile('vol2.json', servingVolume(3001, 'two')))
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
      const startedAt = workspaces.find((w) => w.workspaceId === secondRelease)?.steps?.find((st) => st.name === 'server')?.startedAt
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
})
