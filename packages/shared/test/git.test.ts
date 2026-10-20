import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { cloneRepo, createCheckout, fetchOrigin } from '@yaac/server/domain/git'
import { git } from '@yaac/test-utils/git'
import { buildCloneLinkExec, buildOriginRefreshExec, buildStatusWarmupExec, formatSshCommand, getGitUserConfig, gitConfigValue, torSshOpts } from '#git'

const execFileAsync = promisify(execFile)

describe('getGitUserConfig', () => {
  it('returns name and email or null', async () => {
    const result = await getGitUserConfig()
    if (result) {
      expect(typeof result.name).toBe('string')
      expect(typeof result.email).toBe('string')
    } else {
      expect(result).toBeNull()
    }
  })
})

describe('torSshOpts', () => {
  const originalUseTor = process.env.YAAC_USE_TOR
  const originalUrl = process.env.YAAC_HOST_TOR_SOCKS_URL

  afterEach(() => {
    if (originalUseTor === undefined) delete process.env.YAAC_USE_TOR
    else process.env.YAAC_USE_TOR = originalUseTor
    if (originalUrl === undefined) delete process.env.YAAC_HOST_TOR_SOCKS_URL
    else process.env.YAAC_HOST_TOR_SOCKS_URL = originalUrl
  })

  it('returns [] when YAAC_USE_TOR is unset', () => {
    delete process.env.YAAC_USE_TOR
    expect(torSshOpts()).toEqual([])
  })

  it('emits -o ProxyCommand with the default SOCKS host:port', () => {
    process.env.YAAC_USE_TOR = '1'
    delete process.env.YAAC_HOST_TOR_SOCKS_URL
    const opts = torSshOpts()
    expect(opts).toEqual(['-o', 'ProxyCommand=nc -X 5 -x 127.0.0.1:9050 %h %p'])
  })

  it('honors YAAC_HOST_TOR_SOCKS_URL', () => {
    process.env.YAAC_USE_TOR = '1'
    process.env.YAAC_HOST_TOR_SOCKS_URL = 'socks5h://10.0.0.1:9150'
    const opts = torSshOpts()
    expect(opts).toEqual(['-o', 'ProxyCommand=nc -X 5 -x 10.0.0.1:9150 %h %p'])
  })
})

describe('formatSshCommand', () => {
  it('leaves plain args unquoted', () => {
    expect(formatSshCommand(['ssh', '-F', '/dev/null', '-i', '/k'])).toBe(
      'ssh -F /dev/null -i /k',
    )
  })

  it('single-quotes args containing whitespace', () => {
    const cmd = formatSshCommand(['-o', 'ProxyCommand=nc -X 5 %h %p'])
    expect(cmd).toBe("-o 'ProxyCommand=nc -X 5 %h %p'")
  })

  it('escapes embedded single quotes', () => {
    const cmd = formatSshCommand(['-o', "Foo=bar's baz"])
    expect(cmd).toBe(`-o 'Foo=bar'\\''s baz'`)
  })

  it('quotes the empty string', () => {
    expect(formatSshCommand([''])).toBe("''")
  })

  it('quotes shell metacharacters even without whitespace', () => {
    expect(formatSshCommand(['a;b', 'c$d'])).toBe("'a;b' 'c$d'")
  })
})

/**
 * Runs the commands for real against a main clone and a checkout of it,
 * with the checkout's path as the workspace dir.
 */
