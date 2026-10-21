import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as childProcessModule from 'node:child_process'

// The macOS `security` CLI is the Keychain's process boundary.
const execFileSyncMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => string>())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessModule>()
  return { ...actual, execFileSync: execFileSyncMock }
})
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { legacyHostDataDirHint, moveLegacyClusterDataDir, moveLegacyHostDataDir } from '#legacy-data-dir'
import { clusterDataDir, readInstallRecord } from '#install-record'
import { clientLocalPath, hostDataDir, installTmpDir, resetHostDataDir, setDataDir } from '#paths'
import { SERVER_LOCK_FILENAME } from '#server-lock-file'
import { claudeKeychainService } from '#tool-auth-interactive'

let home: string
const legacy = (): string => path.join(home, '.yaac')
const current = (): string => path.join(home, '.yaac-server')
const cluster = (): string => path.join(home, '.yaac-cluster')
const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false)

/**
 * A live lock in ~/.yaac: another running pid whose port answers HTTP. Its
 * lease has lapsed, so closing the port is what stops it counting as live.
 */
async function liveServer(): Promise<http.Server> {
  const server = http.createServer((_req, res) => res.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const lock = {
    pid: process.ppid, port: (server.address() as net.AddressInfo).port, startedAt: 0,
    buildId: 'b', instance: 'i', heartbeatAt: 0,
  }
  await fs.writeFile(path.join(legacy(), 'server-local', SERVER_LOCK_FILENAME), JSON.stringify(lock))
  return server
}

/** A listening socket in ~/.yaac's tmp dir, named `name`. */
async function listening(name: string): Promise<net.Server> {
  const tmp = installTmpDir(legacy())
  await fs.mkdir(tmp, { recursive: true })
  const sock = net.createServer()
  await new Promise<void>((resolve) => sock.listen(path.join(tmp, name), resolve))
  return sock
}

const close = (s: net.Server): Promise<unknown> => new Promise((resolve) => s.close(resolve))

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-home-'))
  vi.stubEnv('HOME', home)
  setDataDir('')
  resetHostDataDir()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await fs.mkdir(path.join(legacy(), 'server-local'), { recursive: true })
  await fs.mkdir(path.dirname(clientLocalPath('server.json')), { recursive: true })
  // A pre-install.json host install: its record exists only as server.json's mirror.
  await fs.writeFile(clientLocalPath('server.json'), JSON.stringify({
    url: 'http://127.0.0.1:8787', saved: [{ url: 'http://127.0.0.1:8787' }],
    driver: 'containerless', origin: 'http://127.0.0.1:8787',
  }))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  setDataDir('/tmp/yaac-path-test')
  resetHostDataDir()
  await fs.rm(installTmpDir(path.join(home, '.yaac')), { recursive: true, force: true })
  await fs.rm(home, { recursive: true, force: true })
})

