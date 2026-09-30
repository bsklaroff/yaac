import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { parsePaneSession } from '#runtime/agents/agent-tools'

/**
 * The in-pane half of agent reporting, run as shipped. `workspace-bin/
 * yaac-agent-links` and `yaac-agent-report` turn a hook payload (or
 * arguments) into the pane options the status watcher reads: conversation,
 * model and permission mode. They always exit 0 silently, so a misread
 * payload fails silently too; hence the real scripts are run here.
 *
 * A `tmux` stub on PATH records its argv and stores pane options, so no tmux
 * server is needed.
 */

function script(name = 'yaac-agent-report'): string {
  return path.resolve(__dirname, '..', '..', '..', '..', '..', 'workspace-bin', name)
}

describe('the agent reporters', () => {
  let tmpDir: string
  let calls: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-report-hook-'))
    calls = path.join(tmpDir, 'calls')
    await fs.mkdir(path.join(tmpDir, 'bin'))
    await fs.mkdir(path.join(tmpDir, 'options'))
    await fs.writeFile(path.join(tmpDir, 'bin', 'tmux'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${calls}`,
      'shift 2; cmd=$1; shift; unset=',
      'while :; do case "$1" in -pu) unset=1; shift ;; -p|-pqv) shift ;; -t) pane=$2; shift 2 ;; *) break ;; esac; done',
      `f=${path.join(tmpDir, 'options')}/$pane$1`,
      'case $cmd in',
      '  show-options) cat "$f" 2>/dev/null ;;',
      '  set-option) if [ -n "$unset" ]; then rm -f "$f"; else printf %s "$2" > "$f"; fi ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function run(
    stdin: string,
    env: Record<string, string>,
    args: string[] = [],
    name?: string,
  ): Promise<{ stdout: string; tmux: string[] }> {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile('sh', [script(name), ...args], {
        env: {
          ...process.env,
          PATH: `${path.join(tmpDir, 'bin')}:${process.env.PATH ?? ''}`,
          TMUX: '',
          YAAC_TMUX: '',
          TMUX_PANE: '',
          ...env,
        },
      }, (err, out) => (err ? reject(err instanceof Error ? err : new Error('reporter failed')) : resolve(out)))
      // A reporter that exits before reading stdin closes the pipe, and an
      // unhandled EPIPE would fail the run.
      child.stdin?.on('error', () => {})
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
    // A `/clear` reports no model, so the pane keeps the current one.
    const { tmux } = await run(JSON.stringify({ session_id: 't', source: 'clear' }), env)
    expect(tmux).toEqual(['-S /tmp/yaac.sock set-option -p -t %0 @yaac-model claude-sonnet-5'])
  })

  it('takes the model as an argument from a caller that holds it', async () => {
    const { tmux } = await run('', { TMUX: '/tmp/yaac.sock,1,0', TMUX_PANE: '%1' }, ['anthropic/claude-opus-4-8'])
    expect(tmux).toEqual(['-S /tmp/yaac.sock set-option -p -t %1 @yaac-model anthropic/claude-opus-4-8'])
  })

  // claude has no mode-change event; the prompt and turn-end payloads carry
  // the current mode.
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

  describe('yaac-agent-links', () => {
    const pane = { TMUX: '/tmp/yaac.sock,1,0', TMUX_PANE: '%3' }
    const links = (stdin: string, args: string[], env: Record<string, string> = pane) =>
      run(stdin, env, args, 'yaac-agent-links')
    const hook = (home: string, tool: string, payload: Record<string, unknown>) =>
      links(JSON.stringify(payload), [home, tool])
    /** A pane option as the stub tmux holds it. */
    const option = (name: string, target = '%3'): Promise<string> =>
      fs.readFile(path.join(tmpDir, 'options', `${target}${name}`), 'utf8').catch(() => '')
    /** The session the server parses from the pane. */
    const named = async (target?: string) => parsePaneSession(await option('@yaac-session', target))
    const claudeHome = (): string => path.join(tmpDir, 'home', '.claude')

    it('names the conversation on its pane, with the transcript made project-relative', async () => {
      const { stdout } = await hook(claudeHome(), 'claude', {
        session_id: 'conv-a', hook_event_name: 'SessionStart',
        transcript_path: `${claudeHome()}/projects/-workspace/conv-a.jsonl`,
      })
      expect(stdout).toBe('')
      expect(await option('@yaac-session')).toBe('claude|conv-a|claude/projects/-workspace/conv-a.jsonl')
      expect(await named()).toEqual({
        tool: 'claude', agentSessionId: 'conv-a', transcriptPath: 'claude/projects/-workspace/conv-a.jsonl',
      })
      // A transcript outside the home has no relative form, so only the
      // conversation id is recorded.
      await hook(claudeHome(), 'claude', { session_id: 'conv-b', transcript_path: '/somewhere/else.jsonl' })
      expect(await named()).toEqual({ tool: 'claude', agentSessionId: 'conv-b' })
    })

    it('names no conversation whose id could climb out of a path it is joined into', () => {
      // The id ends up in `acp/<wt>/<id>.jsonl` and `--resume <id>`, and the
      // workspace can set any pane option, so the server validates it.
      for (const id of ['../../etc/passwd', 'a/b', '-flag', 'x'.repeat(129), 'a.b']) {
        expect(parsePaneSession(`claude|${id}|claude/t.jsonl`)).toBeUndefined()
      }
      expect(parsePaneSession('claude|ok-id_1|claude/t.jsonl')?.agentSessionId).toBe('ok-id_1')
    })

    it('makes the path project-relative through a symlinked tool home', async () => {
      // A containerless workspace: the tool home in its private HOME links to
      // the project's shared one, and the tool reports the physical path.
      const real = path.join(tmpDir, 'project', 'claude')
      const linked = path.join(tmpDir, 'workspace-home', '.claude')
      await fs.mkdir(real, { recursive: true })
      await fs.mkdir(path.dirname(linked), { recursive: true })
      await fs.symlink(real, linked)
      await hook(linked, 'claude', {
        session_id: 'conv-s', transcript_path: `${await fs.realpath(real)}/projects/conv-s.jsonl`,
      })
      expect((await named())?.transcriptPath).toBe('claude/projects/conv-s.jsonl')
    })

    it('hands the pane back when an agent nested in it ends, and clears it when its own does', async () => {
      await hook(claudeHome(), 'claude', { session_id: 'parent', transcript_path: `${claudeHome()}/p.jsonl` })
      // A `claude -p` from the parent's Bash tool inherits the pane.
      await hook(claudeHome(), 'claude', { session_id: 'child', transcript_path: `${claudeHome()}/c.jsonl` })
      expect((await named())?.agentSessionId).toBe('child')
      await hook(claudeHome(), 'claude', {
        session_id: 'child', hook_event_name: 'SessionEnd', transcript_path: `${claudeHome()}/c.jsonl`,
      })
      expect(await named()).toEqual({ tool: 'claude', agentSessionId: 'parent', transcriptPath: 'claude/p.jsonl' })
      expect(await option('@yaac-session-under')).toBe('')

      // An end for a conversation the pane does not name changes nothing.
      await hook(claudeHome(), 'claude', { session_id: 'stranger', hook_event_name: 'SessionEnd' })
      expect((await named())?.agentSessionId).toBe('parent')

      // A `/clear`: the old conversation ends, then the new one starts.
      await hook(claudeHome(), 'claude', { session_id: 'parent', hook_event_name: 'SessionEnd' })
      await hook(claudeHome(), 'claude', { session_id: 'next', transcript_path: `${claudeHome()}/n.jsonl` })
      expect((await named())?.agentSessionId).toBe('next')
      expect(await option('@yaac-session-under')).toBe('')
      // The agent quits, and the pane no longer names a conversation.
      await hook(claudeHome(), 'claude', { session_id: 'next', hook_event_name: 'SessionEnd' })
      expect(await option('@yaac-session')).toBe('')
    })

    it("drops codex's title session, whose start and end would take the pane", async () => {
      // codex 0.156.1 also fires SessionStart and SessionEnd on the same pane
      // for the throwaway session it uses to title a conversation.
      const home = path.join(tmpDir, 'home', '.codex')
      const rollout = `${home}/sessions/2026/09/25/rollout-thread-1.jsonl`
      await hook(home, 'codex', { session_id: 'thread-1', transcript_path: rollout })
      await hook(home, 'codex', { session_id: 'title-gen', transcript_path: null })
      await hook(home, 'codex', { session_id: 'title-gen', hook_event_name: 'SessionEnd', transcript_path: null })
      expect(await option('@yaac-session'))
        .toBe('codex|thread-1|codex/sessions/2026/09/25/rollout-thread-1.jsonl')
      await hook(home, 'codex', { session_id: 'thread-1', hook_event_name: 'SessionEnd', transcript_path: rollout })
      expect(await option('@yaac-session')).toBe('')
    })

    it('takes the conversation as arguments, reading no payload, and ends it with --end', async () => {
      // pi's extension names its log; codex's and opencode's resume launches
      // name only the id. claude hides $TMUX, which arrives as $YAAC_TMUX.
      const env = { YAAC_TMUX: '/tmp/yaac.sock,1,0', TMUX_PANE: '%2' }
      const home = path.join(tmpDir, 'home', '.pi')
      await links('', [home, 'pi', 'pi-1', `${home}/agent/sessions/2026_pi-1.jsonl`], env)
      expect(await named('%2'))
        .toEqual({ tool: 'pi', agentSessionId: 'pi-1', transcriptPath: 'pi/agent/sessions/2026_pi-1.jsonl' })
      // A resume launch names the conversation the tool will report again,
      // which is not nesting.
      await links('', ['', 'pi', 'pi-1'], env)
      await links('', ['', 'pi', 'pi-1', '--end'], env)
      expect(await option('@yaac-session', '%2')).toBe('')
    })

    it('does nothing outside a pane or without a tool', async () => {
      const payload = JSON.stringify({ session_id: 'x', transcript_path: '/x.jsonl' })
      await links(payload, ['/home', 'claude'], { TMUX: '/tmp/yaac.sock,1,0' })
      const { tmux } = await links(payload, [], pane)
      expect(tmux).toEqual([])
    })
  })
})
