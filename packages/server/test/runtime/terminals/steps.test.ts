import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { killStepWindowExec, lifeHooksConfig, sourceHooksCommand, stepScript, stepWindowExec } from '#runtime/terminals'
import { workspacePathsFixture } from '#test/support/fake-driver'
import { workspaceBinDir } from '#domain/workspaces/workspace-bin'

const run = promisify(execFile)
const PATHS = workspacePathsFixture()
const TMUX = `tmux -S ${PATHS.tmuxSock}`

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-steps-'))
})
/* Retried because a log writer still exiting after its tmux server is
 * killed recreates a log the removal has just deleted. */
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

/**
 * Run a step's script for real, with a `tmux` on PATH that records how it
 * was called. Resolves with the exit status, what the script
 * printed, its events and the tmux calls.
 */
async function runScript(script: string, shell = '/bin/sh'): Promise<{ status: number; out: string; events: string[]; tmux: string[] }> {
  const bin = path.join(dir, 'bin')
  await fs.mkdir(bin, { recursive: true })
  // It answers the session's directory, where a step starts, with `dir`.
  await fs.writeFile(path.join(bin, 'tmux'), '#!/bin/sh\n'
    + `case "$1" in display-message) echo ${dir}; exit 0 ;; esac\necho "$*" >> ${dir}/tmux.calls\n`, { mode: 0o755 })
  await fs.writeFile(path.join(dir, 'step.sh'), script)
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, TMUX_PANE: '%9', SHELL: shell }
  delete env.YAAC_STEP_SHELL
  const done = await run('sh', [path.join(dir, 'step.sh')], { env }).then(
    ({ stdout }) => ({ status: 0, out: stdout }),
    (err: { code: number; stdout: string }) => ({ status: err.code, out: err.stdout }),
  )
  const read = (f: string): Promise<string[]> => fs.readFile(path.join(dir, f), 'utf8').then((t) => t.trim().split('\n'), () => [])
  return { ...done, events: (await read('step.events')).map((l) => l.replace(/ \S+$/, '')), tmux: await read('tmux.calls') }
}

describe('stepScript', () => {
  it('runs the commands in order in one shell, stopping at the first failure, with an event around each', async () => {
    const run = ['export GREETING=hi', 'cd sub 2>/dev/null || mkdir sub && cd sub', 'echo "$GREETING from $(basename "$PWD")"', 'false', 'echo never']
    const done = await runScript(stepScript('build', { run }, path.join(dir, 'step.events')))
    expect(done.status).toBe(1)
    expect(done.out).toBe('hi from sub\n')
    expect(done.events).toEqual(['start 0', 'end 0 0', 'start 1', 'end 1 0', 'start 2', 'end 2 0', 'start 3', 'end 3 1'])

    // A command that exits the script itself still closes its own event.
    const exits = await runScript(stepScript('exits', { run: ['echo about to', 'exit 7', 'echo never'] }, path.join(dir, 'exits.events')))
    expect(exits.status).toBe(7)
    const events = (await fs.readFile(path.join(dir, 'exits.events'), 'utf8')).trim().split('\n').map((l) => l.replace(/ \S+$/, ''))
    expect(events).toEqual(['start 0', 'end 0 0', 'start 1', 'end 1 7'])
  })

  it('runs the commands in the workspace\'s POSIX-family $SHELL, else bash', async () => {
    const which = { run: ['echo "${BASH_VERSION:+bash}${ZSH_VERSION:+zsh}"'] }
    expect((await runScript(stepScript('a', which, path.join(dir, 'a.events')), '/bin/bash')).out).toBe('bash\n')
    expect((await runScript(stepScript('b', which, path.join(dir, 'b.events')), '/usr/bin/fish')).out).toBe('bash\n')
  })

  it('marks a service ready once its check passes, just before its last command, and re-lists its window', async () => {
    const done = await runScript(stepScript('db', {
      run: ['touch setup-done', 'sleep 1'], service: true, ready: 'test -f setup-done',
    }, path.join(dir, 'step.events')))
    expect(done.status).toBe(0)
    expect(done.tmux).toEqual(['set-option -w -t %9 @yaac-step-ready 1', 'rename-window -t %9 db'])
    // With no check, it is ready as its last command starts.
    const plain = await runScript(stepScript('dev', { run: ['true'], service: true }, path.join(dir, 'step.events')))
    expect(plain.tmux.slice(-2)).toEqual(['set-option -w -t %9 @yaac-step-ready 1', 'rename-window -t %9 dev'])
  })
})