describe('moveLegacyHostDataDir', () => {
  it('moves an idle host install, repoints its tool records, and strips the mirrored record', async () => {
    const project = (dataDir: string): string => path.join(dataDir, 'global', 'projects', 'p1')
    const checkout = (dataDir: string): string => path.join(project(dataDir), 'workspaces', 'w1')
    const session = 'history/w1/pi/s1.jsonl'
    await fs.mkdir(path.dirname(path.join(project(legacy()), session)), { recursive: true })
    await fs.writeFile(path.join(project(legacy()), session), `{"type":"session","cwd":"${checkout(legacy())}"}\n`)
    // claude's history link named after the checkout's old path.
    const links = path.join(project(legacy()), 'claude', 'projects')
    const stale = checkout(legacy()).replace(/[^a-zA-Z0-9]/g, '-')
    await fs.mkdir(links, { recursive: true })
    await fs.symlink('../../history/w1/claude/-workspace', path.join(links, stale))
    await fs.symlink('../../history/w1/claude/-workspace', path.join(links, '-workspace'))

    expect(hostDataDir()).toBe(legacy())
    await moveLegacyHostDataDir()
    expect(await exists(path.join(current(), 'server-local'))).toBe(true)
    expect(await fs.readFile(path.join(project(current()), session), 'utf8')).toContain(`"cwd":"${checkout(current())}"`)
    expect(await fs.readdir(path.join(project(current()), 'claude', 'projects'))).toEqual(['-workspace'])
    expect(hostDataDir()).toBe(current())
    expect(JSON.parse(await fs.readFile(clientLocalPath('server.json'), 'utf8'))).toEqual({
      url: 'http://127.0.0.1:8787', saved: [{ url: 'http://127.0.0.1:8787' }],
    })
    expect(await readInstallRecord(legacy())).toBeNull()
    expect(await exists(legacy())).toBe(false)
  })

  it('leaves ~/.yaac while its server or a workspace runs from it', async () => {
    const server = await liveServer()
    await moveLegacyHostDataDir()
    expect(await exists(legacy())).toBe(true)
    await close(server)

    // With the server gone, a workspace's tmux socket still holds it.
    const tmux = await listening('abc.sock')
    await moveLegacyHostDataDir()
    expect(await exists(legacy())).toBe(true)
    expect(await exists(current())).toBe(false)
    await close(tmux)

    await moveLegacyHostDataDir()
    expect(await exists(current())).toBe(true)
  })

  it('leaves a cluster ~/.yaac, a named data dir, and a ~/.yaac beside ~/.yaac-server alone', async () => {
    await fs.writeFile(path.join(legacy(), 'install.json'), JSON.stringify({ driver: 'k8s' }))
    await moveLegacyHostDataDir()
    expect(await exists(current())).toBe(false)

    await fs.rm(path.join(legacy(), 'install.json'))
    vi.stubEnv('YAAC_DATA_DIR', legacy())
    await moveLegacyHostDataDir()
    expect(await exists(current())).toBe(false)
    vi.unstubAllEnvs()
    vi.stubEnv('HOME', home)

    await fs.mkdir(current())
    await moveLegacyHostDataDir()
    expect(await exists(legacy())).toBe(true)
    expect(await fs.readdir(current())).toEqual([])
  })
})

describe('moveLegacyHostDataDir on macOS', () => {
  const realPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    execFileSyncMock.mockReset()
  })

  it('writes a claude Keychain item named after the old path to the credentials file, and deletes it', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const claude = path.join(legacy(), 'global', 'projects', 'p1', 'claude')
    await fs.mkdir(claude, { recursive: true })
    const service = claudeKeychainService(claude)
    const bundle = { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } }
    execFileSyncMock.mockImplementation((_file, args) => {
      const [verb, , name] = args as string[]
      if (verb === 'find-generic-password' && name === service) return JSON.stringify(bundle)
      if (verb === 'find-generic-password') throw new Error('not found')
      return ''
    })
    await moveLegacyHostDataDir()
    const file = path.join(current(), 'global', 'projects', 'p1', 'claude', '.credentials.json')
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(bundle)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(execFileSyncMock).toHaveBeenCalledWith('security', ['delete-generic-password', '-s', service], expect.anything())
  })
})

describe('moveLegacyHostDataDir failures', () => {
  it('keeps ~/.yaac in use, with its records as they were, when the rename fails', async () => {
    const session = path.join(legacy(), 'global', 'projects', 'p1', 'history', 'w1', 'pi', 's1.jsonl')
    const text = `{"cwd":"${path.join(legacy(), 'global', 'projects', 'p1', 'workspaces', 'w1')}"}\n`
    await fs.mkdir(path.dirname(session), { recursive: true })
    await fs.writeFile(session, text)
    await fs.chmod(home, 0o555)
    try {
      await moveLegacyHostDataDir()
    } finally {
      await fs.chmod(home, 0o755)
    }
    expect(hostDataDir()).toBe(legacy())
    expect(await fs.readFile(session, 'utf8')).toBe(text)
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/could not move .*, so it stays in use/))
  })

  it('lets concurrent starts all follow the one that moved the dir', async () => {
    hostDataDir()
    await Promise.all([moveLegacyHostDataDir(), moveLegacyHostDataDir(), moveLegacyHostDataDir()])
    expect(hostDataDir()).toBe(current())
    expect(await exists(legacy())).toBe(false)
    expect(console.error).not.toHaveBeenCalledWith(expect.stringMatching(/could not move/))
  })
})

