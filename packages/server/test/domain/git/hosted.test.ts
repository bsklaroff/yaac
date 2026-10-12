import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import net from 'node:net'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { createAdaptorServer, type ServerType } from '@hono/node-server'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { initHostedRepo, serveGitHttp } from '#domain/git'

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