describe('clone refresh commands', () => {
  let tmp: string
  let source: string
  let main: string
  let wt: string
  const run = (cmd: string): Promise<unknown> => execFileAsync('sh', ['-c', cmd])
  const commit = async (repo: string, msg: string): Promise<void> => {
    await git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', msg])
  }
  const tip = async (repo: string, ref: string): Promise<string> => (await git(repo, ['rev-parse', ref])).trim()

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-refresh-'))
    source = path.join(tmp, 'source')
    await fs.mkdir(source)
    await git(source, ['init', '-q', '-b', 'main'])
    await commit(source, 'initial')
    await git(source, ['checkout', '-q', '-b', 'forced'])
    await commit(source, 'forced one')
    await git(source, ['checkout', '-q', 'main'])
    main = path.join(tmp, 'repo')
    await cloneRepo(source, main, null)
    wt = path.join(tmp, 'wt')
    await createCheckout(main, wt, { branch: 'agent/x', baseBranch: 'main', remoteUrl: source })
  })

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  describe('buildCloneLinkExec', () => {
    it('rewrites the alternates line to the main clone as the server sees it', async () => {
      await fs.writeFile(path.join(wt, '.git', 'objects', 'info', 'alternates'), '/yaac/global/elsewhere/.git/objects\n')
      const cmd = buildCloneLinkExec(path.join(main, '.git'), wt)
      await run(cmd)
      expect(await fs.readFile(path.join(wt, '.git', 'objects', 'info', 'alternates'), 'utf8'))
        .toBe(`${path.join(main, '.git', 'objects')}\n`)
      expect((await git(wt, ['status', '--porcelain'])).trim()).toBe('')
    })

    it('fails when the alternates line cannot be written', async () => {
      const cmd = buildCloneLinkExec(path.join(main, '.git'), path.join(tmp, 'missing'))
      await expect(run(cmd)).rejects.toThrow()
    })
  })

  describe('buildStatusWarmupExec', () => {
    it('reads every file once in the background, taking no index lock the agent could collide with', async () => {
      const cmd = buildStatusWarmupExec(wt)
      expect(cmd).toMatch(/^\{ setsid git -C \S+ --no-optional-locks status --porcelain <\/dev\/null >\/dev\/null 2>&1 & \}$/)
      // Detached, so a command it is chained into goes straight on.
      await run(`${cmd} && echo next`)
      await expect(fs.access(path.join(wt, '.git', 'index.lock'))).rejects.toThrow()
    })
  })

  describe('buildOriginRefreshExec', () => {
    it('fast-forwards origin/* from the main clone and moves nothing back', async () => {
      const cmd = buildOriginRefreshExec(path.join(main, '.git'), wt)
      // Upstream: main moves on, a branch appears, `forced` is rewritten.
      await commit(source, 'upstream')
      await git(source, ['branch', 'fresh'])
      await git(source, ['branch', '-f', 'forced', 'main'])
      // The agent fetched `ahead` itself; the main clone has not.
      await git(source, ['branch', 'ahead'])
      await git(wt, ['fetch', '-q', source, 'refs/heads/ahead:refs/remotes/origin/ahead'])
      await git(source, ['branch', '-f', 'ahead', 'main~1'])
      const forcedBefore = await tip(wt, 'origin/forced')
      await fs.writeFile(path.join(wt, '.git', 'FETCH_HEAD'), 'the agent\'s\n')
      await fetchOrigin(main, source, null)
      const objects = await git(wt, ['count-objects', '-v'])

      await run(cmd)

      expect(await tip(wt, 'origin/main')).toBe(await tip(source, 'main'))
      expect(await tip(wt, 'origin/fresh')).toBe(await tip(source, 'fresh'))
      // Not a fast-forward: left for the agent's own fetch.
      expect(await tip(wt, 'origin/forced')).toBe(forcedBefore)
      expect(await tip(wt, 'origin/ahead')).toBe(await tip(source, 'main'))
      expect(await fs.readFile(path.join(wt, '.git', 'FETCH_HEAD'), 'utf8')).toBe('the agent\'s\n')
      // No new objects: everything came through the alternate.
      expect(await git(wt, ['count-objects', '-v'])).toBe(objects)
    })
  })
})

describe('gitConfigValue', () => {
  it('quotes a value so git reads it back verbatim, as a value or a subsection name', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-config-value-'))
    try {
      const file = path.join(tmp, 'config')
      const value = 'a "quoted" back\\slash\nand a # not-a-comment ; nor this'
      await fs.writeFile(file, `[remote ${gitConfigValue('we"ird\\name')}]\n\turl = ${gitConfigValue(value)}\n`)
      expect(await git(tmp, ['config', '--file', file, '--get', 'remote.we"ird\\name.url'])).toBe(`${value}\n`)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
