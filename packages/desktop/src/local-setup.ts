/**
 * Setting up one of this Mac's installs from nothing: the Homebrew formulas
 * and taps (homebrew/README.md), then the `yaac` command that creates the
 * install. The same commands are shown for a user to copy, and run here in
 * the background on request.
 *
 * A renderer names a setup by its scope alone. The commands come from this
 * module's fixed table, so web content can never choose what runs. Each
 * step first checks whether its effect is already in place (a formula
 * installed, a tap trusted, an install recorded) and skips itself if so.
 * Homebrew itself is never installed here: a setup that needs it and finds
 * none fails, pointing at https://brew.sh.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  DesktopLocalState, DesktopSetupChoice, DesktopSetupRun, DesktopSetupStep,
} from '@yaac/shared/types'
import {
  ACTION_TIMEOUT_MS, failedChecks, installState, READ_TIMEOUT_MS,
  type ActionOutcome, type LocalServers, type ScopedAction, type ServerScope,
} from '#server-control'

const MINUTE = 60_000
/** `brew install` may build from source (yaac-cluster's krunkit and libkrun). */
const BREW_INSTALL_TIMEOUT_MS = 90 * MINUTE
/** `yaac cluster install` creates a podman VM and a kind cluster and builds every image. */
const CLUSTER_INSTALL_TIMEOUT_MS = 90 * MINUTE
const BREW_TAP_TIMEOUT_MS = 5 * MINUTE
/** A probe: `brew list`, `brew tap`, `brew trust --json`, `yaac cluster status`. */
const PROBE_TIMEOUT_MS = MINUTE
/** How long a cancelled or timed-out command has to exit before it is killed. */
const KILL_GRACE_MS = 5000
/** Lines of command output a run keeps. */
const LOG_LINES = 200

/** Answers to "is this already done?", each asked at most once between steps. */
interface Probes {
  onPath(name: string): Promise<boolean>
  formula(name: string): Promise<boolean>
  trusted(tap: string): Promise<boolean>
  tapped(tap: string): Promise<boolean>
  clusterInstalled(): Promise<boolean>
}

interface StepDef {
  label: string
  argv: readonly string[]
  timeoutMs: number
  /** Why the step can be skipped, or null to run it. */
  skip?(probes: Probes, scope: ServerScope): Promise<string | null>
  /** A failing exit is reported, not fatal: `yaac host check`. */
  advisory?: boolean
}

const needsServerFormula = async (p: Probes): Promise<boolean> => !await p.onPath('yaac') && !await p.formula('yaac-server')
const needsClusterFormula = async (p: Probes, scope: ServerScope): Promise<boolean> =>
  scope === 'cluster' && !await p.formula('yaac-cluster')

const STEPS = {
  trustYaac: {
    label: 'Trust the yaac tap',
    argv: ['brew', 'trust', 'bsklaroff/yaac'],
    timeoutMs: BREW_TAP_TIMEOUT_MS,
    skip: async (p, scope) => {
      if (!await needsServerFormula(p) && !await needsClusterFormula(p, scope)) return 'nothing to install from it'
      return await p.trusted('bsklaroff/yaac') ? 'already trusted' : null
    },
  },
  installServer: {
    label: 'Install the yaac CLI',
    argv: ['brew', 'install', 'bsklaroff/yaac/yaac-server'],
    timeoutMs: BREW_INSTALL_TIMEOUT_MS,
    skip: async (p) => await needsServerFormula(p) ? null : 'already installed',
  },
  startServer: {
    label: 'Start the server',
    argv: ['yaac', 'server', 'start'],
    timeoutMs: ACTION_TIMEOUT_MS,
  },
  hostCheck: {
    label: 'Check this Mac',
    argv: ['yaac', 'host', 'check'],
    timeoutMs: READ_TIMEOUT_MS,
    advisory: true,
  },
  trustKrun: {
    label: 'Trust the libkrun tap',
    argv: ['brew', 'trust', 'libkrun/krun'],
    timeoutMs: BREW_TAP_TIMEOUT_MS,
    skip: async (p, scope) => {
      if (!await needsClusterFormula(p, scope)) return 'nothing to install from it'
      return await p.trusted('libkrun/krun') ? 'already trusted' : null
    },
  },
  tapKrun: {
    label: 'Add the libkrun tap',
    argv: ['brew', 'tap', 'libkrun/krun'],
    timeoutMs: BREW_TAP_TIMEOUT_MS,
    skip: async (p, scope) => {
      if (!await needsClusterFormula(p, scope)) return 'nothing to install from it'
      return await p.tapped('libkrun/krun') ? 'already added' : null
    },
  },
  installCluster: {
    label: 'Install the cluster tools',
    argv: ['brew', 'install', 'bsklaroff/yaac/yaac-cluster'],
    timeoutMs: BREW_INSTALL_TIMEOUT_MS,
    skip: async (p, scope) => await needsClusterFormula(p, scope) ? null : 'already installed',
  },
  clusterInstall: {
    label: 'Install the cluster',
    argv: ['yaac', 'cluster', 'install'],
    timeoutMs: CLUSTER_INSTALL_TIMEOUT_MS,
    skip: async (p) => await p.clusterInstalled() ? 'this Mac already has one' : null,
  },
} satisfies Record<string, StepDef>

