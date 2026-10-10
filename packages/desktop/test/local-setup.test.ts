import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSetupRunner, setupConfirmation, type SetupRunner } from '#local-setup'

/*
 * The runner spawns real processes. `brew` and `yaac` are shell scripts on
 * a PATH of their own that answer each command line from a table and log
 * every call, so a test asserts on what reached the outside world.
 */
let dir: string
let bin: string
let calls: string
const inherited = process.env.PATH

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-setup-'))
  bin = path.join(dir, 'bin')
  calls = path.join(dir, 'calls')
  await fs.mkdir(bin)
  await fs.writeFile(calls, '')
  process.env.PATH = `${bin}:/usr/bin:/bin`
})

afterEach(async () => {
  process.env.PATH = inherited
  await fs.rm(dir, { recursive: true, force: true })
})

/** A `name` on PATH (or in `into`) whose reply to each argument line is a shell snippet. */
async function fake(name: string, replies: Record<string, string>, into = bin): Promise<void> {
  const cases = Object.entries(replies).map(([args, body]) => `  '${args}') ${body} ;;`).join('\n')
  await fs.writeFile(path.join(into, name), [
    '#!/bin/sh',
    `echo "${name} $*" >> '${calls}'`,
    'case "$*" in',
    cases,
    `  *) echo "unexpected: ${name} $*" >&2; exit 99 ;;`,
    'esac',
    '',
  ].join('\n'), { mode: 0o755 })
}

async function called(): Promise<string[]> {
  return (await fs.readFile(calls, 'utf8')).split('\n').filter((l) => l !== '')
}

function runner(): { setup: SetupRunner, changes: () => number } {
  let n = 0
  const setup = createSetupRunner(() => { n += 1 }, path.join(dir, 'unfinished.json'))
  return { setup, changes: () => n }
}

const HOST_CHECK = [
  '✓ tmux: on PATH',
  '✗ claude: not on PATH',
  '    fix: npm install -g @anthropic-ai/claude-code',
].join('\n')

