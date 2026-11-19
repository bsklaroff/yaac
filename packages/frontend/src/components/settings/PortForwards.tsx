import { useState, type FormEvent, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import type { PortForwardConfig } from '@yaac/shared/types'
import { YButton, YNumberInput, YRowFrame, YSettingRow } from '#ui'

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
    <YSettingRow
      stacked
      label="Forwarded ports"
      hint={<>
        Ports forwarded from every workspace, each offered at its host port or the first one free
        above it. Each workspace gets <code className="text-muted">YAAC_PORT_&lt;port&gt;</code>,
        the port its dev server should bind. Applies to workspaces created after saving.
      </>}
    >
      {ports.length === 0 && <p className="text-md text-subtle">None</p>}
      <div className="divide-y divide-line">
        {ports.map((p) => (
          <YRowFrame
            key={p.containerPort}
            label={`Port ${p.containerPort}`}
            actionsShown
            actions={!readOnly && (
              <YButton
                variant="ghost"
                size="sm"
                icon={DeleteIcon}
                onClick={() => save.mutate(ports.filter((x) => x.containerPort !== p.containerPort))}
                disabled={save.isPending}
                aria-label={`Remove port ${p.containerPort}`}
              />
            )}
            className="min-h-8 font-mono text-md"
          >
            <span className="flex-1 truncate text-text">
              {p.containerPort}
              <span className="ml-2 font-sans text-sm text-subtle">host {p.hostPortStart} and up</span>
            </span>
          </YRowFrame>
        ))}
      </div>

      {!readOnly && <form onSubmit={submit} className="mt-2 flex items-center gap-2 text-sm text-subtle">
        <YNumberInput
          aria-label="Container port"
          min={1}
          max={65535}
          placeholder="3000"
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          className="h-7 w-24 bg-sunken"
        />
        host from
        <YNumberInput
          aria-label="Host port"
          min={1}
          max={65535}
          placeholder={container === '' ? 'same' : container}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          className="h-7 w-24 bg-sunken"
        />
        <YButton type="submit" aria-label="Add forwarded port" disabled={save.isPending || container.trim() === ''}>
          Add
        </YButton>
      </form>}

      {save.error && <p className="mt-2 text-md text-danger">{save.error.message}</p>}
    </YSettingRow>
  )
}
