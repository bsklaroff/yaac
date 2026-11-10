import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, it, expect } from 'vitest'
import { buildRespawnExec, buildWindowsExec, finishSetupCommand } from '#runtime/agents/setup-commands'
import { KEEPER_STARTING, KEEPER_WINDOW } from '#drivers/contract'
import { WORKSPACE_INIT_SCRIPT, workspaceBinDir } from '#domain/workspaces/workspace-bin'
import { PROXY_CA_BUNDLE_PATH } from '#drivers/k8s/egress/proxy-client'

import { workspacePathsFixture } from '#test/support/fake-driver'

// The container paths these commands are written against.
const PATHS = workspacePathsFixture()
const TMUX = `tmux -S ${PATHS.tmuxSock}`
const run = promisify(execFile)

describe('buildWindowsExec', () => {
  const claude = { tool: 'claude' as const, mode: 'tui' as const, window: 'claude-aaaa', cmd: 'claude --session-id x' }

  // A session's window keeps its pane when the agent exits, for a resume.
  it('opens each session in a window of its own, in the workspace, keeping its pane on exit', () => {
    expect(buildWindowsExec([claude], PATHS)).toBe(
      `${TMUX} new-window -d -t yaac -n claude-aaaa -c ${PATHS.workspaceDir} 'claude --session-id x'`
      + ' \\; set-option -t =yaac:=claude-aaaa remain-on-exit on',
    )
  })

  it('opens nothing for no sessions', () => {
    expect(buildWindowsExec([], PATHS)).toBe('')
  })

  it('starts every session in one tmux command, each naming what it resumes', () => {
    // One command, so no pane listing sees a window before it names what it
    // resumes (codex reports that only at its next turn).
    const cmd = buildWindowsExec([
      { tool: 'codex', mode: 'tui', window: 'codex-bbbb', cmd: 'codex resume t-1', resumes: 't-1' },
      { tool: 'opencode', mode: 'tui', window: 'opencode-cccc', cmd: 'opencode --standalone --session ses_2', resumes: 'ses_2' },
    ], PATHS)
    expect(cmd).toBe(
      `${TMUX} new-window -d -t yaac -n codex-bbbb -c ${PATHS.workspaceDir} 'codex resume t-1'`
      + ' \\; set-option -t =yaac:=codex-bbbb remain-on-exit on'
      + " \\; set-option -p -t =yaac:=codex-bbbb @yaac-session 'codex|t-1|'"
      + ` \\; new-window -d -t yaac -n opencode-cccc -c ${PATHS.workspaceDir} 'opencode --standalone --session ses_2'`
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
      const acp = { tool: 'claude' as const, mode: 'acp' as const, window: 'claude-acp1', cmd: 'echo first; sleep 0.2' }
      try {
        await sh(`tmux -S ${paths.tmuxSock} -f /dev/null new-session -d -s yaac -n keeper`
          + ` \\; set-option -g @yaac-log-dir ${dir}`)
        await sh(buildWindowsExec([acp, { tool: 'claude', mode: 'tui', window: 'claude-tui1', cmd: 'echo tui' }], paths))
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
  const scriptPath = path.join(workspaceBinDir(), WORKSPACE_INIT_SCRIPT)

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

  it('opens the session on the keeper, named for its start', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    expect(body).toMatch(new RegExp(`new-session -d -s yaac -n ${KEEPER_STARTING} `))
  })

  it('consumes exactly the env session-create injects', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    for (const name of [
      'YAAC_GIT_NAME', 'YAAC_GIT_EMAIL', 'YAAC_STATUS_RIGHT',
      'YAAC_NESTED_ENGINE', 'YAAC_REGISTRY_CONF_B64',
    ]) {
      // Both plain `$NAME` and defaulted `${NAME:-}` expansions count.
      expect(body).toMatch(new RegExp(`\\$\\{?${name}`))
    }
  })

  it('points the nested engine at the combined CA bundle (PROXY_CA_BUNDLE_PATH)', async () => {
    // Hard-coded in the script because sudo strips the environment.
    const body = await fs.readFile(scriptPath, 'utf8')
    expect(body).toContain(`SSL_CERT_FILE=${PROXY_CA_BUNDLE_PATH}`)
  })

  it('never does git work from /workspace (the checkout races the hook)', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    // `cd /` before any git command: git fails on the half-set-up
    // /workspace repo, even for `config --global`.
    expect(body.indexOf('\ncd /\n')).toBeGreaterThan(-1)
    expect(body.indexOf('\ncd /\n')).toBeLessThan(body.indexOf('git config --global'))
    // Windows still start in /workspace.
    expect(body).toMatch(/new-session[^\n]* -c \/workspace/)
  })

  it('starts streamd last, from the path the self-heal exec also uses', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    const streamdAt = body.indexOf('node /opt/yaac/streamd/main.js')
    expect(streamdAt).toBeGreaterThan(-1)
    // streamd starts last: its reachability signals that setup is done.
    expect(body.indexOf('git config --global')).toBeLessThan(streamdAt)
    expect(body.indexOf('new-session')).toBeLessThan(streamdAt)
    expect(body.indexOf('podman system service')).toBeLessThan(streamdAt)
  })
})
