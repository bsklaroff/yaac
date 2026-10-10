import { useCallback, useEffect, useState, type JSX } from 'react'
import type {
  DesktopInstallState, DesktopLocalScope, DesktopLocalState, DesktopServerOutcome, DesktopSetupRun, DesktopSetupStepState,
} from '@yaac/shared/types'
import type { LocalServerBridge } from '#lib/desktopServer'

const NAME: Record<DesktopLocalScope, string> = {
  server: 'Containerless server',
  cluster: 'Kubernetes cluster (kind)',
}

const ABOUT: Record<DesktopLocalScope, string> = {
  server: 'Agents run as you, each in its own checkout. Nothing is sandboxed: the credentials in a workspace are '
    + 'your real ones, and the permission mode defaults to accept-edits. Quick to set up. Install the agent CLIs '
    + 'you want to use yourself; yaac host check names them.',
  cluster: 'Each workspace is a gVisor-sandboxed pod behind an egress proxy that holds the real credentials. It '
    + 'needs a podman VM, several GB of disk and memory, and some minutes to install. Macs with Apple silicon only.',
}

const STATE_TEXT: Record<DesktopInstallState, string> = {
  missing: 'Not set up',
  stopped: 'Stopped',
  running: 'Running',
  outdated: 'Running an older build',
  elsewhere: 'Runs on its cluster',
  unavailable: 'Status unavailable',
}

const BUSY_TEXT = { setup: 'Setting up…', start: 'Starting…', stop: 'Stopping…', restart: 'Restarting…' }

const GLYPH: Record<DesktopSetupStepState, string> = {
  pending: '○', running: '…', done: '✓', skipped: '–', failed: '✗', cancelled: '✗',
}

const RUN_TITLE: Record<DesktopSetupRun['phase'], string> = {
  running: 'Setting up…', succeeded: 'Set up', failed: 'Setup failed', cancelled: 'Setup cancelled',
}

const button = 'rounded-md bg-surface-3 px-2.5 py-0.5 text-[11px] font-medium text-text transition '
  + 'hover:bg-border-strong disabled:opacity-50'

/**
 * This Mac's two installs, the host server and a kind cluster's, as the
 * desktop shell reads them. Starts and stops them, and sets up a missing
 * one: the shell runs its own fixed commands in the background while this
 * section polls for progress, then lands the window on the new server.
 */
