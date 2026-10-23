import { useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronIcon, HealthIcon, WarningIcon } from '#lib/icons'
import { Meter } from '#components/ui/Meter'
import { Modal } from '#components/ui/Modal'
import { Sparkline } from '#components/ui/Sparkline'
import { api } from '#lib/api'
import type {
  ComponentUsage,
  ResourceReport,
  UsagePoint,
  VolumeUsage,
  WorkspaceUsageRow,
} from '@yaac/shared/types'

/*
 * The server health overlay (docs/server-health.md): the install's CPU,
 * memory and disk, the nodes, the infrastructure components and each
 * workspace, with an hour of history. Any user may open it. The report is
 * polled only while it is open; the server samples history whether or not
 * anyone looks.
 */

const POLL_MS = 10_000

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB']

function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${UNITS[unit]}`
}

function formatCores(cores: number): string {
  return cores >= 10 ? cores.toFixed(0) : cores.toFixed(2)
}

const memoryPoints = (history: UsagePoint[]) => history.map((p) => ({ at: p.at, value: p.memoryBytes }))
const cpuPoints = (history: UsagePoint[]) => history.map((p) => ({ at: p.at, value: p.cpuCores }))

/** The rail chip (or the mobile projects screen's row) that opens the
 *  overlay. */
export function ServerHealthButton({ variant = 'rail' }: { variant?: 'rail' | 'row' } = {}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Server health"
        aria-label="Server health"
        className={variant === 'row'
          ? 'flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-text-dim transition '
            + 'active:bg-surface-2'
          : 'flex h-10 w-10 items-center justify-center rounded-[20px] text-text-faint transition-all '
            + 'hover:rounded-xl hover:text-text-dim'}
      >
        <HealthIcon size={18} />
        {variant === 'row' && <span>Server health</span>}
      </button>
      <ServerHealthOverlay open={open} onOpenChange={setOpen} />
    </>
  )
}

export function ServerHealthOverlay({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const { data, error, isPlaceholderData, isFetching } = useQuery({
    queryKey: ['server-usage'],
    queryFn: () => api.server.usage.$get(),
    enabled: open,
    refetchInterval: POLL_MS,
    // A refetch keeps the last report on screen, dimmed, rather than
    // flashing empty.
    placeholderData: keepPreviousData,
  })
  return (
    <Modal open={open} onOpenChange={onOpenChange} variant="sheet" title="Server health">
      {error && <p className="text-xs text-danger">{error.message}</p>}
      {!data && !error && <p className="text-xs text-text-faint">Loading…</p>}
      {data && (
        <div className={clsx(
          'flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-1 transition-opacity',
          isFetching && isPlaceholderData && 'opacity-70',
        )}>
          <p className="text-[11px] text-text-faint">
            Sampled {new Date(data.sampledAt).toLocaleTimeString()}. History covers up to the last hour and
            starts over when the server restarts.
            {data.driver === 'containerless' && ' Memory is resident memory (RSS), which counts a page shared by'
              + ' several processes once for each, so per-process figures are approximate.'}
          </p>
          <Totals report={data} />
          {data.nodes.length > 0 && <Nodes report={data} />}
          <Components report={data} />
          <Workspaces report={data} />
        </div>
      )}
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-text-dim">{title}</h3>
      {children}
    </section>
  )
}

function Tile({ label, value, children }: { label: string; value: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-56 flex-1 flex-col gap-1.5 rounded-lg bg-bg/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-text-dim">{label}</span>
        <span className="text-sm font-semibold">{value}</span>
      </div>
      {children}
    </div>
  )
}

function VolumeMeter({ volume }: { volume: VolumeUsage }): JSX.Element {
  if (volume.usedBytes === null || volume.capacityBytes === null) {
    return (
      <span className="text-[11px] text-text-faint">
        {volume.capacityBytes === null ? 'size unknown' : `${formatBytes(volume.capacityBytes)}; usage not reported`}
      </span>
    )
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-text-dim">
        {formatBytes(volume.usedBytes)} / {formatBytes(volume.capacityBytes)}
      </span>
      <Meter className="min-w-0 flex-1" used={volume.usedBytes} capacity={volume.capacityBytes} label={`${volume.name} used`} />
    </span>
  )
}

function Totals({ report }: { report: ResourceReport }): JSX.Element {
  const t = report.totals
  const missing = report.nodes.filter((n) => n.error !== undefined).length
  return (
    <Section title={report.driver === 'k8s' ? 'Cluster' : 'Host'}>
      {missing > 0 && (
        <p className="flex items-center gap-1 text-[11px] text-warning">
          <WarningIcon size={11} aria-hidden />
          CPU and memory cover {report.nodes.length - missing} of {report.nodes.length} nodes; the Nodes
          section says why the rest are missing.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Tile label="CPU" value={`${formatCores(t.cpuCores)} / ${formatCores(t.cpuCapacityCores)} cores`}>
          <Meter used={t.cpuCores} capacity={t.cpuCapacityCores} label="CPU in use" />
          <Sparkline points={cpuPoints(t.history)} format={(v) => `${formatCores(v)} cores`} label="CPU" max={t.cpuCapacityCores} />
        </Tile>
        <Tile label="Memory" value={`${formatBytes(t.memoryBytes)} / ${formatBytes(t.memoryCapacityBytes)}`}>
          <Meter used={t.memoryBytes} capacity={t.memoryCapacityBytes} label="Memory in use" />
          <Sparkline points={memoryPoints(t.history)} format={formatBytes} label="Memory" max={t.memoryCapacityBytes} />
          {t.swapCapacityBytes > 0 && (
            <span className="text-[11px] text-text-dim">
              Swap {formatBytes(t.swapBytes)} / {formatBytes(t.swapCapacityBytes)}
            </span>
          )}
        </Tile>
        {t.scheduled && (
          <Tile label="Scheduled (requests)" value="">
            <span className="text-[11px] text-text-dim">
              CPU {formatCores(t.scheduled.cpuRequestCores)} / {formatCores(t.scheduled.cpuAllocatableCores)} cores
            </span>
            <Meter used={t.scheduled.cpuRequestCores} capacity={t.scheduled.cpuAllocatableCores} label="CPU requested" />
            <span className="text-[11px] text-text-dim">
              Memory {formatBytes(t.scheduled.memoryRequestBytes)} / {formatBytes(t.scheduled.memoryAllocatableBytes)}
            </span>
            <Meter used={t.scheduled.memoryRequestBytes} capacity={t.scheduled.memoryAllocatableBytes} label="Memory requested" />
          </Tile>
        )}
      </div>
      {t.disks.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg bg-bg/60 p-3">
          <span className="text-xs text-text-dim">Disk</span>
          {t.disks.map((d) => (
            <div key={d.name} className="flex items-center gap-3 text-xs">
              <span className="w-56 truncate font-mono text-[11px] max-md:w-24" title={d.name}>{d.name}</span>
              <VolumeMeter volume={d} />
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

const ROLE_LABEL = {
  infrastructure: 'infrastructure only',
  workspaces: 'workspaces',
  both: 'workspaces and infrastructure',
  'gvisor-pending': 'gVisor pending',
} as const

function Nodes({ report }: { report: ResourceReport }): JSX.Element {
  return (
    <details open={report.nodes.length <= 3} className="flex flex-col gap-2">
      <summary className="cursor-pointer text-xs font-semibold text-text-dim">
        Nodes ({report.nodes.length})
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="text-left text-[11px] text-text-faint">
              <th className="py-1 font-normal">Node</th>
              <th className="font-normal">Role</th>
              <th className="font-normal">CPU</th>
              <th className="font-normal">Memory</th>
              <th className="font-normal">Swap</th>
              <th className="font-normal">Conditions</th>
              <th className="font-normal">Sample</th>
            </tr>
          </thead>
          <tbody>
            {report.nodes.map((n) => (
              <tr key={n.name} className="border-t border-hairline align-middle">
                <td className="py-1.5 pr-2 font-mono text-[11px]">{n.name}</td>
                <td className="pr-2 text-text-dim">{ROLE_LABEL[n.role]}</td>
                {n.error !== undefined
                  ? <td colSpan={5} className="text-warning">{n.error}</td>
                  : (
                    <>
                      <td className="w-40 pr-3">
                        <span className="tabular-nums text-text-dim">{formatCores(n.cpuCores)} / {formatCores(n.cpuCapacityCores)}</span>
                        <Meter used={n.cpuCores} capacity={n.cpuCapacityCores} label={`${n.name} CPU`} />
                      </td>
                      <td className="w-44 pr-3">
                        <span className="tabular-nums text-text-dim">{formatBytes(n.memoryBytes)} / {formatBytes(n.memoryCapacityBytes)}</span>
                        <Meter used={n.memoryBytes} capacity={n.memoryCapacityBytes} label={`${n.name} memory`} />
                      </td>
                      <td className="pr-2 tabular-nums text-text-dim">{formatBytes(n.swapBytes)}</td>
                      <td className="pr-2">
                        {n.conditions.length === 0
                          ? <span className="text-text-faint">healthy</span>
                          : (
                            <span className="flex items-center gap-1 text-danger">
                              <WarningIcon size={11} aria-hidden />
                              {n.conditions.join(', ')}
                            </span>
                          )}
                      </td>
                      <td className="text-text-faint">
                        {n.sampledAt === null ? '—' : `${String(Math.max(0, Math.round((report.sampledAt - n.sampledAt) / 1000)))}s ago`}
                      </td>
                    </>
                  )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

function ComponentRow({ c, depth = 0 }: {
  c: ComponentUsage & { history?: UsagePoint[] }
  depth?: number
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const children = c.children ?? []
  return (
    <>
      <tr className="border-t border-hairline align-middle">
        <td className="py-1.5 pr-2" style={{ paddingLeft: depth * 16 }}>
          {children.length > 0
            ? (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                aria-expanded={expanded}
                className="flex items-center gap-1 hover:text-text"
              >
                <ChevronIcon size={11} className={clsx('transition-transform', expanded && 'rotate-90')} />
                {c.label}
              </button>
            )
            : c.label}
          {c.count !== undefined && <span className="ml-1 text-text-faint">({c.count} running)</span>}
        </td>
        <td className="pr-3 tabular-nums text-text-dim">{formatCores(c.cpuCores)}</td>
        <td className="pr-3 tabular-nums text-text-dim">{formatBytes(c.memoryBytes)}</td>
        <td className="pr-3">
          {c.history && <Sparkline points={memoryPoints(c.history)} format={formatBytes} label={`${c.label} memory`} />}
        </td>
        <td className="min-w-64">
          <div className="flex flex-col gap-1">
            {c.volumes.map((v) => (
              <div key={v.name} className="flex items-center gap-2">
                <span className="w-40 shrink-0 truncate font-mono text-[11px]" title={v.name}>{v.name}</span>
                <VolumeMeter volume={v} />
              </div>
            ))}
          </div>
        </td>
      </tr>
      {expanded && children.map((child) => <ComponentRow key={child.key} c={child} depth={depth + 1} />)}
    </>
  )
}

function Components({ report }: { report: ResourceReport }): JSX.Element {
  return (
    <Section title="Infrastructure">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="text-left text-[11px] text-text-faint">
              <th className="py-1 font-normal">Component</th>
              <th className="font-normal">CPU (cores)</th>
              <th className="font-normal">Memory</th>
              <th className="font-normal">Memory, last hour</th>
              <th className="font-normal">Volumes</th>
            </tr>
          </thead>
          <tbody>
            {report.components.map((c) => <ComponentRow key={c.key} c={c} />)}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

function WorkspaceRow({ w, showNode }: { w: WorkspaceUsageRow; showNode: boolean }): JSX.Element {
  return (
    <tr className={clsx('border-t border-hairline align-middle', !w.running && 'text-text-faint')}>
      <td className="max-w-64 py-1.5 pr-2">
        <span className="block truncate" title={w.title ?? w.workspaceId}>
          {w.title ?? <span className="font-mono text-[11px]">{w.workspaceId.slice(0, 8)}</span>}
        </span>
        {!w.running && (
          <span className="text-[11px]">
            stopped{w.deathReason !== undefined && <> · <span className="text-warning">{w.deathReason}</span></>}
            {w.deathDetail !== undefined && <> · {w.deathDetail}</>}
          </span>
        )}
      </td>
      <td className="pr-2 text-text-dim">
        {w.projectName ?? '—'}
        {w.owner !== undefined && <span className="block text-[11px] text-text-faint">{w.owner}</span>}
      </td>
      {showNode && <td className="pr-2 font-mono text-[11px] text-text-dim">{w.node ?? '—'}</td>}
      <td className="pr-3 tabular-nums text-text-dim">{w.running ? formatCores(w.cpuCores) : '—'}</td>
      <td className="w-48 pr-3">
        {w.running && (
          <>
            <span className="tabular-nums text-text-dim">
              {formatBytes(w.memoryBytes)}{w.memoryLimitBytes !== null && ` / ${formatBytes(w.memoryLimitBytes)}`}
            </span>
            {w.memoryLimitBytes !== null && (
              <Meter used={w.memoryBytes} capacity={w.memoryLimitBytes} label="Memory against its limit" />
            )}
          </>
        )}
      </td>
      <td className="pr-3 tabular-nums text-text-dim">
        {w.ephemeralStorageBytes === null ? '—' : formatBytes(w.ephemeralStorageBytes)}
      </td>
      <td className="pr-3 tabular-nums text-text-dim">{formatBytes(w.peakMemoryBytes)}</td>
      <td>
        <Sparkline
          points={memoryPoints(w.history)}
          format={formatBytes}
          label="Memory"
          {...(w.memoryLimitBytes !== null ? { max: w.memoryLimitBytes } : {})}
        />
      </td>
    </tr>
  )
}

function Workspaces({ report }: { report: ResourceReport }): JSX.Element {
  const showNode = report.driver === 'k8s'
  return (
    <Section title={`Workspaces (${String(report.workspaces.filter((w) => w.running).length)} running)`}>
      {report.workspaces.length === 0
        ? <p className="text-xs text-text-faint">No workspace has run in the last hour.</p>
        : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-xs">
              <thead>
                <tr className="text-left text-[11px] text-text-faint">
                  <th className="py-1 font-normal">Workspace</th>
                  <th className="font-normal">Project</th>
                  {showNode && <th className="font-normal">Node</th>}
                  <th className="font-normal">CPU (cores)</th>
                  <th className="font-normal">Memory</th>
                  <th className="font-normal">Ephemeral</th>
                  <th className="font-normal">Peak (1h)</th>
                  <th className="font-normal">Memory, last hour</th>
                </tr>
              </thead>
              <tbody>
                {report.workspaces.map((w) => <WorkspaceRow key={w.workspaceId} w={w} showNode={showNode} />)}
              </tbody>
            </table>
          </div>
        )}
    </Section>
  )
}
