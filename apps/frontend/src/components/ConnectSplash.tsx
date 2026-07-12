import { useState, type FormEvent, type JSX } from 'react'
import { Form } from '@base-ui/react/form'
import { Field } from '@base-ui/react/field'
import { postWebSession } from '#lib/webSession'

/**
 * First-open / expired-session screen. `yaac open` prints a one-time
 * URL (so does the server start banner — `yaac server logs`); the user
 * can open it directly or paste a token here. One-time and durable
 * tokens (`yaac auth token create`) both work — the exchange is the
 * same. Built on Base UI's Form + Field — the server "invalid token"
 * result surfaces through the Form `errors` prop into `Field.Error`.
 */
export function ConnectSplash({ onAuthed }: { onAuthed: () => void }): JSX.Element {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const raw = new FormData(event.currentTarget).get('token')
    const token = (typeof raw === 'string' ? raw : '').trim()
    if (!token) return
    setBusy(true)
    setErrors({})
    try {
      const ok = await postWebSession(token)
      if (ok) onAuthed()
      else setErrors({ token: 'Invalid or expired token. Run `yaac open` for a fresh URL.' })
    } catch {
      setErrors({ token: 'Could not reach the server.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg text-text">
      <div className="w-full max-w-md px-8">
        <h1 className="text-2xl font-semibold tracking-tight text-text">Connect to yaac</h1>
        <p className="mt-3 text-sm text-text-dim">
          Open the URL printed by <code className="text-text">yaac open</code>, or paste a
          token (one-time, or from <code className="text-text">yaac auth token create</code>)
          below.
        </p>
        <Form
          errors={errors}
          onSubmit={(e) => void submit(e)}
          className="mt-6 flex flex-col gap-3"
        >
          <Field.Root name="token" className="flex flex-col gap-1">
            <Field.Label className="sr-only">Token</Field.Label>
            <Field.Control
              placeholder="token"
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