export function ThisMacSettings({ bridge }: { bridge: LocalServerBridge }): JSX.Element {
  const [local, setLocal] = useState<DesktopLocalState | null>(null)
  const [open, setOpen] = useState<DesktopLocalScope | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setLocal(await bridge.localState())
    } catch (err) {
      console.error(err)
    }
  }, [bridge])

  useEffect(() => { void refresh() }, [refresh])
  // The shell owns the run; follow it while anything is under way.
  const busy = local?.busy ?? null
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void refresh(), 1000)
    return () => clearInterval(timer)
  }, [busy, refresh])

  const act = async (call: () => Promise<DesktopServerOutcome>): Promise<void> => {
    setError(null)
    const pending = call()
    // A start or a setup is under way now; show it while the call runs.
    setTimeout(() => void refresh(), 100)
    try {
      const outcome = await pending
      if (!outcome.ok) setError(outcome.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    await refresh()
  }

  if (!local) return <div className="mt-6 text-xs font-medium text-text">This Mac</div>

  const scopes = (['server', 'cluster'] as const).filter((s) => local.installs[s] !== null)
  const run = local.setup
  // A finished run shows only while its install is still missing.
  const showRun = run !== null && (run.phase === 'running' || local.installs[run.scope] === 'missing')

  return (
    <div className="mt-6">
      <div className="text-xs font-medium text-text">This Mac</div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Servers that run on this machine. They keep running when the app quits.
      </p>
      <div className="mt-2 space-y-1.5 text-xs">
        {scopes.map((scope) => {
          const state = local.installs[scope]!
          const choice = local.choices[scope]
          return (
            <div key={scope} className="rounded-md bg-bg px-2.5 py-1.5">
              <div className="flex items-center justify-between">
                <span className="text-text-dim">{NAME[scope]}</span>
                <div className="ml-2 flex shrink-0 items-center gap-1.5">
                  <span className="text-[11px] text-text-faint">
                    {busy?.scope === scope ? BUSY_TEXT[busy.action] : STATE_TEXT[state]}
                  </span>
                  {state === 'stopped' && (
                    <button className={button} disabled={busy !== null} onClick={() => void act(() => bridge.startLocal(scope))}>
                      Start
                    </button>
                  )}
                  {(state === 'running' || state === 'outdated') && (
                    <button className={button} disabled={busy !== null} onClick={() => void act(() => bridge.stopLocal(scope))}>
                      Stop
                    </button>
                  )}
                  {state === 'missing' && choice.blocked !== 'unsupported' && (
                    <button className={button} onClick={() => setOpen(open === scope ? null : scope)}>
                      Set up…
                    </button>
                  )}
                </div>
              </div>
              {state === 'missing' && choice.blocked === 'unsupported' && (
                <p className="mt-1 text-[11px] text-text-faint">This Mac cannot run it: it needs macOS on Apple silicon.</p>
              )}
              {open === scope && state === 'missing' && (
                <div className="mt-2 border-t border-border pt-2">
                  <p className="text-[11px] leading-relaxed text-text-faint">{ABOUT[scope]}</p>
                  <pre className="mt-2 select-text whitespace-pre-wrap break-all rounded-md bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-text-dim">
                    {choice.commands.join('\n')}
                  </pre>
                  <div className="mt-2 flex gap-1.5">
                    <button className={button} onClick={() => void navigator.clipboard?.writeText(choice.commands.join('\n'))}>
                      Copy commands
                    </button>
                    <button
                      className={button}
                      disabled={busy !== null || choice.blocked !== null}
                      onClick={() => void act(() => bridge.setupLocal(scope))}
                    >
                      Run them for me
                    </button>
                  </div>
                  {choice.blocked === 'no-brew' && (
                    <p className="mt-1.5 text-[11px] text-red-400">
                      Homebrew is not installed. Install it from{' '}
                      <a href="https://brew.sh" target="_blank" rel="noreferrer" className="underline">brew.sh</a>, then come back.
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {showRun && <SetupProgress run={run} onCancel={() => void act(() => bridge.cancelSetup())} />}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}

function SetupProgress({ run, onCancel }: { run: DesktopSetupRun, onCancel: () => void }): JSX.Element {
  return (
    <div className="mt-2 rounded-md bg-bg px-2.5 py-2 text-xs" aria-label="Setup progress">
      <div className="flex items-center justify-between">
        <span className="font-medium text-text">{NAME[run.scope]}: {RUN_TITLE[run.phase]}</span>
        {run.phase === 'running' && <button className={button} onClick={onCancel}>Cancel</button>}
      </div>
      <ol className="mt-1.5 space-y-0.5 text-[11px]">
        {run.steps.map((step) => (
          <li
            key={step.command}
            className={step.state === 'failed' || step.state === 'cancelled'
              ? 'text-red-400'
              : step.state === 'done' || step.state === 'running' ? 'text-text-dim' : 'text-text-faint'}
          >
            {GLYPH[step.state]} {step.label}{step.note ? ` (${step.note})` : ''}
          </li>
        ))}
      </ol>
      {run.log.length > 0 && (
        <pre className="mt-2 max-h-48 select-text overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-2 px-2 py-1.5 font-mono text-[10.5px] text-text-faint">
          {run.log.slice(-40).join('\n')}
        </pre>
      )}
      {(run.error ?? run.hostCheckFailures) && (
        <p className="mt-1.5 whitespace-pre-wrap text-[11px] text-red-400">
          {[run.error, run.hostCheckFailures].filter(Boolean).join('\n')}
        </p>
      )}
    </div>
  )
}
