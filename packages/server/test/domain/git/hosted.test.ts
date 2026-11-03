import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import net from 'node:net'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { createAdaptorServer, type ServerType } from '@hono/node-server'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { checkMoveTarget, hostedDefaultBranch, initHostedRepo, pushHostedRepo, serveGitHttp, setHostedDefaultBranch } from '#domain/git'

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }
const run = (dir: string, args: string[]): Promise<string> => git(dir, args, { env: ENV })

let tmp: string
let repo: string

beforeAll(async () => {
  tmp = await createTempDataDir()
  repo = path.join(tmp, 'remote.git')
  await initHostedRepo(repo)
})

afterAll(async () => {
  await cleanupTempDir(tmp)
})

describe('initHostedRepo', () => {
  it('makes an empty bare repository on main that records every ref update and never prunes', async () => {
    expect((await run(repo, ['rev-parse', '--is-bare-repository'])).trim()).toBe('true')
    expect((await run(repo, ['symbolic-ref', 'HEAD'])).trim()).toBe('refs/heads/main')
    expect(await run(repo, ['for-each-ref'])).toBe('')
    for (const [key, value] of [
      ['core.logAllRefUpdates', 'always'],
      ['gc.pruneExpire', 'never'],
      ['gc.reflogExpire', 'never'],
      ['gc.reflogExpireUnreachable', 'never'],
    ]) {
      expect((await run(repo, ['config', '--file', path.join(repo, 'config'), key])).trim()).toBe(value)
    }
  })
})

describe('checkMoveTarget', () => {
  it('takes an empty remote, or one only a push from here has filled, and refuses any other or none', async () => {
    const source = path.join(tmp, 'check-source.git')
    const target = path.join(tmp, 'check-target.git')
    await initHostedRepo(source)
    await run(tmp, ['init', '-q', '--bare', target])
    await checkMoveTarget(source, target, { kind: 'hosted' })
    await expect(checkMoveTarget(source, path.join(tmp, 'nowhere.git'), { kind: 'hosted' })).rejects.toThrow()

    const work = path.join(tmp, 'check-work')
    await run(tmp, ['clone', '-q', source, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'one'])
    await run(work, ['tag', '-a', '-m', 'v1', 'v1'])
    await run(work, ['push', '-q', 'origin', 'HEAD:main', 'v1'])
    // As a push that stopped after the default branch leaves it, and then
    // the project's main moved on before the retry.
    await run(work, ['push', '-q', target, 'HEAD:main'])
    await checkMoveTarget(source, target, { kind: 'hosted' })
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'two'])
    await run(work, ['push', '-q', 'origin', 'HEAD:main'])
    await checkMoveTarget(source, target, { kind: 'hosted' })

    // A host's first commit, such as a README, is not the project's, on a
    // branch the project lacks or on one it has.
    const readme = path.join(tmp, 'check-readme')
    await run(tmp, ['init', '-q', '-b', 'main', readme])
    await run(readme, ['commit', '-q', '--allow-empty', '-m', 'README'])
    await run(readme, ['push', '-q', target, 'HEAD:readme'])
    await expect(checkMoveTarget(source, target, { kind: 'hosted' })).rejects.toThrow(/already has refs\/heads\/readme, which this project does not/)
    const fresh = path.join(tmp, 'check-fresh.git')
    await run(tmp, ['init', '-q', '--bare', fresh])
    await run(readme, ['push', '-q', fresh, 'HEAD:main'])
    await expect(checkMoveTarget(source, fresh, { kind: 'hosted' })).rejects.toThrow(/its refs\/heads\/main has commits this project's does not/)
  })
})

