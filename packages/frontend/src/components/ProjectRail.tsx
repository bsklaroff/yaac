import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import clsx from 'clsx'
import { FeedbackButton } from '#components/FeedbackButton'
import { NewProjectButton } from '#components/NewProjectButton'
import { ServersButton } from '#components/ServerBadge'
import { ServerHealthButton } from '#components/ServerHealthOverlay'
import { SettingsButton } from '#components/SettingsButton'
import { UserSwitcher } from '#components/UserSwitcher'
import { WindowControls } from '#components/WindowControls'
import { api } from '#lib/api'
import { LoadingIcon, WarningIcon } from '#lib/icons'
import { isElectron } from '#lib/platform'
import { identityColor, identityInitial, projectIconUrl } from '#lib/projectIdentity'
import type { ProjectOp } from '#lib/store'
import { usePressDrag } from '#lib/usePressDrag'
import { useTeammateView } from '#lib/viewer'
import type { ProjectSummary } from '@yaac/shared/types'

/** The projects to list, then the adds still pending, each with the op
 *  (add or remove) in flight on it. */
export function listedProjects(
  projects: ProjectSummary[],
  ops: ProjectOp[],
): Array<ChipProject & { op: ProjectOp | undefined }> {
  return [...projects, ...ops.filter((o) => o.kind === 'add')].map((p) => ({
    id: p.id,
    name: p.name,
    iconHash: 'iconHash' in p ? p.iconHash : undefined,
    op: ops.find((o) => o.id === p.id),
  }))
}

type ChipProject = Pick<ProjectSummary, 'id' | 'name' | 'iconHash'>

/** A project's picture, else its initial, on a chip tinted with its
 *  identity color; a spinner while an op runs on it and a warning once that
 *  op failed. A picture that fails to load falls back to the initial. */
export function ProjectChip({ project, op, iconSize, className, style }: {
  project: ChipProject
  op: ProjectOp | undefined
  iconSize: number
  className: string
  style: CSSProperties
}): JSX.Element {
  const src = project.iconHash === undefined ? undefined : projectIconUrl(project.id, project.iconHash)
  const [failed, setFailed] = useState<string>()
  return (
    <span className={clsx(className, 'overflow-hidden')} style={style}>
      {op !== undefined
        ? op.error === undefined
          ? <LoadingIcon size={iconSize} className="animate-spin" aria-label={`${op.kind === 'add' ? 'Adding' : 'Removing'} project`} />
          : <WarningIcon size={iconSize} className="text-danger" aria-label="Failed" />
        : src !== undefined && src !== failed
          ? <img src={src} alt="" className="h-full w-full object-cover" onError={() => setFailed(src)} />
          : identityInitial(project.name)}
    </span>
  )
}

/** `projects` in the order `ids` lists them, with any it leaves out last. */
function inOrder(projects: ProjectSummary[], ids: string[]): ProjectSummary[] {
  const rank = (p: ProjectSummary): number => {
    const i = ids.indexOf(p.id)
    return i === -1 ? ids.length : i
  }
  return [...projects].sort((a, b) => rank(a) - rank(b))
}

/** A rail chip's colors: muted tints of the project color, slightly
 *  stronger for the active project. */
export function railChipStyle(color: string, active: boolean): CSSProperties {
  return {
    background: `color-mix(in oklab, ${color} ${active ? 26 : 12}%, var(--color-surface-2))`,
    color: active
      ? `color-mix(in oklab, ${color} 40%, var(--color-text))`
      : `color-mix(in oklab, ${color} 45%, var(--color-text-dim))`,
  }
}

/**
 * Left rail: the user switcher, then the viewed user's project chips. The
 * active project scopes the sidebar; a project with unviewed workspaces
 * waiting for input shows a dot. A project being added or removed (`ops`)
 * shows a spinner, or a warning once its request failed.
 *
 * The user can drag their own chips with the mouse to reorder them. The
 * server keeps the order (`PUT /project/order`). The rail shows a dropped
 * order straight away and holds it until the snapshot lists the projects
 * that way, or until the save of the latest drop fails. Saves are sent one
 * at a time, so the server ends on the last drop.
 */
