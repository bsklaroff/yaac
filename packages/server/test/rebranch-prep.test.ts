import { describe, it, expect, vi } from 'vitest'
import {
  buildRebranchPrep,
  initWindowCommand,
  withUpstreamConfigLock,
} from '#session-create'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'

const TMUX = `tmux -S ${CONTAINER_TMUX_SOCK}`

describe('initWindowCommand', () => {
  it('creates a visible window with remain-on-exit chained on', () => {
    const cmd = initWindowCommand({ name: 'init', cmd: 'pnpm install', hidePane: false })
    expect(cmd).toBe(
      `${TMUX} new-window -d -t yaac -n init 'cd /workspace && pnpm install'`
      + ' \\; set-option -t yaac:init remain-on-exit on',
    )
  })

  it('omits remain-on-exit for hidden panes', () => {
    const cmd = initWindowCommand({ name: 'deps', cmd: 'pnpm install', hidePane: true })
    expect(cmd).toBe(`${TMUX} new-window -d -t yaac -n deps 'cd /workspace && pnpm install'`)
  })
})

describe('buildRebranchPrep', () => {
  it('resets by SHA and cleans without -x, excluding the default node_modules mount', () => {
    const prep = buildRebranchPrep({
      branch: 'dev', sha: 'abc123', config: {}, sessionId: 's1', respawnTool: null,
    })
    expect(prep.resetExec).toBe(
      'sh -c "git -C /workspace reset --hard abc123 && git -C /workspace clean -fd'
      + ' -e \'node_modules\'"',
    )
  })

  it('excludes every workspace mount point from the clean', () => {
    // Mount points are live directories in the pod — cleaning one fails
    // with EBUSY (and would empty its backing dir), so each is excluded.
    const prep = buildRebranchPrep({
      branch: 'dev',
      sha: 'abc123',
      config: {
        ephemeralModulesPaths: ['packages/web/node_modules'],
        cacheVolumes: { pip: '/workspace/.pip-cache', home: '/home/yaac/.cache/x' },
        bindMounts: [
          { hostPath: '/data', containerPath: '/workspace/data', mode: 'ro' },
          { hostPath: '/models', containerPath: '/mnt/models', mode: 'rw' },
        ],
      },
      sessionId: 's1',
      respawnTool: null,
    })
    expect(prep.resetExec).toContain(" -e 'packages/web/node_modules'")
    expect(prep.resetExec).toContain(" -e '.pip-cache'")
    expect(prep.resetExec).toContain(" -e 'data'")
    // Mounts outside /workspace are unreachable by the clean — not excluded.
    expect(prep.resetExec).not.toContain('models')
    expect(prep.resetExec).not.toContain('.cache/x')
  })

  it('rewrites the upstream to the new branch, shell-escaped', () => {
    const prep = buildRebranchPrep({
      branch: 'release/2.x', sha: 'abc123', config: {}, sessionId: 's1', respawnTool: null,
    })
    expect(prep.upstreamExec).toBe(
      "git -C /workspace branch --set-upstream-to 'origin/release/2.x'",
    )
  })

  it('kills and re-creates every init window in order', () => {
    const prep = buildRebranchPrep({
      branch: 'dev',
      sha: 'abc123',
      config: { initCommands: [{ name: 'api', commands: ['pnpm dev'] }, { name: 'web', commands: ['pnpm web'], hidePane: true }] },
      sessionId: 's1',
      respawnTool: null,
    })
    expect(prep.windowExecs).toEqual([
      `sh -c "${TMUX} kill-window -t yaac:api 2>/dev/null || true"`,
      initWindowCommand({ name: 'api', cmd: 'pnpm dev', hidePane: false }),
      `sh -c "${TMUX} kill-window -t yaac:web 2>/dev/null || true"`,
      initWindowCommand({ name: 'web', cmd: 'pnpm web', hidePane: true }),
    ])
  })

  it('appends the agent respawn last when requested', () => {
    const prep = buildRebranchPrep({
      branch: 'dev', sha: 'abc123', config: {}, sessionId: 's1', respawnTool: 'claude',
    })
    expect(prep.windowExecs).toHaveLength(1)
    expect(prep.windowExecs[0]).toContain('respawn-window -k -t yaac:claude')
    expect(prep.windowExecs[0]).toContain('--session-id s1')
  })

  it('emits no window execs when there are no init commands and no respawn', () => {
    const prep = buildRebranchPrep({
      branch: 'dev', sha: 'abc123', config: {}, sessionId: 's1', respawnTool: null,
    })
    expect(prep.windowExecs).toEqual([])
  })
})

describe('withUpstreamConfigLock', () => {
  it('serializes tasks on one project', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((r) => { releaseFirst = r })

    const first = withUpstreamConfigLock('p', async () => {
      order.push('first-start')
      await gate
      order.push('first-end')
    })
    const second = withUpstreamConfigLock('p', () => {
      order.push('second')
      return Promise.resolve()
    })

    // Give the second task a chance to (incorrectly) run early.
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['first-start'])

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('runs different projects concurrently', async () => {
    const order: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => { releaseA = r })

    const a = withUpstreamConfigLock('a', async () => { await gateA; order.push('a') })
    const b = withUpstreamConfigLock('b', () => { order.push('b'); return Promise.resolve() })

    await b
    expect(order).toEqual(['b']) // b did not wait on a
    releaseA()
    await a
  })

  it('a failed predecessor does not poison the queue', async () => {
    const failing = withUpstreamConfigLock('p', () => Promise.reject(new Error('boom')))
    const task = vi.fn(() => Promise.resolve())
    const ok = withUpstreamConfigLock('p', task)

    await expect(failing).rejects.toThrow('boom')
    await expect(ok).resolves.toBeUndefined()
    expect(task).toHaveBeenCalledTimes(1)
  })
})
