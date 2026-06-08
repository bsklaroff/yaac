import { useState, type JSX } from 'react'
import { postBootstrap } from '@/frontend/lib/bootstrap'

/**
 * First-open / expired-session screen. The daemon logs a one-time URL
 * (`yaac daemon logs`); the user can open it directly or paste just the
 * code here.
 */
export function BootstrapSplash({ onAuthed }: { onAuthed: () => void }): JSX.Element {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!code.trim()) return
    setBusy(true)
    setError(null)
    try {
      const ok = await postBootstrap(code.trim())
      if (ok) onAuthed()
      else setError('Invalid or expired code. Restart the daemon for a fresh one.')
    } catch {
      setError('Could not reach the daemon.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-neutral-950 text-neutral-200">
      <div className="w-full max-w-md px-8">
        <h1 className="text-2xl font-semibold tracking-tight">Connect to yaac</h1>
        <p className="mt-3 text-sm text-neutral-400">
          Open the URL from <code className="text-neutral-300">yaac daemon logs</code>, or paste the
          one-time bootstrap code below.
        </p>
        <form onSubmit={(e) => void submit(e)} className="mt-6 flex flex-col gap-3">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="bootstrap code"
            autoFocus
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm
              outline-none focus:border-neutral-500"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-neutral-200 px-3 py-2 text-sm font-medium text-neutral-900
              hover:bg-white disabled:opacity-50"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </form>
      </div>
    </div>
  )
}
