import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  buildCloneLinkExec,
  buildOriginRefreshExec,
  buildWindowsExec,
  validateInitWindows,
} from '#runtime/agents/setup-commands'
import { cloneRepo, createCheckout, fetchOrigin } from '#domain/git'
import { execFileAsync } from '#lib/shell'
import { git } from '@yaac/test-utils/git'
import { WORKSPACE_INIT_SCRIPT, workspaceBinDir } from '#domain/workspaces/workspace-bin'
import { PROXY_CA_BUNDLE_PATH } from '#drivers/k8s/egress/proxy-client'
import { AGENT_TOOLS } from '@yaac/shared/types'

import { workspacePathsFixture } from '@yaac/test-utils/fake-driver'

// The container paths these commands are written against.
const PATHS = workspacePathsFixture()
const TMUX = `tmux -S ${PATHS.tmuxSock}`

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
      const cmd = buildCloneLinkExec(path.join(main, '.git'), workspacePathsFixture({ workspaceDir: wt }))
      await run(cmd)
      expect(await fs.readFile(path.join(wt, '.git', 'objects', 'info', 'alternates'), 'utf8'))
        .toBe(`${path.join(main, '.git', 'objects')}\n`)
      expect((await git(wt, ['status', '--porcelain'])).trim()).toBe('')
      // It ends by warming the file cache with a detached status that takes
      // no index lock the agent's git could collide with.
      expect(cmd).toMatch(/&& \{ setsid git -C \S+ --no-optional-locks status --porcelain <\/dev\/null >\/dev\/null 2>&1 & \}$/)
    })

    it('fails when the alternates line cannot be written, warm-up or not', async () => {
      const cmd = buildCloneLinkExec(path.join(main, '.git'), workspacePathsFixture({ workspaceDir: path.join(tmp, 'missing') }))
      await expect(run(cmd)).rejects.toThrow()
    })
  })

  describe('buildOriginRefreshExec', () => {
    it('fast-forwards origin/* from the main clone and moves nothing back', async () => {
      const cmd = buildOriginRefreshExec(path.join(main, '.git'), workspacePathsFixture({ workspaceDir: wt }))
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

describe('validateInitWindows', () => {
  it('resolves the configured windows', () => {
    const wins = validateInitWindows({ initCommands: ['pnpm install'] })
    expect(wins).toHaveLength(1)
    expect(wins[0].name).toBe('init')
  })

  it('returns [] for a config without init commands', () => {
    expect(validateInitWindows({})).toEqual([])
  })

  it.each(AGENT_TOOLS)('rejects a window named after the %s tool', (tool) => {
    expect(() => validateInitWindows({
      initCommands: [{ name: tool, commands: ['true'] }],
    })).toThrow(/collides with an agent tool window/)
  })
})

describe('buildWindowsExec', () => {
  it('with no init windows, only respawns the agent into the keepalive window', () => {
    const cmd = buildWindowsExec([], 'claude', [{ tool: 'claude', cmd: 'claude --session-id x' }], PATHS)
    expect(cmd).toBe(`${TMUX} respawn-window -k -t yaac:claude 'claude --session-id x'`)
  })

  it('chains each init window before the agent respawn', () => {
    const wins = validateInitWindows({ initCommands: ['pnpm install', 'pnpm dev'] })
    const cmd = buildWindowsExec(wins, 'codex', [{ tool: 'codex', cmd: 'codex --yolo' }], PATHS)
    const [initPart, respawnPart] = cmd.split(' && tmux -S ')
    expect(initPart).toContain('new-window -d -t yaac -n init')
    expect(initPart).toContain('pnpm install && pnpm dev')
    expect(`tmux -S ${respawnPart}`).toBe(
      `${TMUX} respawn-window -k -t yaac:codex 'codex --yolo'`,
    )
  })

  it('opens every agent past the first in its own window, in the workspace', () => {
    const cmd = buildWindowsExec([], 'claude', [
      { tool: 'claude', cmd: 'claude --resume a' },
      { tool: 'codex', cmd: 'codex --yolo' },
    ], PATHS)
    expect(cmd).toBe(
      `${TMUX} respawn-window -k -t yaac:claude 'claude --resume a'`
      + ` \\; new-window -d -t yaac -n codex-2 -c ${PATHS.workspaceDir} 'codex --yolo'`,
    )
  })

  it('starts every agent in one tmux command, each naming what it resumes', () => {
    // One command, so no pane listing sees a window before it names what it
    // resumes (codex reports that only at its next turn).
    const cmd = buildWindowsExec([], 'codex', [
      { tool: 'codex', cmd: 'codex resume t-1', resumes: 't-1' },
      { tool: 'opencode', cmd: 'opencode --standalone --session ses_2', resumes: 'ses_2' },
    ], PATHS)
    expect(cmd).toBe(
      `${TMUX} respawn-window -k -t yaac:codex 'codex resume t-1'`
      + " \\; set-option -p -t yaac:codex @yaac-session 'codex|t-1|'"
      + ` \\; new-window -d -t yaac -n opencode-2 -c ${PATHS.workspaceDir} 'opencode --standalone --session ses_2'`
      + " \\; set-option -p -t yaac:opencode-2 @yaac-session 'opencode|ses_2|'",
    )
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

  it('consumes exactly the env session-create injects', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    for (const name of [
      'YAAC_TOOL', 'YAAC_GIT_NAME', 'YAAC_GIT_EMAIL', 'YAAC_STATUS_RIGHT',
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