type StepId = keyof typeof STEPS

/**
 * Each setup's steps. Both end selecting the new server: `yaac server
 * start` always selects, and a first `yaac cluster install` does.
 */
const PLANS: Record<ServerScope, StepId[]> = {
  server: ['trustYaac', 'installServer', 'startServer', 'hostCheck'],
  cluster: ['trustYaac', 'installServer', 'trustKrun', 'tapKrun', 'installCluster', 'clusterInstall'],
}

/** What a user would type for the same setup. */
function setupCommands(scope: ServerScope): string[] {
  return PLANS[scope].map((id) => STEPS[id].argv.join(' '))
}

/** Whether `name` is an executable on PATH (the adopted login-shell one). */
export async function onPath(name: string): Promise<boolean> {
  // eslint-disable-next-line no-process-env -- the PATH every command here is spawned with
  for (const dir of (process.env.PATH ?? '').split(':').filter((d) => d !== '')) {
    try {
      await fs.access(path.join(dir, name), fs.constants.X_OK)
      return true
    } catch { /* not in this dir */ }
  }
  return false
}

interface Exit {
  ok: boolean
  /** stdout and stderr together, as printed. */
  out: string
  /** Why the command failed: its exit code, a timeout or a cancel. */
  failure?: string
}

/** A command that could not be spawned. */
class MissingCommand extends Error {}

/** Colors and cursor moves, which brew and the CLI print even into a pipe. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

/**
 * Run `argv` in its own process group, so a cancel or timeout reaches the
 * children it spawns (brew's downloads, the cluster install's podman).
 * Output goes to `onLine` a line at a time; a carriage return ends a line
 * too, so progress bars do not pile up into one.
 */
