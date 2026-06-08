import { useState, type FormEvent, type JSX } from 'react'
import { Form } from '@base-ui/react/form'
import { Field } from '@base-ui/react/field'
import { postBootstrap } from '@/frontend/lib/bootstrap'

/**
 * First-open / expired-session screen. The daemon logs a one-time URL
 * (`yaac daemon logs`); the user can open it directly or paste just the
 * code here. Built on Base UI's Form + Field — the server "invalid code"
 * result surfaces through the Form `errors` prop into `Field.Error`.
 */
export function BootstrapSplash({ onAuthed }: { onAuthed: () => void }): JSX.Element {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const raw = new FormData(event.currentTarget).get('code')
    const code = (typeof raw === 'string' ? raw : '').trim()
    if (!code) return
    setBusy(true)
    setErrors({})
    try {
      const ok = await postBootstrap(code)
      if (ok) onAuthed()
      else setErrors({ code: 'Invalid or expired code. Restart the daemon for a fresh one.' })
    } catch {
      setErrors({ code: 'Could not reach the daemon.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg text-text">
      <div className="w-full max-w-md px-8">
        <h1 className="text-2xl font-semibold tracking-tight text-text">Connect to yaac</h1>
        <p className="mt-3 text-sm text-text-dim">
          Open the URL from <code className="text-text">yaac daemon logs</code>, or paste the
          one-time bootstrap code below.
        </p>
        <Form
          errors={errors}
          onSubmit={(e) => void submit(e)}
          className="mt-6 flex flex-col gap-3"
        >
          <Field.Root name="code" className="flex flex-col gap-1">
            <Field.Label className="sr-only">Bootstrap code</Field.Label>
            <Field.Control
              placeholder="bootstrap code"
              autoFocus
              className="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm
                text-text outline-none focus:border-border-strong"
            />
            <Field.Error className="text-sm text-red-400" />
          </Field.Root>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg
              transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </Form>
      </div>
    </div>
  )
}
