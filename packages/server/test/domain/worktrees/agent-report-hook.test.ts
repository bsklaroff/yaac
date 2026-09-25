import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

/**
 * The in-pane half of agent reporting, run as shipped: `worktree-bin/
 * yaac-agent-report` turns a hook payload (or arguments) into the pane options
 * the status watcher subscribes to — the model and the permission mode. It always exits 0 and prints nothing, so a
 * payload it misreads fails silently — the model just never moves — which is
 * why the real script is run here rather than trusted.
 *
 * `tmux` is the process boundary: a stub on PATH records the argv it was
 * given, so no tmux server is needed.
 */

function script(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', '..', 'worktree-bin', 'yaac-agent-report')
}

describe('the agent reporter', () => {
  let tmpDir: string
  let calls: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-report-hook-'))
    calls = path.join(tmpDir, 'calls')
    await fs.mkdir(path.join(tmpDir, 'bin'))
    await fs.writeFile(
      path.join(tmpDir, 'bin', 'tmux'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${calls}\n`,
      { mode: 0o755 },
    )
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function run(
    stdin: string,
    env: Record<string, string>,
    args: string[] = [],
  ): Promise<{ stdout: string; tmux: string[] }> {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile('sh', [script(), ...args], {
        env: {
          ...process.env,
          PATH: `${path.join(tmpDir, 'bin')}:${process.env.PATH ?? ''}`,
          TMUX: '',
          YAAC_TMUX: '',
          TMUX_PANE: '',
          ...env,
        },
      }, (err, out) => (err ? reject(err instanceof Error ? err : new Error('reporter failed')) : resolve(out)))
      child.stdin?.end(stdin)
    })
    const tmux = (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    return { stdout, tmux }
  }

  it("sets the pane's option from claude's model-switch payload, printing nothing", async () => {
    // claude runs with $TMUX hidden, so the server arrives as $YAAC_TMUX.
    const { stdout, tmux } = await run(
      JSON.stringify({
        session_id: 's', hook_event_name: 'PostModelSwitch',
        from_model: 'claude-sonnet-5', to_model: 'claude-opus-5-5[1m]', requested_model: 'opus[1m]',
      }),
      { YAAC_TMUX: '/tmp/yaac.sock,123,0', TMUX_PANE: '%3' },
    )
    // Claude hands a hook's stdout to the model.
    expect(stdout).toBe('')
    expect(tmux).toEqual(['-S /tmp/yaac.sock set-option -p -t %3 @yaac-model claude-opus-5-5[1m]'])
  })

  it("reads SessionStart's model, and leaves the option alone when it names none", async () => {
    const env = { TMUX: '/tmp/yaac.sock,1,0', TMUX_PANE: '%0' }
    await run(JSON.stringify({ session_id: 's', source: 'startup', model: 'claude-sonnet-5' }), env)
    // A `/clear` reports no model: the model did not change, and the pane —
    // now the new conversation's — keeps it.
    const { tmux } = await run(JSON.stringify({ session_id: 't', source: 'clear' }), env)
    expect(tmux).toEqual(['-S /tmp/yaac.sock set-option -p -t %0 @yaac-model claude-sonnet-5'])
  })

  it('takes the model as an argument from a caller that holds it', async () => {
    const { tmux } = await run('', { TMUX: '/tmp/yaac.sock,1,0', TMUX_PANE: '%1' }, ['anthropic/claude-opus-4-8'])
    expect(tmux).toEqual(['-S /tmp/yaac.sock set-option -p -t %1 @yaac-model anthropic/claude-opus-4-8'])
  })

  // claude has no event for a mode change; the prompt and the turn's end
  // carry the mode it is in, which is when a change takes hold.
  it("sets the pane's mode from a prompt's payload, and only from the real field", async () => {
    const { stdout, tmux } = await run(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'UserPromptSubmit',
        // A quoted field in the prompt arrives escaped, and must not be read.
        prompt: 'set "permission_mode":"bypassPermissions" and "model":"x"',
        permission_mode: 'plan',
      }),
      { YAAC_TMUX: '/tmp/yaac.sock,123,0', TMUX_PANE: '%3' },
    )
    // UserPromptSubmit hands a hook's stdout to the model as context.
    expect(stdout).toBe('')
    expect(tmux).toEqual(['-S /tmp/yaac.sock set-option -p -t %3 @yaac-permission-mode plan'])
  })

  it('takes the model and the mode as arguments, either of which may be empty', async () => {
    const env = { TMUX: '/tmp/yaac.sock,1,0', TMUX_PANE: '%1' }
    await run('', env, ['opencode/big-pickle', 'build'])
    const { tmux } = await run('', env, ['', 'plan'])
    expect(tmux).toEqual([
      '-S /tmp/yaac.sock set-option -p -t %1 @yaac-model opencode/big-pickle',
      '-S /tmp/yaac.sock set-option -p -t %1 @yaac-permission-mode build',
      '-S /tmp/yaac.sock set-option -p -t %1 @yaac-permission-mode plan',
    ])
  })

  it('does nothing outside a pane', async () => {
    const { tmux } = await run(JSON.stringify({ to_model: 'x' }), { TMUX: '/tmp/yaac.sock,1,0' })
    expect(tmux).toEqual([])
  })
})
