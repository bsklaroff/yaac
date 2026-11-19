import { useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { HealthIcon, WarningIcon } from '#lib/icons'
import { api } from '#lib/api'
import type {
  ComponentUsage,
  NodeDisk,
  ResourceReport,
  UsagePoint,
  VolumeUsage,
  WorkspaceUsageRow,
} from '@yaac/shared/types'
import { YBars, YButton, YDialog, YMeter } from '#ui'

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

/** How much of a capacity is used, amber from 75% and red from 90%. `name`
 *  says what for screen readers, where `label` relies on its table or tile. */
function Usage({ label, name, used, capacity }: { label: string; name: string; used: number; capacity: number }): JSX.Element {
  return <YMeter label={label} name={name} value={capacity > 0 ? used / capacity : 0} warnAt={0.75} dangerAt={0.9} />
}

/** At most this many bars per history, so a chart fits a table cell. */
const BARS = 20

/**
 * An hour of one series as bars, oldest first, each the largest sample in
 * its stretch of the hour, labelled with its value and time. `max` is the
 * capacity it is drawn against, when there is one.
 */
function History({ history, value, format, name, max }: {
  history: UsagePoint[]
  value: (p: UsagePoint) => number
  format: (value: number) => string
  /** What it plots ("CPU"), for screen readers. */
  name: string
  max?: number
}): JSX.Element {
  if (history.length < 2) return <span className="text-xs text-subtle">collecting…</span>
  const size = Math.ceil(history.length / BARS)
  const bars: UsagePoint[] = []
  for (let i = 0; i < history.length; i += size) {
    bars.push(history.slice(i, i + size).reduce((a, b) => (value(b) > value(a) ? b : a)))
  }
  return (
    <YBars
      className="w-24"
      height={24}
      name={`${name}, last hour: now ${format(value(history[history.length - 1]))}`}
      {...(max !== undefined ? { max } : {})}
      values={bars.map(value)}
      labels={bars.map((p) => `${format(value(p))} at ${new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)}
    />
  )
}

const memory = (p: UsagePoint): number => p.memoryBytes
const cpu = (p: UsagePoint): number => p.cpuCores

/** The mobile projects screen's row that opens the overlay. */
export function ServerHealthButton(): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <YButton
        variant="bare"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-3 px-3 py-3 text-left text-base text-muted transition active:bg-selected"
      >
        <HealthIcon size={18} />
        <span>Server health</span>
      </YButton>
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
    <YDialog open={open} onOpenChange={onOpenChange} variant="sheet" title="Server health">
      {error && <p className="text-md text-danger">{error.message}</p>}
      {!data && !error && <p className="text-md text-subtle">Loading…</p>}
      {data && (
        <div className={clsx(
          'flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-1 transition-opacity',
          isFetching && isPlaceholderData && 'opacity-70',
        )}>
          <p className="text-sm text-subtle">
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
    </YDialog>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-md font-semibold text-muted">{title}</h3>
      {children}
    </section>
  )
}

function Tile({ label, value, children }: { label: string; value: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-56 flex-1 flex-col gap-1.5 rounded-lg bg-sunken/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-md text-muted">{label}</span>
        <span className="text-base font-semibold">{value}</span>
      </div>
      {children}
    </div>
  )
}

function VolumeMeter({ volume }: { volume: VolumeUsage }): JSX.Element {
  if (volume.usedBytes === null || volume.capacityBytes === null) {
    return (
      <span className="text-sm text-subtle">
        {volume.capacityBytes === null ? 'size unknown' : `${formatBytes(volume.capacityBytes)}; usage not reported`}
      </span>
    )
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-muted">
        {formatBytes(volume.usedBytes)} / {formatBytes(volume.capacityBytes)}
      </span>
      <span className="min-w-0 flex-1"><Usage label="Used" name={`${volume.name} used`} used={volume.usedBytes} capacity={volume.capacityBytes} /></span>
    </span>
  )
}

function Totals({ report }: { report: ResourceReport }): JSX.Element {
  const t = report.totals
  const missing = report.nodes.filter((n) => n.error !== undefined).length
  return (
    <Section title={report.driver === 'k8s' ? 'Cluster' : 'Host'}>
      {missing > 0 && (
        <p className="flex items-center gap-1 text-sm text-warning">
          <WarningIcon size={11} aria-hidden />
          CPU and memory cover {report.nodes.length - missing} of {report.nodes.length} nodes; the Nodes
          section says why the rest are missing.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Tile label="CPU" value={`${formatCores(t.cpuCores)} / ${formatCores(t.cpuCapacityCores)} cores`}>
          <Usage label="In use" name="CPU in use" used={t.cpuCores} capacity={t.cpuCapacityCores} />
          <History history={t.history} value={cpu} format={(v) => `${formatCores(v)} cores`} name="CPU" max={t.cpuCapacityCores} />
        </Tile>
        <Tile label="Memory" value={`${formatBytes(t.memoryBytes)} / ${formatBytes(t.memoryCapacityBytes)}`}>
          <Usage label="In use" name="Memory in use" used={t.memoryBytes} capacity={t.memoryCapacityBytes} />
          <History history={t.history} value={memory} format={formatBytes} name="Memory" max={t.memoryCapacityBytes} />
          {t.swapCapacityBytes > 0 && (
            <span className="text-sm text-muted">
              Swap {formatBytes(t.swapBytes)} / {formatBytes(t.swapCapacityBytes)}
            </span>
          )}
        </Tile>
        {t.scheduled && (
          <Tile label="Scheduled (requests)" value="">
            <span className="text-sm text-muted">
              CPU {formatCores(t.scheduled.cpuRequestCores)} / {formatCores(t.scheduled.cpuAllocatableCores)} cores
            </span>
            <Usage label="Requested" name="CPU requested" used={t.scheduled.cpuRequestCores} capacity={t.scheduled.cpuAllocatableCores} />
            <span className="text-sm text-muted">
              Memory {formatBytes(t.scheduled.memoryRequestBytes)} / {formatBytes(t.scheduled.memoryAllocatableBytes)}
            </span>
            <Usage label="Requested" name="Memory requested" used={t.scheduled.memoryRequestBytes} capacity={t.scheduled.memoryAllocatableBytes} />
          </Tile>
        )}
      </div>
      {t.disks.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg bg-sunken/60 p-3">
          <span className="text-md text-muted">Disk</span>
          {t.disks.map((d) => (
            <div key={d.name} className="flex items-center gap-3 text-md">
              <span className="w-56 truncate font-mono text-sm max-md:w-24" title={d.name}>{d.name}</span>
              <VolumeMeter volume={d} />
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

/**
 * A node's node-local disk, where workspace trees live: free space against
 * the floors under which yaac warns and then stops the largest tree's
 * workspace, and that node's largest trees once it is under the first.
 */
function NodeDiskCell({ disk, titles }: { disk: NodeDisk | undefined; titles: Map<string, string> }): JSX.Element {
  if (disk === undefined) return <span className="text-subtle">—</span>
  if (disk.error !== undefined) return <span className="text-warning">{disk.error}</span>
  const tone = disk.freeBytes < disk.stopBytes ? 'text-danger' : disk.freeBytes < disk.warnBytes ? 'text-warning' : 'text-muted'
  return (
    <span className="flex flex-col">
      <span className={clsx('tabular-nums', tone)}>{formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}</span>
      {disk.freeBytes < disk.warnBytes && (
        <span className="text-sm text-subtle">
          {disk.freeBytes < disk.stopBytes ? `under the ${formatBytes(disk.stopBytes)} stop floor` : `under the ${formatBytes(disk.warnBytes)} warn floor`}
          {(disk.trees ?? []).slice(0, 3).map((t) => (
            <span key={`${t.workspaceId}/${t.life}`} className="block">{titles.get(t.workspaceId) ?? t.workspaceId.slice(0, 8)}: {formatBytes(t.bytes)}</span>
          ))}
        </span>
      )}
    </span>
  )
}

const ROLE_LABEL = {
  infrastructure: 'infrastructure only',
  workspaces: 'workspaces',
  both: 'workspaces and infrastructure',
  'gvisor-pending': 'gVisor pending',
} as const

function Nodes({ report }: { report: ResourceReport }): JSX.Element {
  const running = new Map<string, number>()
  for (const w of report.workspaces) {
    if (w.running && w.node !== undefined) running.set(w.node, (running.get(w.node) ?? 0) + 1)
  }
  const disks = new Map((report.nodeDisks ?? []).map((d) => [d.node, d]))
  const titles = new Map(report.workspaces.map((w) => [w.workspaceId, w.title ?? w.workspaceId.slice(0, 8)]))
  return (
    <details open={report.nodes.length <= 3} className="flex flex-col gap-2">
      <summary className="cursor-pointer text-md font-semibold text-muted">
        Nodes ({report.nodes.length})
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[800px] text-md">
          <thead>
            <tr className="text-left text-sm text-subtle">
              <th className="py-1 font-normal">Node</th>
              <th className="font-normal">Role</th>
              <th className="font-normal">Workspaces</th>
              <th className="font-normal">CPU</th>
              <th className="font-normal">Memory</th>
              <th className="font-normal">Swap</th>
              {disks.size > 0 && <th className="font-normal">Trees disk</th>}
              <th className="font-normal">Conditions</th>
              <th className="font-normal">Sample</th>
            </tr>
          </thead>
          <tbody>
            {report.nodes.map((n) => (
              <tr key={n.name} className="border-t border-line align-middle">
                <td className="py-1.5 pr-2 font-mono text-sm">{n.name}</td>
                <td className="pr-2 text-muted">{ROLE_LABEL[n.role]}</td>
                {n.error !== undefined
                  ? <td colSpan={disks.size > 0 ? 7 : 6} className="text-warning">{n.error}</td>
                  : (
                    <>
                      <td className="pr-2 tabular-nums text-muted">{running.get(n.name) ?? 0}</td>
                      <td className="w-48 pr-3">
                        <span className="tabular-nums text-muted">{formatCores(n.cpuCores)} / {formatCores(n.cpuCapacityCores)}</span>
                        <Usage label="Used" name={`${n.name} CPU`} used={n.cpuCores} capacity={n.cpuCapacityCores} />
                      </td>
                      <td className="w-52 pr-3">
                        <span className="tabular-nums text-muted">{formatBytes(n.memoryBytes)} / {formatBytes(n.memoryCapacityBytes)}</span>
                        <Usage label="Used" name={`${n.name} memory`} used={n.memoryBytes} capacity={n.memoryCapacityBytes} />
                      </td>
                      <td className="pr-2 tabular-nums text-muted">
                        {n.swapCapacityBytes > 0
                          ? `${formatBytes(n.swapBytes)} / ${formatBytes(n.swapCapacityBytes)}`
                          : <span className="text-subtle">none</span>}
                      </td>
                      {disks.size > 0 && <td className="pr-2"><NodeDiskCell disk={disks.get(n.name)} titles={titles} /></td>}
                      <td className="pr-2">
                        {n.conditions.length === 0
                          ? <span className="text-subtle">healthy</span>
                          : (
                            <span className="flex items-center gap-1 text-danger">
                              <WarningIcon size={11} aria-hidden />
                              {n.conditions.join(', ')}
                            </span>
                          )}
                      </td>
                      <td className="text-subtle">
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

function ComponentRow({ c }: { c: ComponentUsage & { history?: UsagePoint[] } }): JSX.Element {
  return (
    <tr className="border-t border-line align-middle">
      <td className="py-1.5 pr-2">
        {c.label}
        {c.count !== undefined && <span className="ml-1 text-subtle">({c.count} running)</span>}
      </td>
      <td className="pr-3 tabular-nums text-muted">{formatCores(c.cpuCores)}</td>
      <td className="pr-3 tabular-nums text-muted">{formatBytes(c.memoryBytes)}</td>
      <td className="pr-3">
        {c.history && <History history={c.history} value={memory} format={formatBytes} name={`${c.label} memory`} />}
      </td>
      <td className="min-w-64">
        <div className="flex flex-col gap-1">
          {c.volumes.map((v) => (
            <div key={v.name} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate font-mono text-sm" title={v.name}>{v.name}</span>
              <VolumeMeter volume={v} />
            </div>
          ))}
        </div>
      </td>
    </tr>
  )
}

function Components({ report }: { report: ResourceReport }): JSX.Element {
  return (
    <Section title="Infrastructure">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-md">
          <thead>
            <tr className="text-left text-sm text-subtle">
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
    <tr className={clsx('border-t border-line align-middle', !w.running && 'text-subtle')}>
      <td className="max-w-64 py-1.5 pr-2">
        <span className="block truncate" title={w.title ?? w.workspaceId}>
          {w.title ?? <span className="font-mono text-sm">{w.workspaceId.slice(0, 8)}</span>}
        </span>
        {!w.running && (
          <span className="text-sm">
            stopped{w.deathReason !== undefined && <>, <span className="text-warning">{w.deathReason}</span></>}
            {w.deathDetail !== undefined && <>, {w.deathDetail}</>}
          </span>
        )}
      </td>
      <td className="pr-2 text-muted">
        {w.projectName ?? '—'}
        {w.owner !== undefined && <span className="block text-sm text-subtle">{w.owner}</span>}
      </td>
      {showNode && <td className="pr-2 font-mono text-sm text-muted">{w.node ?? '—'}</td>}
      <td className="pr-3 tabular-nums text-muted">{w.running ? formatCores(w.cpuCores) : '—'}</td>
      <td className="w-56 pr-3">
        {w.running && (
          <>
            <span className="tabular-nums text-muted">
              {formatBytes(w.memoryBytes)}{w.memoryLimitBytes !== null && ` / ${formatBytes(w.memoryLimitBytes)}`}
            </span>
            {w.memoryLimitBytes !== null && (
              <Usage label="Of limit" name="Memory against its limit" used={w.memoryBytes} capacity={w.memoryLimitBytes} />
            )}
          </>
        )}
      </td>
      <td className="pr-3 tabular-nums text-muted">
        {w.ephemeralStorageBytes === null ? '—' : formatBytes(w.ephemeralStorageBytes)}
      </td>
      <td className="pr-3 tabular-nums text-muted">{formatBytes(w.peakMemoryBytes)}</td>
      <td>
        <History history={w.history} value={memory} format={formatBytes} name="Memory" />
      </td>
    </tr>
  )
}

function Workspaces({ report }: { report: ResourceReport }): JSX.Element {
  const showNode = report.driver === 'k8s'
  return (
    <Section title={`Workspaces (${String(report.workspaces.filter((w) => w.running).length)} running)`}>
      {report.workspaces.length === 0
        ? <p className="text-md text-subtle">No workspace has run in the last hour.</p>
        : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-md">
              <thead>
                <tr className="text-left text-sm text-subtle">
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