function exec(
  argv: readonly string[],
  opts: { timeoutMs: number, signal: AbortSignal, onLine?: (line: string) => void },
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let partial = ''
    let failure: string | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const signalGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch { /* already gone */ }
    }
    const stop = (why: string): void => {
      if (failure) return
      failure = why
      signalGroup('SIGTERM')
      killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS)
    }
    const onAbort = (): void => stop('cancelled')
    const timer = setTimeout(() => stop(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`), opts.timeoutMs)
    opts.signal.addEventListener('abort', onAbort)
    if (opts.signal.aborted) onAbort()
    const take = (chunk: Buffer): void => {
      const text = chunk.toString('utf8').replace(ANSI, '')
      out = (out + text).slice(-64 * 1024)
      if (!opts.onLine) return
      const lines = (partial + text).split(/\r\n|\r|\n/)
      partial = lines.pop() ?? ''
      for (const l of lines) if (l.trim() !== '') opts.onLine(l)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const done = (): void => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      opts.signal.removeEventListener('abort', onAbort)
    }
    child.once('error', (err: NodeJS.ErrnoException) => {
      done()
      reject(err.code === 'ENOENT' ? new MissingCommand(argv[0]) : err)
    })
    child.once('close', (code) => {
      done()
      if (partial.trim() !== '') opts.onLine?.(partial)
      resolve({ ok: code === 0 && !failure, out, failure: failure ?? (code === 0 ? undefined : `exited with code ${code}`) })
    })
  })
}

function createProbes(signal: AbortSignal): Probes & { forget(): void } {
  const memo = new Map<string, Promise<boolean>>()
  const once = (key: string, ask: () => Promise<boolean>): Promise<boolean> => {
    let answer = memo.get(key)
    if (!answer) {
      answer = ask()
      memo.set(key, answer)
    }
    return answer
  }
  const read = (...argv: string[]): Promise<Exit> => exec(argv, { timeoutMs: PROBE_TIMEOUT_MS, signal })
  return {
    onPath: (name) => once(`path:${name}`, () => onPath(name)),
    formula: (name) => once(`formula:${name}`, async () => {
      const r = await read('brew', 'list', '--formula', '--versions', name)
      return r.ok && r.out.trim() !== ''
    }),
    trusted: (tap) => once(`trusted:${tap}`, async () => {
      const r = await read('brew', 'trust', '--tap', '--json=v1')
      // A Homebrew from before tap trust loads any tap.
      if (!r.ok) return /unknown command/i.test(r.out)
      try {
        return (JSON.parse(r.out) as unknown[]).includes(tap)
      } catch {
        return false
      }
    }),
    tapped: (tap) => once(`tapped:${tap}`, async () => {
      const r = await read('brew', 'tap')
      return r.ok && r.out.split('\n').some((l) => l.trim() === tap)
    }),
    clusterInstalled: () => once('cluster', async () => {
      if (!await onPath('yaac')) return false
      const r = await exec(['yaac', 'cluster', 'status', '--json'], { timeoutMs: READ_TIMEOUT_MS, signal })
      try {
        return r.ok && (JSON.parse(r.out) as { driver?: unknown }).driver === 'k8s'
      } catch {
        return false
      }
    }),
    forget: () => memo.clear(),
  }
}

export interface SetupRunner {
  /** The run under way, or the last one to finish. */
  current(): DesktopSetupRun | null
  /** Run `scope`'s setup to its end. Never rejects. */
  run(scope: ServerScope): Promise<ActionOutcome>
  /** Stop the run under way, killing the command it is running. */
  cancel(): void
}

/** One setup at a time; `onChange` fires on every step and output line. */
export function createSetupRunner(onChange: () => void): SetupRunner {
  let current: DesktopSetupRun | null = null
  let abort: AbortController | null = null

  const run = async (scope: ServerScope): Promise<ActionOutcome> => {
    if (abort) return { ok: false, error: 'a setup is already running' }
    const controller = new AbortController()
    abort = controller
    const plan = PLANS[scope].map((id) => STEPS[id] as StepDef)
    const steps: DesktopSetupStep[] = plan.map((def) => ({ label: def.label, command: def.argv.join(' '), state: 'pending' }))
    const r: DesktopSetupRun = { scope, phase: 'running', steps, log: [] }
    current = r
    onChange()
    const log = (line: string): void => {
      r.log.push(line)
      if (r.log.length > LOG_LINES) r.log.splice(0, r.log.length - LOG_LINES)
      onChange()
    }
    const finish = (phase: DesktopSetupRun['phase'], error?: string): ActionOutcome => {
      r.phase = phase
      if (error) r.error = error
      abort = null
      onChange()
      return error ? { ok: false, error } : { ok: true, hostCheckFailures: r.hostCheckFailures }
    }
    const probes = createProbes(controller.signal)

    for (const [i, def] of plan.entries()) {
      const step = steps[i]
      step.state = 'running'
      onChange()
      try {
        const skip = await def.skip?.(probes, scope) ?? null
        if (controller.signal.aborted) break
        if (skip) {
          step.state = 'skipped'
          step.note = skip
          continue
        }
        log(`$ ${step.command}`)
        const exit = await exec(def.argv, { timeoutMs: def.timeoutMs, signal: controller.signal, onLine: log })
        probes.forget()
        if (controller.signal.aborted) break
        if (!exit.ok && def.advisory) {
          r.hostCheckFailures = failedChecks(exit.out)
        } else if (!exit.ok) {
          step.state = 'failed'
          step.note = exit.failure
          return finish('failed', `${step.command} ${step.note}`)
        }
        step.state = 'done'
      } catch (err) {
        step.state = 'failed'
        const error = err instanceof MissingCommand
          ? err.message === 'brew'
            ? 'Homebrew is not installed. Install it from https://brew.sh, then set up again.'
            : `${err.message} is not on PATH`
          : err instanceof Error ? err.message : String(err)
        step.note = error
        return finish('failed', error)
      }
    }
    if (controller.signal.aborted) {
      for (const step of steps) if (step.state === 'running') step.state = 'cancelled'
      return finish('cancelled', 'setup cancelled')
    }
    return finish('succeeded')
  }

  return {
    current: () => current,
    run,
    cancel: () => abort?.abort(),
  }
}

/** Whether this Mac can run a local kind cluster: the tap's krunkit is Apple silicon only. */
export const CLUSTER_SUPPORTED = process.platform === 'darwin' && process.arch === 'arm64'

/** This Mac's installs and setups, as the tray, the picker and the SPA show them. */
export function localView(input: {
  local: LocalServers
  busy: ScopedAction | null
  setup: DesktopSetupRun | null
  brew: boolean
  clusterSupported: boolean
}): DesktopLocalState {
  const { local, busy, setup, brew, clusterSupported } = input
  const cli = local.server?.kind !== 'no-cli'
  const choice = (scope: ServerScope): DesktopSetupChoice => ({
    scope,
    commands: setupCommands(scope),
    blocked: scope === 'cluster' && !clusterSupported
      ? 'unsupported'
      : !brew && (scope === 'cluster' || !cli) ? 'no-brew' : null,
  })
  return {
    cli,
    brew,
    installs: { server: installState(local, 'server'), cluster: installState(local, 'cluster') },
    busy,
    setup,
    choices: { server: choice('server'), cluster: choice('cluster') },
  }
}
