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
    const done = await runScript(stepScript('ci.build', { run }, path.join(dir, 'step.events')))
    expect(done.status).toBe(1)
    expect(done.out).toBe('hi from sub\n')
    expect(done.events).toEqual(['start 0', 'end 0 0', 'start 1', 'end 1 0', 'start 2', 'end 2 0', 'start 3', 'end 3 1'])
    // Its first act keeps its own pane on exit, by the pane's id.
    expect(done.tmux[0]).toBe('set-option -w -t %9 remain-on-exit on')

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

  it('starts in the directory it is given, else the workspace\'s cwd', async () => {
    await fs.mkdir(path.join(dir, 'web'))
    const pwd = { run: ['pwd'] }
    expect((await runScript(stepScript('a.b', pwd, path.join(dir, 'a.events'), [], path.join(dir, 'web')))).out).toBe(`${path.join(dir, 'web')}\n`)
    expect((await runScript(stepScript('a.b', pwd, path.join(dir, 'a.events')))).out).toBe(`${dir}\n`)
  })

  it('marks a service ready once its check passes, just before its last command, and re-lists its window', async () => {
    const done = await runScript(stepScript('db', {
      run: ['touch setup-done', 'sleep 1'], service: true, ready: 'test -f setup-done',
    }, path.join(dir, 'step.events')))
    expect(done.status).toBe(0)
    expect(done.tmux.slice(1)).toEqual(['set-option -w -t %9 @yaac-step-ready 1', 'rename-window -t %9 db'])
    // With no check, it is ready as its last command starts.
    const plain = await runScript(stepScript('dev', { run: ['true'], service: true }, path.join(dir, 'step.events')))
    expect(plain.tmux.slice(-2)).toEqual(['set-option -w -t %9 @yaac-step-ready 1', 'rename-window -t %9 dev'])
  })
})

/** What killing the windows named `name` runs: found by name in the
 *  listing, killed by id. */
const killByName = (name: string): string => `for w in $(${TMUX} list-windows -t =yaac -F '#{window_id} #{window_name}' 2>/dev/null `
  + `| awk -v n='${name}' '{ id = $1; sub(/^[^ ]* /, ""); if ($0 == n) print id }'); do ${TMUX} kill-window -t "$w" 2>/dev/null; done`

describe('stepWindowExec', () => {
  it('replaces any window of the step\'s name, found by id, with one running its script', () => {
    expect(stepWindowExec('ci.build', PATHS, '/home/yaac/.yaac-logs/L/ci.build.sh')).toBe(
      `${killByName('ci.build')}; ${TMUX} new-window -d -t yaac -n 'ci.build' -c '#{session_path}' `
      + `'sh '\\''/home/yaac/.yaac-logs/L/ci.build.sh'\\'''`,
    )
  })
})

describe('killStepWindowExec', () => {
  it('kills the step\'s window if there is one, by id', () => {
    expect(killStepWindowExec('ci.dev', PATHS)).toBe(`${killByName('ci.dev')}; true`)
  })
})

describe('lifeHooksConfig', () => {
  it('logs every new window but a session\'s, and re-lists on a pane death', () => {
    const config = lifeHooksConfig(PATHS, '/home/yaac/.yaac-logs/L')
    expect(config).toContain('set-option -g @yaac-log-dir "/home/yaac/.yaac-logs/L"')
    expect(config).toContain('#{m:claude-*,#{window_name}}')
    // A step's window holds a ".", so a workflow named after a tool is logged.
    expect(config).toContain('#{?#{m:*.*,#{window_name}},0,')
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
        const steps = [...Array.from({ length: 15 }, (_, i) => `ci.s${i}`), 'claude-review.s']
        for (const name of [...steps, 'claude-1']) {
          await tmux('new-window', '-d', '-t', 'yaac', '-n', name, 'tmux set-option -w -t "$TMUX_PANE" remain-on-exit on; '
            + `echo first-${name}; sleep 0.3; echo last-${name}`)
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
