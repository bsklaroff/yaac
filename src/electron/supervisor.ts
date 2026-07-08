import type { DaemonLock } from '@/shared/lock'

/**
 * What the desktop supervisor must do to end up with a usable daemon.
 * Mirrors the branching in `startDaemon` (src/daemon/cli.ts) but as a
 * pure decision so the supervisor's core is unit-testable without ever
 * spawning a process.
 */
export type DaemonAction = 'reuse' | 'restart' | 'start'

/**
 *  - no lock / dead lock          → 'start'
 *  - live lock, buildId mismatch  → 'restart' (daemon is an old build)
 *  - live lock, buildId matches   → 'reuse'
 */
export function decideDaemonAction(
  lock: DaemonLock | null,
  isLive: boolean,
  cliBuildId: string,
): DaemonAction {
  if (!lock || !isLive) return 'start'
  if (lock.buildId !== cliBuildId) return 'restart'
  return 'reuse'
}

/**
 * Everything `resolveDaemonStartCommand` needs to decide how to launch the
 * daemon, gathered by `main.ts` from the Electron/runtime context. Kept as
 * plain data so the resolver stays pure and testable.
 */
export interface DaemonStartContext {
  /** `YAAC_ELECTRON_DAEMON_CMD` — JSON argv override for the base launcher. */
  override?: string
  /** True in the packaged app (`app.isPackaged`). */
  bundled: boolean
  /** `process.execPath` (the Electron binary inside the app). */
  execPath: string
  /** Absolute path to the bundled CLI entry (`dist/cli.js`). */
  bundledCliEntry: string
  /** Dev only: absolute path to `node_modules/tsx/dist/cli.mjs`, or null. */
  tsxCli: string | null
  /** Dev only: absolute path to `src/cli.ts`. */
  devCliEntry: string
  /** Dev only: Node binary used to run tsx (`node` unless overridden). */
  nodeBin: string
}

export interface ResolvedCommand {
  bin: string
  args: string[]
  /** Env layered on top of the inherited process env for the child. */
  extraEnv: Record<string, string>
}

/**
 * Resolve the argv the desktop app runs to bring the daemon up. It always
 * ends in `daemon <mode>`; the leading part depends on how we're running:
 *
 *  - an explicit JSON-argv override (test/dev hook) wins outright;
 *  - packaged → the bundled CLI via Electron-as-Node (Phase 0 stopgap);
 *  - dev → the source CLI on plain Node via tsx.
 */
export function resolveDaemonStartCommand(
  mode: 'start' | 'restart',
  ctx: DaemonStartContext,
): ResolvedCommand {
  const sub = ['daemon', mode]

  const overrideArgv = parseJsonArgv(ctx.override)
  if (overrideArgv) {
    return { bin: overrideArgv[0], args: [...overrideArgv.slice(1), ...sub], extraEnv: {} }
  }

  if (ctx.bundled) {
    // Phase 0 stopgap: run the bundled CLI through Electron's own Node
    // (`ELECTRON_RUN_AS_NODE`). Phase 3 swaps `execPath` for a bundled
    // standalone Node so the daemon's native node-pty stays on the
    // standard ABI — see plans/electron-app.md ("Packaging & runtime").
    return {
      bin: ctx.execPath,
      args: [ctx.bundledCliEntry, ...sub],
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }

  if (!ctx.tsxCli) {
    throw new Error(
      'cannot launch the dev daemon: tsx not found. Run `pnpm install`, '
      + 'or start it yourself with `pnpm dev daemon start`.',
    )
  }
  // Dev: run the source CLI on plain Node via tsx — the same runtime as
  // `pnpm dev`, so node-pty's prebuilt (standard Node ABI) loads cleanly.
  return { bin: ctx.nodeBin, args: [ctx.tsxCli, ctx.devCliEntry, ...sub], extraEnv: {} }
}

/** Parse a JSON argv-array override; malformed / empty → null (fall back). */
function parseJsonArgv(raw: string | undefined): string[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((p) => typeof p === 'string')) {
      return parsed
    }
  } catch {
    // malformed override → fall back to the built-in resolution
  }
  return null
}

/**
 * I/O the supervisor needs, injected so the orchestration is testable with
 * fakes (a unit test must never actually spawn a daemon or touch the
 * cluster). `main.ts` wires these to the real `@/shared/lock` helpers and a
 * `spawn`-backed `runDaemonStart`.
 */
export interface EnsureDaemonDeps {
  readBuildId: () => Promise<string>
  readLock: () => Promise<DaemonLock | null>
  isLockLive: (lock: DaemonLock) => Promise<boolean>
  runDaemonStart: (mode: 'start' | 'restart') => Promise<void>
  waitForLiveLock: (timeoutMs: number) => Promise<DaemonLock>
  log?: (msg: string) => void
}

/**
 * Ensure a usable daemon is running and return its lock. Reuses a live,
 * matching daemon; otherwise starts (or restarts) one and waits for the
 * fresh lock to appear.
 */
export async function ensureDaemonRunning(deps: EnsureDaemonDeps): Promise<DaemonLock> {
  const buildId = await deps.readBuildId()
  const lock = await deps.readLock()
  const live = lock ? await deps.isLockLive(lock) : false
  const action = decideDaemonAction(lock, live, buildId)
  deps.log?.(`[electron] daemon action: ${action}`)
  if (action === 'reuse') return lock as DaemonLock
  await deps.runDaemonStart(action)
  const fresh = await deps.waitForLiveLock(5000)
  deps.log?.(`[electron] daemon ready pid=${fresh.pid} port=${fresh.port}`)
  return fresh
}