export function ProjectRail({
  projects,
  ops,
  activeProjectId,
  attentionByProject,
  onSelect,
}: {
  projects: ProjectSummary[]
  ops: ProjectOp[]
  activeProjectId: string | null
  attentionByProject: Record<string, number>
  onSelect: (projectId: string) => void
}): JSX.Element {
  const readOnly = useTeammateView()
  const [order, setOrder] = useState<string[] | null>(null)
  const placed = order === null ? projects : inOrder(projects, order)
  const agreed = placed.every((p, i) => p === projects[i])
  useEffect(() => {
    if (agreed) setOrder(null)
  }, [agreed])

  // The drop target is an insertion index into `placed`: how many chips'
  // midpoints lie above the pointer. Off the rail there is none.
  const rail = useRef<HTMLDivElement>(null)
  const chips = useRef(new Map<string, HTMLElement>())
  const saving = useRef(Promise.resolve())
  const drops = useRef(0)
  // Set while a mouse press is usePressDrag's to settle. The browser still
  // fires a click when the press ends on the chip, which must not select
  // after a drag.
  const pressDrag = useRef(false)
  /** Whether dropping `item` at `over` would move it. */
  const moves = (item: string, over: number | undefined): over is number => {
    const from = placed.findIndex((p) => p.id === item)
    return over !== undefined && over !== from && over !== from + 1
  }
  const { drag, start } = usePressDrag<string, number>({
    over: (x, y) => {
      const r = rail.current?.getBoundingClientRect()
      if (!r || x < r.left || x > r.right) return undefined
      return placed.filter((p) => {
        const c = chips.current.get(p.id)?.getBoundingClientRect()
        return c !== undefined && y > c.top + c.height / 2
      }).length
    },
    onDrop: ({ item, over }) => {
      if (!moves(item, over)) return
      const ids = placed.map((p) => p.id)
      const from = ids.indexOf(item)
      ids.splice(from, 1)
      ids.splice(over > from ? over - 1 : over, 0, item)
      setOrder(ids)
      const drop = ++drops.current
      saving.current = saving.current
        .then(() => api.project.order.$put({ json: { projectIds: ids } }))
        .then(() => {}, () => { if (drop === drops.current) setOrder(null) })
    },
  })
  const dropAt = drag !== null && moves(drag.item, drag.over) ? drag.over : -1

  return (
    <div ref={rail} className={clsx(
      // pl-2 centers the chips in the rail plus the 8px gap to the sidebar,
      // which read as one region.
      'flex w-16 shrink-0 flex-col items-center gap-2 pb-3 pl-2',
      isElectron() ? 'pt-2' : 'pt-3',
    )}>
      {isElectron() && <WindowControls className="h-5" />}
      <UserSwitcher />
      {listedProjects(placed, ops).map(({ op, ...p }, i) => {
        const active = p.id === activeProjectId
        const waiting = attentionByProject[p.id] ?? 0
        const draggable = !readOnly && i < placed.length
        return (
          <button
            key={p.id}
            ref={(el) => {
              if (el && draggable) chips.current.set(p.id, el)
              else chips.current.delete(p.id)
            }}
            // A mouse press may become a drag; if not, usePressDrag selects.
            // Touch and keyboard (a click with no pointer, `detail` 0) use
            // onClick.
            onPointerDown={(e) => {
              pressDrag.current = draggable && e.pointerType === 'mouse' && e.button === 0
              if (pressDrag.current) start(e, p.id, () => onSelect(p.id))
            }}
            onClick={(e) => {
              if (e.detail === 0 || !pressDrag.current) onSelect(p.id)
            }}
            className={clsx(
              'group relative flex items-center justify-center',
              drag?.item === p.id && 'opacity-40',
            )}
            title={p.name}
          >
            {/* Centered in the 8px gap above, or below the last chip. */}
            {(dropAt === i || (dropAt === placed.length && i === placed.length - 1)) && (
              <span className={clsx(
                'absolute inset-x-0 h-0.5 rounded-full bg-accent',
                dropAt === i ? '-top-[5px]' : '-bottom-[5px]',
              )} />
            )}
            <span
              className={clsx(
                // -ml-4 pulls the bar flush to the window's left edge.
                'absolute left-0 -ml-4 w-0.5 rounded-r-full bg-text transition-all',
                active ? 'h-6' : 'h-0 group-hover:h-4',
              )}
            />
            <ProjectChip
              project={p}
              op={op}
              iconSize={18}
              className={clsx(
                'flex h-10 w-10 items-center justify-center text-[16px] font-semibold transition-all',
                active ? 'rounded-xl' : 'rounded-[20px] group-hover:rounded-xl',
              )}
              style={railChipStyle(identityColor(p.id), active)}
            />
            {waiting > 0 && op === undefined && (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-base" />
            )}
          </button>
        )
      })}

      <NewProjectButton />

      <div className="flex-1" />
      <FeedbackButton />
      <ServerHealthButton />
      <ServersButton />
      <SettingsButton />
    </div>
  )
}