describe('legacyHostDataDirHint', () => {
  it('says ~/.yaac is not served when ~/.yaac-server exists beside it', async () => {
    await fs.mkdir(current())
    expect(await legacyHostDataDirHint()).toMatch(/\.yaac holds a host install that is not served, because .*\.yaac-server exists/)
  })

  it('says what keeps the host install in ~/.yaac and which command moves it', async () => {
    // The running server's own git agent socket is not a workspace.
    const server = await liveServer()
    const agent = await listening('git-agent.sock')
    expect(await legacyHostDataDirHint()).toMatch(/moves to .*\.yaac-server on the next `yaac server restart`$/)
    const tmux = await listening('abc.sock')
    expect(await legacyHostDataDirHint()).toMatch(/stays in use while workspaces run from it/)
    await Promise.all([close(server), close(agent), close(tmux)])
    expect(await legacyHostDataDirHint()).toMatch(/on the next `yaac server start`$/)

    await moveLegacyHostDataDir()
    expect(await legacyHostDataDirHint()).toBeNull()
  })
})

describe('moveLegacyClusterDataDir', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(legacy(), 'install.json'), JSON.stringify({ driver: 'k8s', installId: 'i-1' }))
  })

  it('moves a kind install to ~/.yaac-cluster once its cluster is gone, and only then', async () => {
    expect(await moveLegacyClusterDataDir(() => Promise.resolve(true))).toBe(false)
    // A kind that cannot answer is not taken for a missing cluster.
    expect(await moveLegacyClusterDataDir(() => Promise.reject(new Error('no kind')))).toBe(false)
    expect(await exists(legacy())).toBe(true)

    expect(await moveLegacyClusterDataDir(() => Promise.resolve(false))).toBe(true)
    expect(await readInstallRecord(cluster())).toEqual({ driver: 'k8s', installId: 'i-1' })
    expect(await clusterDataDir()).toBe(cluster())
    expect(await exists(legacy())).toBe(false)
    expect(JSON.parse(await fs.readFile(clientLocalPath('server.json'), 'utf8'))).not.toHaveProperty('driver')
  })

  it('asks about the kind cluster the install recorded, not the one YAAC_KIND_CLUSTER names now', async () => {
    await fs.writeFile(path.join(legacy(), 'install.json'), JSON.stringify({ driver: 'k8s', kubeContext: 'kind-foo' }))
    const asked: string[] = []
    const exists = (name: string): Promise<boolean> => {
      asked.push(name)
      return Promise.resolve(name === 'foo')
    }
    expect(await moveLegacyClusterDataDir(exists)).toBe(false)
    await fs.writeFile(path.join(legacy(), 'install.json'), JSON.stringify({ driver: 'k8s' }))
    expect(await moveLegacyClusterDataDir(exists)).toBe(true)
    expect(asked).toEqual(['foo', 'yaac'])
  })

  it('leaves a byo install, a host install, and a ~/.yaac beside ~/.yaac-cluster alone', async () => {
    const gone = (): Promise<boolean> => Promise.resolve(false)
    await fs.writeFile(path.join(legacy(), 'install.json'), JSON.stringify({ driver: 'k8s', byo: true }))
    expect(await moveLegacyClusterDataDir(gone)).toBe(false)
    await fs.writeFile(path.join(legacy(), 'install.json'), JSON.stringify({ driver: 'containerless' }))
    expect(await moveLegacyClusterDataDir(gone)).toBe(false)
    await fs.writeFile(path.join(legacy(), 'install.json'), JSON.stringify({ driver: 'k8s' }))
    await fs.mkdir(cluster())
    expect(await moveLegacyClusterDataDir(gone)).toBe(false)
    expect(await exists(legacy())).toBe(true)
  })
})
