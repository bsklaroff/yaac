import { useEffect, useRef, useState, type JSX } from 'react'
import { getClusterCheck, streamClusterSetup, type CheckResult } from '@/frontend/lib/clusterApi'

/**
 * First-run gate. The daemon serves fine without a cluster, but sessions
 * can't run until one exists — so when `cluster check` isn't green the app
 * shows this instead of the workspace. "Set up" streams `cluster setup`
 * (the same logic as the CLI) and hands off to the app once it passes.
 */
export function ClusterSetup({ results, onReady }: {
  results: CheckResult[]
  onReady: () => void
}): JSX.Element {
  const [running, setRunning] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // Keep the streamed log pinned to the latest line.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const run = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    setLines([])
    try {
      const ok = await streamClusterSetup((line) => setLines((prev) => [...prev, line]))
      if (ok) { onReady(); return }
      // Setup ran but its finishing check didn't pass — confirm with a re-check.
      const recheck = await getClusterCheck()
      if (recheck.ok) onReady()
      else setError("Setup finished but the cluster still isn't ready — see the log above.")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const problems = results.filter((r) => r.status === 'fail' || r.status === 'warn')
  const showChecks = problems.length > 0 && !running && lines.length === 0

  return (
    <div className="flex h-full items-center justify-center bg-bg text-text">
      <div className="flex w-full max-w-2xl flex-col gap-5 px-8 py-10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Set up yaac</h1>
          <p className="mt-2 text-sm text-text-dim">
            yaac runs each session in a sandboxed container on a local Kubernetes
            cluster. It isn&apos;t ready yet — run setup to provision it.
          </p>
        </div>

        {showChecks && (
          <ul className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-3 text-sm">
            {problems.map((r) => (
              <li key={r.name}>
                <div><span className="text-red-400">✗</span> {r.name}: {r.detail}</div>
                {r.fix && (
                  <div className="mt-0.5 whitespace-pre-wrap pl-4 text-xs text-text-dim">{r.fix}</div>
                )}
              </li>
            ))}
          </ul>
        )}

        {(running || lines.length > 0) && (
          <div
            ref={logRef}
            className="h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border
              bg-surface-2 p-3 font-mono text-xs text-text-dim"
          >
            {lines.map((l, i) => <div key={i}>{l}</div>)}
            {running && <div className="text-text-faint">…</div>}
          </div>
        )}

        {error && <div className="whitespace-pre-wrap text-sm text-red-400">{error}</div>}

        <button
          onClick={() => void run()}
          disabled={running}
          className="self-start rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg
            transition hover:brightness-110 disabled:opacity-50"
        >
          {running ? 'Setting up…' : error ? 'Retry setup' : 'Set up'}
        </button>
      </div>
    </div>
  )
}
