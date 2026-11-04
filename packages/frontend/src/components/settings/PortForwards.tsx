import { useState, type FormEvent, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import { SectionLabel } from '#components/settings/Field'
import { NumberInput } from '#components/ui/NumberInput'
import type { PortForwardConfig } from '@yaac/shared/types'

const ROW = 'flex items-center gap-2 rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs'

/**
 * The ports forwarded from every workspace of a project
 * (docs/project-config.md). The list comes from the snapshot, which the
 * server pushes again once it changes. `readOnly` (a teammate's project)
 * only lists them.
 */
export function PortForwards({ projectId, ports, readOnly }: {
  projectId: string
  ports: PortForwardConfig[]
  readOnly: boolean
}): JSX.Element {
  const [container, setContainer] = useState('')
  const [host, setHost] = useState('')
  const save = useMutation({
    mutationFn: (next: PortForwardConfig[]) =>
      api.project[':projectId']['port-forwards'].$put({ param: { projectId }, json: { ports: next } }),
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const containerPort = Number(container)
    const hostPortStart = host.trim() === '' ? containerPort : Number(host)
    save.mutate([...ports, { containerPort, hostPortStart }], {
      onSuccess: () => { setContainer(''); setHost('') },
    })
  }

  return (
    <div>
      <SectionLabel>Forwarded ports</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Ports forwarded from every workspace, each offered at its host port or the first one free
        above it. Each workspace gets <code className="text-text-dim">YAAC_PORT_&lt;port&gt;</code>,
        the port its dev server should bind. Applies to workspaces created after saving.
      </p>

      <div className="mt-3 space-y-1">
        {ports.length === 0 && <div className={ROW}><span className="text-text-faint">None</span></div>}
        {ports.map((p) => (
          <div key={p.containerPort} className={ROW}>
            <span className="flex-1 truncate text-text">
              {p.containerPort}
              <span className="ml-2 font-sans text-[11px] text-text-faint">host {p.hostPortStart} and up</span>
            </span>
            {!readOnly && (
              <button
                onClick={() => save.mutate(ports.filter((x) => x.containerPort !== p.containerPort))}
                disabled={save.isPending}
                aria-label={`Remove port ${p.containerPort}`}
                className="shrink-0 text-text-faint transition hover:text-text disabled:opacity-50"
              >
                <DeleteIcon size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      {!readOnly && <form onSubmit={submit} className="mt-3 flex items-center gap-2 text-[11px] text-text-faint">
        <NumberInput
          aria-label="Container port"
          min={1}
          max={65535}
          placeholder="3000"
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          className="h-7 w-24 bg-bg"
        />
        host from
        <NumberInput
          aria-label="Host port"
          min={1}
          max={65535}
          placeholder={container === '' ? 'same' : container}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          className="h-7 w-24 bg-bg"
        />
        <button
          type="submit"
          aria-label="Add forwarded port"
          disabled={save.isPending || container.trim() === ''}
          className="rounded-md bg-surface-3 px-3 py-1 text-xs font-medium text-text transition
            hover:bg-border-strong disabled:opacity-50"
        >
          Add
        </button>
      </form>}

      {save.error && <p className="mt-2 text-xs text-red-400">{save.error.message}</p>}
    </div>
  )
}
