import type { JSX } from 'react'
import { useUiStore } from '@/frontend/store'
import type { DaemonSnapshot } from '@/shared/types'

export function SessionView({ snapshot }: { snapshot: DaemonSnapshot | undefined }): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const session = snapshot?.sessions.find((s) => s.sessionId === selectedSessionId)

  if (!session) {
    return (
      <main className="flex h-full flex-1 items-center justify-center text-neutral-600">
        Select a session
      </main>
    )
  }

  return (
    <main className="h-full flex-1 overflow-y-auto bg-neutral-900 p-8 text-neutral-200">
      <h1 className="text-xl font-semibold">{session.projectSlug}</h1>
      <dl className="mt-6 grid max-w-xl grid-cols-[8rem_1fr] gap-y-3 text-sm">
        <Field label="Session" value={session.sessionId} />
        <Field label="Tool" value={session.tool} />
        <Field label="Status" value={session.status} />
        <Field label="Created" value={session.createdAt} />
        <Field label="Blocked hosts" value={session.blockedHosts.length ? session.blockedHosts.join(', ') : '—'} />
      </dl>
      {session.prompt && (
        <div className="mt-6 max-w-xl">
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Prompt</div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-300">{session.prompt}</p>
        </div>
      )}
      <p className="mt-8 text-xs text-neutral-600">
        Embedded terminal lands with the PTY bridge (next milestone).
      </p>
    </main>
  )
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="break-all font-mono text-neutral-200">{value}</dd>
    </>
  )
}
