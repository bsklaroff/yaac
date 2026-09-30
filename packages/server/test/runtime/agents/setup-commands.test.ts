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
import { WORKTREE_INIT_SCRIPT, worktreeBinDir } from '#domain/worktrees/worktree-bin'
import { PROXY_CA_BUNDLE_PATH } from '#drivers/k8s/egress/proxy-client'
import { AGENT_TOOLS } from '@yaac/shared/types'

import { workspacePathsFixture } from '@yaac/test-utils/fake-driver'

// The container paths these commands are written against.
const PATHS = workspacePathsFixture()
const TMUX = `tmux -S ${PATHS.tmuxSock}`

/**
 * A main clone and a checkout cloned from it, on this disk, with the
 * commands run for real — the checkout's path standing in for /workspace,
 * which on a host workspace is exactly what it is.
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
      await run(buildCloneLinkExec(path.join(main, '.git'), workspacePathsFixture({ workspaceDir: wt })))
      expect(await fs.readFile(path.join(wt, '.git', 'objects', 'info', 'alternates'), 'utf8'))
        .toBe(`${path.join(main, '.git', 'objects')}\n`)
      expect((await git(wt, ['status', '--porcelain'])).trim()).toBe('')
    })
  })

  describe('buildOriginRefreshExec', () => {
    it('fast-forwards origin/* from the main clone and moves nothing back', async () => {
      const cmd = buildOriginRefreshExec(path.join(main, '.git'), workspacePathsFixture({ workspaceDir: wt }))
      // Upstream: main moves on, a branch appears, `forced` is rewritten.
      await commit(source, 'upstream')
      await git(source, ['branch', 'fresh'])
      await git(source, ['branch', '-f', 'forced', 'main'])
      // The agent fetched `ahead` itself, past what the main clone has seen.
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
      // Everything it moved to was already reachable through the alternate.
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
    // codex reports a resumed conversation only at its next turn, and a pane
    // naming none reads as holding none — so no listing may land between.
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

// The pod-side half of session setup lives in the yaac-worktree-init script
// (the postStart hook). Pin the contracts the server relies on so a script
// edit can't silently drift from the TypeScript side.
describe('yaac-worktree-init script', () => {
  const scriptPath = path.join(worktreeBinDir(), WORKTREE_INIT_SCRIPT)

  it('ships in worktree-bin and is executable', async () => {
    const st = await fs.stat(scriptPath)
    expect(st.isFile()).toBe(true)
    expect(st.mode & 0o111).not.toBe(0)
  })

  it('drives tmux over the same pod-local socket the k8s driver answers with', async () => {
    // The script is baked into the image, so it cannot ask the driver — it
    // hard-codes the path, and this is what catches the two drifting apart.
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
    // The engine-start block hardcodes the bundle path (sudo strips env, so
    // the script can't read it from the pod) — pin it to the constant so a
    // moved bundle can't silently break nested registry TLS.
    const body = await fs.readFile(scriptPath, 'utf8')
    expect(body).toContain(`SSL_CERT_FILE=${PROXY_CA_BUNDLE_PATH}`)
  })

  it('never does git work from /workspace (the checkout races the hook)', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    // The hook cd's to / before any git command: /workspace holds a
    // half-provisioned worktree whose .git file still names the HOST admin
    // path, and git's cwd repository discovery treats that as fatal even
    // for `config --global`.
    expect(body.indexOf('\ncd /\n')).toBeGreaterThan(-1)
    expect(body.indexOf('\ncd /\n')).toBeLessThan(body.indexOf('git config --global'))
    // The tmux session pins its start directory back to the worktree so
    // the respawned agent and later windows run there.
    expect(body).toMatch(/new-session[^\n]* -c \/workspace/)
  })

  it('starts streamd last, from the path the self-heal exec also uses', async () => {
    const body = await fs.readFile(scriptPath, 'utf8')
    const streamdAt = body.indexOf('node /opt/yaac/streamd/main.js')
    expect(streamdAt).toBeGreaterThan(-1)
    // Everything the server relies on (git config, tmux) precedes streamd:
    // its reachability is the "setup done" signal.
    expect(body.indexOf('git config --global')).toBeLessThan(streamdAt)
    expect(body.indexOf('new-session')).toBeLessThan(streamdAt)
    expect(body.indexOf('podman system service')).toBeLessThan(streamdAt)
  })
})
