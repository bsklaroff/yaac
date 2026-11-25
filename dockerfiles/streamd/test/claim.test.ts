// The claim call (claim.js): what it writes into the home dir and the one
// tmux invocation it hands the workspace's environment to. tmux and the
// opencode checkpoint script are replaced by a recorder.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { claimWorkspace } from '../claim.js'

let home: string
let calls: Array<{ cmd: string; args: string[] }>
const run = (cmd: string, args: string[]): Promise<void> => {
  calls.push({ cmd, args })
  return Promise.resolve()
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-claim-'))
  calls = []
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

const base = {
  git: { name: 'Ada "A" Lovelace', email: 'ada@example.com', safeDirectories: ['/workspace', '/workspace/b\\c'] },
  env: { TZ: 'Europe/Paris', 'YAAC_PORT_3000': '3000', EMPTY: '' },
  cwd: '/workspace/app',
  statusRight: 'ports: 3000',
}

describe('claimWorkspace', () => {
  it('writes the git identity and trust, and hands tmux the environment, session and status line in one call', async () => {
    await fs.writeFile(path.join(home, '.gitconfig'), '[stale]\n')
    await (claimWorkspace as (r: unknown, d: unknown) => Promise<void>)(base, { home, run })

    expect(await fs.readFile(path.join(home, '.gitconfig'), 'utf8')).toBe([
      '[user]',
      '\tname = "Ada \\"A\\" Lovelace"',
      '\temail = "ada@example.com"',
      '[checkout]',
      '\tworkers = 8',
      '[safe]',
      '\tdirectory = "/workspace"',
      '\tdirectory = "/workspace/b\\\\c"',
      '',
    ].join('\n'))
    expect(calls).toHaveLength(1)
    const { cmd, args } = calls[0]
    expect(cmd).toBe('tmux')
    expect(args).toEqual([
      '-S', '/tmp/yaac-tmux/server',
      'set-environment', '-g', 'TZ', 'Europe/Paris', ';',
      'set-environment', '-g', 'YAAC_PORT_3000', '3000', ';',
      'set-environment', '-g', 'EMPTY', '', ';',
      'new-session', '-d', '-s', 'yaac', '-n', '_yaac-starting', '-x', '500', '-y', '200', '-c', '/workspace/app', 'sleep infinity', ';',
      'set-option', '-t', 'yaac', 'status-right-length', '80', ';',
      'set-option', '-t', 'yaac', 'status-right', 'ports: 3000',
    ])
    // No npm registry asked for, so no ~/.npmrc.
    await expect(fs.access(path.join(home, '.npmrc'))).rejects.toThrow()
  })

  it('gets every value through tmux\'s argument parser intact, and gives streamd\'s own environment the variables', async () => {
    // tmux takes an argument ending in `;` as a separator, so these are the
    // values it would otherwise cut short or reject. Run for real: the
    // escaping is tmux's rule, not ours.
    const env = { SEMI: ';', ENDS: 'x;', ESCAPED: 'p\\;', BRACE: '{', LINES: 'a\nb', AFTER: 'set' }
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-claim-cwd;'))
    const socket = path.join(home, 'tmux')
    const processEnv: Record<string, string> = { KEPT: 'yes' }
    await (claimWorkspace as (r: unknown, d: unknown) => Promise<void>)({ ...base, env, cwd, statusRight: 'ends;' }, { home, run, processEnv })
    const args = calls[0].args.map((a) => (a === '/tmp/yaac-tmux/server' ? socket : a))
    try {
      execFileSync('tmux', ['-f', '/dev/null', ...args])
      const shown = execFileSync('tmux', ['-S', socket, 'show-environment', '-g'], { encoding: 'utf8' })
      for (const [name, value] of Object.entries(env)) expect(shown).toContain(`${name}=${value}\n`)
      expect(execFileSync('tmux', ['-S', socket, 'display', '-p', '-t', 'yaac', '#{session_path}'], { encoding: 'utf8' })).toBe(`${cwd}\n`)
      expect(execFileSync('tmux', ['-S', socket, 'show-option', '-v', '-t', 'yaac', 'status-right'], { encoding: 'utf8' })).toBe('ends;\n')
    } finally {
      try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }) } catch { /* not running */ }
      await fs.rm(cwd, { recursive: true, force: true })
    }
    expect(processEnv).toEqual({ KEPT: 'yes', ...env })
  })

  it('adds the npm cache only where ~/.npmrc names no registry', async () => {
    await fs.writeFile(path.join(home, '.npmrc'), 'fund=false\n')
    await (claimWorkspace as (r: unknown, d: unknown) => Promise<void>)({ ...base, npmRegistry: 'http://cache.yaac/' }, { home, run })
    expect(await fs.readFile(path.join(home, '.npmrc'), 'utf8')).toBe('fund=false\nregistry=http://cache.yaac/\n')

    await fs.writeFile(path.join(home, '.npmrc'), 'registry=https://mine.example/\n')
    await (claimWorkspace as (r: unknown, d: unknown) => Promise<void>)({ ...base, npmRegistry: 'http://cache.yaac/' }, { home, run })
    expect(await fs.readFile(path.join(home, '.npmrc'), 'utf8')).toBe('registry=https://mine.example/\n')
  })

  it('restores opencode\'s working copy from its checkpoint, saving a newer working copy first', async () => {
    const data = path.join(home, '.local/share/opencode')
    const ckpt = path.join(home, '.yaac/opencode-checkpoint')
    await fs.mkdir(data, { recursive: true })
    await fs.mkdir(ckpt, { recursive: true })
    await fs.writeFile(path.join(ckpt, 'opencode.db'), 'saved')
    await fs.writeFile(path.join(ckpt, '.hidden'), 'h')
    await fs.writeFile(path.join(ckpt, '.tmp-1.db'), 'partial')
    await fs.utimes(path.join(ckpt, 'opencode.db'), 1000, 1000)
    await fs.writeFile(path.join(data, 'opencode.db'), 'newer')
    await fs.writeFile(path.join(data, 'leftover'), 'x')

    await (claimWorkspace as (r: unknown, d: unknown) => Promise<void>)(base, { home, run })

    expect(calls.map((c) => c.cmd)).toEqual(['yaac-opencode-checkpoint', 'tmux'])
    expect((await fs.readdir(data)).sort()).toEqual(['.hidden', 'opencode.db'])
    expect(await fs.readFile(path.join(data, 'opencode.db'), 'utf8')).toBe('saved')
  })

  it('waits for the started marker, and gives up past its deadline', async () => {
    const marker = path.join(home, 'started.life')
    const gitconfig = path.join(home, '.gitconfig')
    let done = false
    const looks = vi.spyOn(fs, 'lstat')
    const claim = (claimWorkspace as (r: unknown, d: unknown) => Promise<void>)({ ...base, startedMarker: marker, waitMs: 60_000 }, { home, run })
      .then(() => { done = true })
    // Several looks for the marker go by with nothing written.
    await vi.waitFor(() => { expect(looks.mock.calls.filter(([p]) => p === marker).length).toBeGreaterThanOrEqual(3) })
    looks.mockRestore()
    expect(done).toBe(false)
    await expect(fs.access(gitconfig)).rejects.toThrow()
    expect(calls).toHaveLength(0)
    await fs.writeFile(marker, '')
    await vi.waitFor(() => { expect(done).toBe(true) })
    await claim
    await fs.access(gitconfig)
    expect(calls).toHaveLength(1)

    await expect((claimWorkspace as (r: unknown, d: unknown) => Promise<void>)(
      { ...base, startedMarker: path.join(home, 'never'), waitMs: 0 }, { home, run },
    )).rejects.toThrow(/not ready/)
  })

  it('refuses a git value with a line break', async () => {
    await expect((claimWorkspace as (r: unknown, d: unknown) => Promise<void>)(
      { ...base, git: { ...base.git, name: 'a\n[core]' } }, { home, run },
    )).rejects.toThrow(/line break/)
    expect(calls).toHaveLength(0)
  })
})