describe('checkMoveTarget against a remote that refuses pushes', () => {
  it('refuses a remote it can read but not push to, before pushing anything, empty project or not', async () => {
    // What a read-only credential sees: reads served, pushes refused.
    const readOnly = path.join(tmp, 'read-only.git')
    await run(tmp, ['init', '-q', '--bare', readOnly])
    const server = createAdaptorServer({
      fetch: (request) => serveGitHttp(readOnly, request, new URL(request.url).pathname.replace(/^\/repo/, ''), {
        allowPush: false, guardDefaultBranch: false,
      }),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/repo`
    try {
      const source = path.join(tmp, 'read-only-source.git')
      await initHostedRepo(source)
      expect(await run(tmp, ['ls-remote', url])).toBe('')
      await expect(checkMoveTarget(source, url, { kind: 'hosted' })).rejects.toThrow(/403/)

      const work = path.join(tmp, 'read-only-work')
      await run(tmp, ['clone', '-q', source, work])
      await run(work, ['commit', '-q', '--allow-empty', '-m', 'one'])
      await run(work, ['push', '-q', 'origin', 'HEAD:main'])
      await expect(checkMoveTarget(source, url, { kind: 'hosted' })).rejects.toThrow(/403/)
      expect(await run(readOnly, ['for-each-ref'])).toBe('')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('pushHostedRepo', () => {
  it('pushes every branch and tag, never forcing, and nothing at all from an empty repository', async () => {
    const source = path.join(tmp, 'push-source.git')
    const target = path.join(tmp, 'push-target.git')
    await initHostedRepo(source)
    await run(tmp, ['init', '-q', '--bare', target])
    await pushHostedRepo(source, target, { kind: 'hosted' })
    expect(await run(target, ['for-each-ref'])).toBe('')

    const work = path.join(tmp, 'push-work')
    await run(tmp, ['clone', '-q', source, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'one'])
    await run(work, ['tag', 'v1'])
    await run(work, ['push', '-q', 'origin', 'HEAD:main', 'HEAD:feature', 'v1'])
    await pushHostedRepo(source, target, { kind: 'hosted' })
    expect(await run(target, ['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/feature\nrefs/heads/main\nrefs/tags/v1\n')

    // Nothing is forced: a remote branch that moved on is left alone.
    const other = path.join(tmp, 'push-other')
    await run(tmp, ['clone', '-q', '-b', 'main', target, other])
    await run(other, ['commit', '-q', '--allow-empty', '-m', 'elsewhere'])
    await run(other, ['push', '-q', 'origin', 'HEAD:main'])
    const tip = (await run(target, ['rev-parse', 'main'])).trim()
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'two'])
    await run(work, ['push', '-q', 'origin', 'HEAD:main'])
    await expect(pushHostedRepo(source, target, { kind: 'hosted' })).rejects.toThrow(/rejected/)
    expect((await run(target, ['rev-parse', 'main'])).trim()).toBe(tip)
  })
})

describe('hostedDefaultBranch', () => {
  it('names the branch HEAD names, and null while that branch does not exist', async () => {
    const source = path.join(tmp, 'default-source.git')
    await initHostedRepo(source)
    expect(await hostedDefaultBranch(source)).toBeNull()

    const work = path.join(tmp, 'default-work')
    await run(tmp, ['clone', '-q', source, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'one'])
    await run(work, ['push', '-q', 'origin', 'HEAD:main'])
    expect(await hostedDefaultBranch(source)).toBe('main')
    await run(source, ['update-ref', '-d', 'refs/heads/main'])
    expect(await hostedDefaultBranch(source)).toBeNull()
  })
})

describe('setHostedDefaultBranch', () => {
  it('points HEAD at a branch the repository has, and refuses any other', async () => {
    const source = path.join(tmp, 'head-source.git')
    await initHostedRepo(source)
    expect(await setHostedDefaultBranch(source, 'main')).toBe(false)

    const work = path.join(tmp, 'head-work')
    await run(tmp, ['clone', '-q', source, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'one'])
    await run(work, ['push', '-q', 'origin', 'HEAD:main', 'HEAD:release'])
    expect(await setHostedDefaultBranch(source, 'release')).toBe(true)
    expect((await run(source, ['symbolic-ref', 'HEAD'])).trim()).toBe('refs/heads/release')
    for (const bad of ['gone', '../release', 'refs/heads/main']) {
      expect(await setHostedDefaultBranch(source, bad)).toBe(false)
    }
    expect((await run(source, ['symbolic-ref', 'HEAD'])).trim()).toBe('refs/heads/release')
  })
})

describe('serveGitHttp', () => {
  let server: ServerType
  let origin: string
  let allowPush = true
  const pushed: string[] = []

  beforeAll(async () => {
    server = createAdaptorServer({
      fetch: (request) => serveGitHttp(repo, request, new URL(request.url).pathname.replace(/^\/repo/, ''), {
        allowPush,
        guardDefaultBranch: false,
        onPushed: () => pushed.push('pushed'),
      }),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/repo`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('serves fetches and pushes over protocol v2, and runs onPushed after each push only', async () => {
    const work = path.join(tmp, 'work')
    await run(tmp, ['-c', 'protocol.version=2', 'clone', '-q', origin, work])
    await run(work, ['commit', '-q', '--allow-empty', '-m', 'one'])
    await run(work, ['push', '-q', 'origin', 'HEAD:main'])
    await run(work, ['-c', 'protocol.version=2', 'fetch', '-q', 'origin'])
    await new Promise((r) => setTimeout(r, 100))
    expect(pushed).toEqual(['pushed'])
    expect((await run(repo, ['rev-parse', 'main'])).trim()).toBe((await run(work, ['rev-parse', 'HEAD'])).trim())
  })

  it('reads a gzipped request body', async () => {
    // What git sends for a large negotiation: an `ls-refs` command, gzipped.
    const pkt = (s: string): string => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`
    const body = zlib.gzipSync(`${pkt('command=ls-refs\n')}0001${pkt('ref-prefix refs/heads/\n')}0000`)
    const res = await fetch(`${origin}/git-upload-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-upload-pack-request',
        'content-encoding': 'gzip',
        'git-protocol': 'version=2',
      },
      body,
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('refs/heads/main')
  })

  it('survives a client that goes away mid-upload', async () => {
    // A body promised but cut short, then the socket reset, as a Ctrl-C
    // during a clone sends.
    const { port } = new URL(origin)
    await new Promise<void>((resolve) => {
      const socket = net.connect(Number(port), '127.0.0.1', () => {
        socket.write('POST /repo/git-upload-pack HTTP/1.1\r\nHost: x\r\n'
          + 'Content-Type: application/x-git-upload-pack-request\r\nContent-Length: 100000\r\n\r\n0032want')
        setTimeout(() => { socket.resetAndDestroy(); resolve() }, 200)
      })
      socket.on('error', () => {})
    })
    await new Promise((r) => setTimeout(r, 200))
    expect((await fetch(`${origin}/info/refs?service=git-upload-pack`)).status).toBe(200)
  })

  it('refuses a push unless allowed, and serves nothing but the smart-HTTP endpoints', async () => {
    allowPush = false
    try {
      const work = path.join(tmp, 'work')
      await run(work, ['commit', '-q', '--allow-empty', '-m', 'two'])
      await expect(run(work, ['push', '-q', 'origin', 'HEAD:main'])).rejects.toThrow(/403/)
    } finally {
      allowPush = true
    }
    for (const file of ['/HEAD', '/config', '/objects/info/packs', '/info/refs/../../config']) {
      expect((await fetch(`${origin}${file}`)).status).toBe(404)
    }
  })
})