describe('stepWindowExec', () => {
  it('replaces any window of the step\'s name with one running its script, keeping its pane on exit', () => {
    expect(stepWindowExec('build', PATHS, '/home/yaac/.yaac-logs/L/build.sh')).toBe(
      `${TMUX} kill-window -t =yaac:=build 2>/dev/null; ${TMUX} new-window -d -t yaac -n 'build' -c '#{session_path}' `
      + `'sh '\\''/home/yaac/.yaac-logs/L/build.sh'\\''' \\; set-option -t =yaac:=build remain-on-exit on`,
    )
  })
})

describe('killStepWindowExec', () => {
  it('kills the step\'s window if there is one', () => {
    expect(killStepWindowExec('dev', PATHS)).toBe(`${TMUX} kill-window -t =yaac:=dev 2>/dev/null || true`)
  })
})

describe('lifeHooksConfig', () => {
  it('logs every new window but a session\'s, and re-lists on a pane death', () => {
    const config = lifeHooksConfig(PATHS, '/home/yaac/.yaac-logs/L')
    expect(config).toContain('set-option -g @yaac-log-dir "/home/yaac/.yaac-logs/L"')
    expect(config).toContain('#{m:claude-*,#{window_name}}')
    expect(config).toContain('#{m:pi-*,#{window_name}}')
    expect(config).toContain('pipe-pane -o "exec yaac-log-writer \'#{@yaac-log-dir}/#{window_name}.log\'"')
    expect(config).toContain(`run-shell "${TMUX} rename-window -t '#{hook_pane}' '#{window_name}'"`)
  })

  /*
   * Against a real tmux and the shipped writer: each step's log holds all it
   * printed, its last line too, while its window stays open after the script
   * exits, so the writer never sees end of input. A writer that holds back
   * its last chunk until more input arrives fails here. Whether it does can
   * come down to a kernel race, so the test opens many windows.
   */
  it.skipIf(!['/usr/bin/tmux', '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux'].some((p) => existsSync(p)))(
    'logs all a step printed while its dead pane stays open, and nothing of a session\'s window',
    async () => {
      const sock = path.join(dir, 'tmux.sock')
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${workspaceBinDir()}:${process.env.PATH ?? ''}` }
      delete env.TMUX
      delete env.TMUX_PANE
      const tmux = (...args: string[]): Promise<{ stdout: string }> => run('tmux', ['-S', sock, ...args], { env })
      await fs.writeFile(path.join(dir, 'hooks.conf'), lifeHooksConfig({ ...PATHS, tmuxSock: sock }, dir))
      try {
        await tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'yaac', '-n', 'keeper')
        await tmux('source-file', path.join(dir, 'hooks.conf'))
        const steps = Array.from({ length: 16 }, (_, i) => `s${i}`)
        for (const name of [...steps, 'claude-1']) {
          await tmux('new-window', '-d', '-t', 'yaac', '-n', name,
            `echo first-${name}; sleep 0.3; echo last-${name}`, ';', 'set-option', '-t', `yaac:${name}`, 'remain-on-exit', 'on')
        }
        const log = (name: string): Promise<string> => fs.readFile(path.join(dir, `${name}.log`), 'utf8').catch(() => '')
        const logged = async (): Promise<boolean> => (await Promise.all(steps.map(log))).every((t, i) => t.includes(`last-${steps[i]}`))
        for (const deadline = Date.now() + 5000; !(await logged()) && Date.now() < deadline;) {
          await new Promise((r) => setTimeout(r, 100))
        }
        for (const name of steps) expect((await log(name)).replace(/\r/g, '')).toBe(`first-${name}\nlast-${name}\n`)
        expect(existsSync(path.join(dir, 'claude-1.log'))).toBe(false)
      } finally {
        await tmux('kill-server').catch(() => {})
      }
    },
  )
})

describe('sourceHooksCommand', () => {
  it('sources the config at its path in the workspace', () => {
    expect(sourceHooksCommand(PATHS, '/home/yaac/.yaac-logs/L/hooks.conf')).toBe(`${TMUX} source-file '/home/yaac/.yaac-logs/L/hooks.conf'`)
  })
})
