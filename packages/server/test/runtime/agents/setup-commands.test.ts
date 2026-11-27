import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, it, expect } from 'vitest'
import { buildRespawnExec, buildWindowsExec, finishSetupCommand } from '#runtime/agents/setup-commands'
import { KEEPER_STARTING, KEEPER_WINDOW } from '#drivers/contract'
import { workspaceBinDir } from '#domain/workspaces/workspace-bin'

import { workspacePathsFixture } from '#test/support/fake-driver'
import { DAEMONS_DIR } from '@yaac/shared/project-paths'

// The container paths these commands are written against.
const PATHS = workspacePathsFixture()
const TMUX = `tmux -S ${PATHS.tmuxSock}`
const run = promisify(execFile)

describe('buildWindowsExec', () => {
  const claude = { tool: 'claude' as const, mode: 'tui' as const, window: 'claude-aaaa', cwd: PATHS.workspaceDir, cmd: 'claude --session-id x' }

  // A session's window keeps its pane when the agent exits, for a resume.
  it('opens each session in a window of its own, in its own cwd, keeping its pane on exit', () => {
    expect(buildWindowsExec([claude], PATHS)).toBe(
      `${TMUX} new-window -d -t =yaac: -n claude-aaaa -c ${PATHS.workspaceDir} 'claude --session-id x'`
      + ' \\; set-option -t =yaac:=claude-aaaa remain-on-exit on',
    )
    expect(buildWindowsExec([{ ...claude, cwd: `${PATHS.workspaceDir}/web` }], PATHS))
      .toContain(`-n claude-aaaa -c ${PATHS.workspaceDir}/web 'claude`)
  })

  it('opens nothing for no sessions, still running what it is told to run first', () => {
    expect(buildWindowsExec([], PATHS)).toBe('')
    expect(buildWindowsExec([], PATHS, ["source-file '/l/hooks.conf'"])).toBe(`${TMUX} source-file '/l/hooks.conf'`)
  })

  it('starts every session in one tmux command, each naming what it resumes', () => {
    // One command, so no pane listing sees a window before it names what it
    // resumes (codex reports that only at its next turn).
    const cmd = buildWindowsExec([
      { tool: 'codex', mode: 'tui', window: 'codex-bbbb', cwd: PATHS.workspaceDir, cmd: 'codex resume t-1', resumes: 't-1' },
      { tool: 'opencode', mode: 'tui', window: 'opencode-cccc', cwd: PATHS.workspaceDir, cmd: 'opencode --standalone --session ses_2', resumes: 'ses_2' },
    ], PATHS)
    expect(cmd).toBe(
      `${TMUX} new-window -d -t =yaac: -n codex-bbbb -c ${PATHS.workspaceDir} 'codex resume t-1'`
      + ' \\; set-option -t =yaac:=codex-bbbb remain-on-exit on'
      + " \\; set-option -p -t =yaac:=codex-bbbb @yaac-session 'codex|t-1|'"
      + ` \\; new-window -d -t =yaac: -n opencode-cccc -c ${PATHS.workspaceDir} 'opencode --standalone --session ses_2'`
      + ' \\; set-option -t =yaac:=opencode-cccc remain-on-exit on'
      + " \\; set-option -p -t =yaac:=opencode-cccc @yaac-session 'opencode|ses_2|'",
    )
  })

  /*
   * Against a real tmux and the shipped writer: an `acp` session's window
   * (acpd's diagnostics) is logged into the life's dir from the start and
   * across a resume's respawn, and a `tui` one's is not.
   */
  it.skipIf(!['/usr/bin/tmux', '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux'].some((p) => existsSync(p)))(
    'logs an acp session\'s window across a respawn, and not a tui one\'s',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-windows-'))
      const paths = { ...PATHS, tmuxSock: path.join(dir, 'tmux.sock'), workspaceDir: dir }
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${workspaceBinDir()}:${process.env.PATH ?? ''}` }
      delete env.TMUX
      delete env.TMUX_PANE
      const sh = (cmd: string): Promise<unknown> => run('sh', ['-c', cmd], { env })
      const log = (name: string): Promise<string> =>
        fs.readFile(path.join(dir, `${name}.log`), 'utf8').then((t) => t.replace(/\r/g, ''), () => '')
      const until = async (name: string, text: string): Promise<string> => {
        for (const deadline = Date.now() + 5000; !(await log(name)).includes(text) && Date.now() < deadline;) {
          await new Promise((r) => setTimeout(r, 50))
        }
        return log(name)
      }
      const acp = { tool: 'claude' as const, mode: 'acp' as const, window: 'claude-acp1', cwd: dir, cmd: 'echo first; sleep 0.2' }
      try {
        await sh(`tmux -S ${paths.tmuxSock} -f /dev/null new-session -d -s yaac -n keeper`)
        // What runs first takes effect before the windows open: the log
        // dir it sets is where the acp window is piped.
        await sh(buildWindowsExec(
          [acp, { tool: 'claude', mode: 'tui', window: 'claude-tui1', cwd: dir, cmd: 'echo tui' }], paths,
          [`set-option -g @yaac-log-dir ${dir}`],
        ))
        expect(await until('claude-acp1', 'first')).toBe('first\n')
        await sh(buildRespawnExec({ ...acp, cmd: 'echo second; sleep 0.2' }, paths))
        expect(await until('claude-acp1', 'second')).toBe('first\nsecond\n')
        expect(existsSync(path.join(dir, 'claude-tui1.log'))).toBe(false)
      } finally {
        await sh(`tmux -S ${paths.tmuxSock} kill-server`).catch(() => {})
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
      }
    },
  )
})

describe('finishSetupCommand', () => {
  // The reaper reads a keeper still named for its start as a create that
  // died partway (`probeSetupState`), so setup ends by renaming it, and a
  // workspace with no keeper (one started before keepers) is not an error.
  it('renames the keeper, tolerating a workspace without one', () => {
    expect(finishSetupCommand(PATHS)).toBe(`${TMUX} rename-window -t =yaac:=${KEEPER_STARTING} ${KEEPER_WINDOW} 2>/dev/null || true`)
  })
})

// Pod-side setup is the yaac-workspace-init script (the postStart hook).
// Pin what the server relies on so the two cannot drift apart.
describe('yaac-workspace-init script', () => {
  const scriptPath = path.join(workspaceBinDir(), 'yaac-workspace-init')

  it('ships in workspace-bin and is executable', async () => {
    const st = await fs.stat(scriptPath)
    expect(st.isFile()).toBe(true)
    expect(st.mode & 0o111).not.toBe(0)
  })

  it('drives tmux over the same pod-local socket the k8s driver answers with', async () => {
    // The script hard-codes the socket path.
    const body = await fs.readFile(scriptPath, 'utf8')
    expect(body).toContain(`tmux -S ${PATHS.tmuxSock}`)
  })

  it('starts tmux with no session and reads no workspace\'s settings: the claim does both', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    expect(body).toContain('set-option -s exit-empty off')
    expect(body).not.toContain('new-session')
    expect(body).not.toMatch(/YAAC_(GIT|STATUS|CWD|CHECKOUTS|NPM)/)
    expect(body).not.toMatch(/^\s*git /m)
    // The claim opens the session on the keeper, named for its start.
    const claim = await fs.readFile(path.join(DAEMONS_DIR, 'streamd', 'claim.go'), 'utf8')
    expect(claim).toMatch(new RegExp(`keeperStarting\\s+=\\s+"${KEEPER_STARTING}"`))
    expect(claim).toContain('"new-session", "-d", "-s", "yaac", "-n", keeperStarting')
  })

  it('starts streamd last, from the path the self-heal exec also uses', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    const streamdAt = body.indexOf('setsid /opt/yaac/helpers/daemons/streamd ')
    expect(streamdAt).toBeGreaterThan(-1)
    // streamd starts last: its reachability signals that setup is done.
    expect(body.indexOf('start-server')).toBeLessThan(streamdAt)
  })
})
