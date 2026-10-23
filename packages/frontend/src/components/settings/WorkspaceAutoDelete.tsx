import { useEffect, useState, type FormEvent, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '#lib/api'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'

const autoDelete = api.project[':projectId']['workspace-auto-delete']

const plural = (n: number): string => `${n} stopped workspace${n === 1 ? '' : 's'}`

/**
 * Stopped workspace auto-delete: after how many days the server deletes the
 * project's stopped workspaces for good. `days` comes from the snapshot
 * (absent keeps them forever). Setting a number first asks the server how
 * many workspaces it would delete at once, an upper bound, and has the user
 * confirm that count; once saved it says how many went and which were kept
 * for now. Turning it off deletes nothing, so it does not ask.
 */
export function WorkspaceAutoDelete({ projectId, name, days, readOnly }: {
  projectId: string
  name: string
  days: number | undefined
  readOnly: boolean
}): JSX.Element {
  const [draft, setDraft] = useState(days?.toString() ?? '')
  const [pending, setPending] = useState<{ days: number; expired: number; before: string } | null>(null)
  useEffect(() => setDraft(days?.toString() ?? ''), [days])

  const parsed = /^\d+$/.test(draft.trim()) ? Number(draft.trim()) : NaN
  const valid = parsed >= 1 && parsed <= 36_500

  const save = useMutation({
    mutationFn: (next: { days: number; before: string } | null) =>
      autoDelete.$put({ param: { projectId }, json: next ?? { days: null } }),
    onSuccess: () => setPending(null),
  })
  const preview = useMutation({
    mutationFn: async (n: number) => ({
      days: n,
      ...await autoDelete.$get({ param: { projectId }, query: { days: String(n) } }),
    }),
    onSuccess: (next) => { save.reset(); setPending(next) },
  })

  // A failed confirm shows in the dialog; a failed turn-off, here.
  const error = preview.error ?? (pending === null ? save.error : null)
  const outcome = pending === null && save.data && save.variables !== null ? save.data : undefined

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (valid) preview.mutate(parsed)
  }

  return (
    <div>
      <div className="text-xs font-medium text-text">Stopped workspace auto-delete</div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Delete this project&apos;s workspaces once they have been stopped this many days, with their
        checkouts (unpushed commits and uncommitted changes included) and conversation history.
        Deleted workspaces cannot be recovered. Leave it off to keep them until you delete them.
      </p>
      <form onSubmit={submit} className="mt-2 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          inputMode="numeric"
          placeholder="off"
          aria-label="Days stopped before a workspace is deleted"
          disabled={readOnly}
          className="w-20 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text
            outline-none focus:border-border-strong"
        />
        <span className="text-[11px] text-text-dim">days</span>
        {!readOnly && <>
          <button type="submit" disabled={!valid || parsed === days || preview.isPending} className={BUTTON}>Save</button>
          {days !== undefined && (
            <button type="button" onClick={() => save.mutate(null)} disabled={save.isPending} className={TEXT_BUTTON}>
              Turn off
            </button>
          )}
        </>}
      </form>
      {error && <p className="mt-2 text-xs text-red-400">{error.message}</p>}
      {outcome && (
        <p className="mt-2 text-[11px] leading-relaxed text-text-dim">
          Deleted {plural(outcome.deleted)}.
          {outcome.kept.length > 0 && ` Kept ${plural(outcome.kept.length)} for now, deleted once they can be: `
            + outcome.kept.map((k) => k.reason).join('; ')}
        </p>
      )}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => { if (!open) setPending(null) }}
        title={pending && pending.expired > 0
          ? `Delete up to ${plural(pending.expired)} now?`
          : `Delete stopped workspaces after ${pending?.days ?? ''} days?`}
        description={pending === null ? '' : `Every workspace in ${name} will be deleted once it has been stopped `
          + `${pending.days} days: its checkout, unpushed commits, uncommitted changes and conversation history. `
          + (pending.expired > 0
            ? `Up to ${plural(pending.expired)} already past that will be deleted irretrievably right away; any `
              + 'that cannot be yet (still running, or with queued workspaces waiting on them) go once they can.'
            : 'None is past that yet.')}
        confirmLabel={pending && pending.expired > 0
          ? `Delete up to ${plural(pending.expired)}`
          : days === undefined ? 'Turn on' : 'Save'}
        busy={save.isPending}
        requireClick
        {...(save.error ? {
          error: `${save.error.message}. The server may already have saved this and started deleting; `
            + 'reload to see where it stands.',
        } : {})}
        onConfirm={() => { if (pending) save.mutate({ days: pending.days, before: pending.before }) }}
      />
    </div>
  )
}