describe('createSetupRunner', () => {
  it('sets up a containerless server from nothing: trust, install, start, and the host check\'s failures', async () => {
    // The formula install is what puts `yaac` on PATH.
    await fake('yaac', { 'server start': 'echo started', 'host check': `printf '%s\\n' '${HOST_CHECK}'; exit 1` }, dir)
    await fake('brew', {
      'trust --tap --json=v1': 'echo \'[]\'',
      'list --formula --versions yaac-server': 'exit 1',
      'trust bsklaroff/yaac': 'echo Trusted tap: bsklaroff/yaac',
      'install bsklaroff/yaac/yaac-server':
        `printf '\\033[34m==>\\033[0m Pouring\\r 10%%\\r100%%\\n'; cp '${dir}/yaac' '${bin}/yaac'`,
    })
    const { setup, changes } = runner()

    const outcome = await setup.run('server')

    expect(outcome).toEqual({ ok: true, hostCheckFailures: '✗ claude: not on PATH\n    fix: npm install -g @anthropic-ai/claude-code' })
    expect(await called()).toEqual([
      'brew list --formula --versions yaac-server',
      'brew trust --tap --json=v1',
      'brew trust bsklaroff/yaac',
      // Each command can change the answers, so the next step asks again.
      'brew list --formula --versions yaac-server',
      'brew install bsklaroff/yaac/yaac-server',
      'yaac server start',
      'yaac host check',
    ])
    const run = setup.current()!
    expect(run.phase).toBe('succeeded')
    expect(run.steps.map((s) => [s.command, s.state])).toEqual([
      ['brew trust bsklaroff/yaac', 'done'],
      ['brew install bsklaroff/yaac/yaac-server', 'done'],
      ['yaac server start', 'done'],
      ['yaac host check', 'done'],
    ])
    // Colors are stripped, and a carriage return ends a line.
    expect(run.log).toEqual([
      '$ brew trust bsklaroff/yaac', 'Trusted tap: bsklaroff/yaac',
      '$ brew install bsklaroff/yaac/yaac-server', '==> Pouring', ' 10%', '100%',
      '$ yaac server start', 'started',
      '$ yaac host check', ...HOST_CHECK.split('\n'),
    ])
    expect(changes()).toBeGreaterThan(run.steps.length)
  })

  it('skips what is already done, stops at a failing step, and converges an unfinished install next time', async () => {
    await fake('yaac', {
      'cluster install': 'echo "kind: creating cluster"; echo "no podman machine" >&2; exit 3',
    })
    await fake('brew', {
      'trust --tap --json=v1': 'echo \'["bsklaroff/yaac", "libkrun/krun"]\'',
      'list --formula --versions yaac-cluster': 'exit 1',
      'tap': 'printf "homebrew/core\\nlibkrun/krun\\n"',
      'install bsklaroff/yaac/yaac-cluster': 'echo installed',
    })
    const { setup } = runner()

    expect(await setup.run('cluster'))
      .toEqual({ ok: false, error: 'yaac cluster install exited with code 3' })
    // Only the missing formula and the install itself ran.
    expect((await called()).filter((c) => !/ (list|--json)/.test(c) && c !== 'brew tap'))
      .toEqual(['brew install bsklaroff/yaac/yaac-cluster', 'yaac cluster install'])
    const run = setup.current()!
    expect(run.phase).toBe('failed')
    expect(run.steps.map((s) => [s.label, s.state, s.note])).toEqual([
      ['Trust the yaac tap', 'skipped', 'already trusted'],
      ['Install the yaac CLI', 'skipped', 'already installed'],
      ['Trust the libkrun tap', 'skipped', 'already trusted'],
      ['Add the libkrun tap', 'skipped', 'already added'],
      ['Install the cluster tools', 'done', undefined],
      ['Install the cluster', 'failed', 'exited with code 3'],
    ])
    expect(run.log.slice(-2)).toEqual(['kind: creating cluster', 'no podman machine'])

    // The failed install already recorded its driver; a relaunched app still knows it never finished.
    expect(setup.unfinished()).toEqual(['cluster'])
    const relaunched = runner().setup
    await new Promise((r) => setTimeout(r, 50))
    expect(relaunched.unfinished()).toEqual(['cluster'])

    // `yaac cluster install` runs again to converge it, here under a Homebrew from before tap trust.
    await fake('yaac', { 'cluster install': 'echo converged' })
    await fake('brew', {
      'trust --tap --json=v1': 'echo "Error: Unknown command: trust" >&2; exit 1',
      'list --formula --versions yaac-cluster': 'echo yaac-cluster 1.0.0',
    })
    expect(await relaunched.run('cluster')).toEqual({ ok: true })
    expect(relaunched.current()!.steps.map((s) => s.note)).toEqual([
      'nothing to install from it', 'already installed', 'nothing to install from it', 'nothing to install from it',
      'already installed', undefined,
    ])
    expect(relaunched.unfinished()).toEqual([])
    expect(JSON.parse(await fs.readFile(path.join(dir, 'unfinished.json'), 'utf8'))).toEqual([])
  })

  it('points at brew.sh when Homebrew is missing, and needs none when there is nothing to install', async () => {
    const { setup } = runner()
    expect(await setup.run('server'))
      .toEqual({ ok: false, error: 'Homebrew is not installed. Install it from https://brew.sh, then set up again.' })
    expect(setup.current()!.steps[0].state).toBe('failed')

    await fake('yaac', { 'server start': 'echo started', 'host check': 'echo all good' })
    expect(await setup.run('server')).toEqual({ ok: true })
    expect(await called()).toEqual(['yaac server start', 'yaac host check'])
  })

  it('finishes a step whose command exits while something it started still holds its output', async () => {
    const pid = path.join(dir, 'pid')
    // A helper in a session of its own, as a VM launcher might leave behind.
    const daemon = `'${process.execPath}' -e "const c = require('child_process').spawn('sleep', ['30'], `
      + `{ detached: true, stdio: 'inherit' }); require('fs').writeFileSync('${pid}', String(c.pid)); c.unref()"`
    await fake('yaac', { 'server start': `${daemon}; echo started`, 'host check': 'echo ok' })
    const { setup } = runner()
    const started = Date.now()
    try {
      expect(await setup.run('server')).toEqual({ ok: true })
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(setup.current()!.log).toContain('started')
    } finally {
      process.kill(Number(await fs.readFile(pid, 'utf8')))
    }
  })

  it('confirms a setup by naming its commands and the taps it trusts', () => {
    const { message, detail } = setupConfirmation('cluster')
    expect(message).toBe('Set up a local Kubernetes cluster on this Mac?')
    expect(detail).toContain('trusts the Homebrew taps bsklaroff/yaac and libkrun/krun (third-party, not yaac\'s)')
    expect(detail).toContain('  brew tap libkrun/krun\n\n  brew install bsklaroff/yaac/yaac-cluster')
    expect(setupConfirmation('server').detail).toContain('trusts the Homebrew tap bsklaroff/yaac, which')
  })

  it('cancels a long step, killing what it spawned, and refuses a second run meanwhile', async () => {
    const pid = path.join(dir, 'pid')
    await fake('yaac', {
      'cluster install': `sleep 30 & echo $! > '${pid}'; echo creating; wait`,
    })
    await fake('brew', { 'list --formula --versions yaac-cluster': 'echo yaac-cluster 1.0.0' })
    const { setup } = runner()

    const running = setup.run('cluster')
    while (!setup.current()?.log.includes('creating')) await new Promise((r) => setTimeout(r, 20))
    expect(await setup.run('server')).toEqual({ ok: false, error: 'a setup is already running' })
    const started = Date.now()
    const cancelled = setup.cancel()

    expect(await running).toEqual({ ok: false, error: 'setup cancelled' })
    await cancelled
    expect(Date.now() - started).toBeLessThan(3000)
    const run = setup.current()!
    expect(run.phase).toBe('cancelled')
    expect(run.steps.at(-1)?.state).toBe('cancelled')
    const grandchild = Number(await fs.readFile(pid, 'utf8'))
    await new Promise((r) => setTimeout(r, 100))
    expect(() => process.kill(grandchild, 0)).toThrow()
  })
})
