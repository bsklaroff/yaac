import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installOmpWrapper } from '../omp-homes.js'

/**
 * Installs the wrapper over an npm prefix laid out as npm installs omp,
 * with a stand-in `cli.js` that prints the homes it was given, then moves
 * the prefix, as the containerless install renames its staging prefix.
 */
describe('installOmpWrapper', () => {
  let dir: string
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('hands omp the agent dir a workspace names for it and drops pi\'s session dir, from wherever the prefix ends up', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-omp-homes-'))
    const staging = path.join(dir, 'staging')
    const cli = path.join(staging, 'lib', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js')
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.writeFileSync(cli, '#!/bin/sh\necho "$PI_CODING_AGENT_DIR|$PI_CODING_AGENT_SESSION_DIR|$*"\n', { mode: 0o755 })
    fs.mkdirSync(path.join(staging, 'bin'))
    fs.symlinkSync(path.relative(path.join(staging, 'bin'), cli), path.join(staging, 'bin', 'omp'))

    installOmpWrapper(cli)
    const prefix = path.join(dir, 'prefix')
    fs.renameSync(staging, prefix)
    const omp = path.join(prefix, 'bin', 'omp')
    expect(fs.lstatSync(omp).isSymbolicLink()).toBe(false)

    const run = (env: Record<string, string>): string =>
      execFileSync(omp, ['acp', '--model', 'a b'], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' })
    const pi = { PI_CODING_AGENT_DIR: '/pi', PI_CODING_AGENT_SESSION_DIR: '/pi-sessions' }
    // omp then keeps its logs under its agent dir, where its acp server
    // looks for a conversation to load.
    expect(run({ ...pi, YAAC_OMP_AGENT_DIR: '/omp/agent' })).toBe('/omp/agent||acp --model a b\n')
    // Outside a workspace nothing names omp's homes, and nothing changes.
    expect(run(pi)).toBe('/pi|/pi-sessions|acp --model a b\n')
    // Through PATH, as yaac's launches and a terminal run it.
    expect(execFileSync('sh', ['-c', 'omp x'], {
      env: { PATH: `${path.dirname(omp)}:${process.env.PATH ?? ''}`, YAAC_OMP_AGENT_DIR: '/omp/agent' },
      encoding: 'utf8',
    })).toBe('/omp/agent||x\n')

    // A second run (a reinstall over it) leaves the same wrapper.
    const first = fs.readFileSync(omp, 'utf8')
    installOmpWrapper(path.join(prefix, 'lib', 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js'))
    expect(fs.readFileSync(omp, 'utf8')).toBe(first)
  })
})
