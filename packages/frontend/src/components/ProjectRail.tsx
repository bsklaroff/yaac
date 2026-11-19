import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import clsx from 'clsx'
import { LogoMenu } from '#shell/LogoMenu'
import { api } from '#lib/api'
import { AddIcon, InboxIcon, LoadingIcon, WarningIcon } from '#lib/icons'
import { projectIconUrl } from '#lib/projectIdentity'
import { useUiStore, type ProjectOp } from '#lib/store'
import { usePressDrag } from '#lib/usePressDrag'
import { useTeammateView } from '#lib/viewer'
import type { ProjectSummary } from '@yaac/shared/types'
import {
  identityFamily, identityInitial, identityStyle, YProjectRail, YProjectTile, YRailItem, YTip,
} from '#ui'

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

/** A rail chip's colours: its family's tint, or the solid fill for the
 *  active project. */
export function railChipStyle(id: string, active: boolean): CSSProperties {
  return identityStyle(identityFamily(id), active)
}

/** How a project's tile shows what is going on in it. */
export interface RailTileState {
  /** Workspaces with an agent working. */
  agents: number
  /** Something failed there that the viewer has not seen. */
  failed: boolean
}

/**
 * The rail: Home, the viewed user's projects as tiles, adding a project,
 * and the logo menu at the foot. A tile shows its project's state
 * (`tiles`, plus `attentionByProject` for what waits on the viewer); the
 * current project's is lit, unless Home is open. A project being added or
 * removed (`ops`) shows a spinner, or a warning once its request failed.
 *
 * The user can drag their own tiles with the mouse to reorder them. The
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
  tiles,
  homeActive,
  onHome,
  onSelect,
}: {
  projects: ProjectSummary[]
  ops: ProjectOp[]
  activeProjectId: string | null
  attentionByProject: Record<string, number>
  tiles: Record<string, RailTileState>
  homeActive: boolean
  onHome: () => void
  onSelect: (projectId: string) => void
}): JSX.Element {
  const readOnly = useTeammateView()
  const setAddProjectForm = useUiStore((s) => s.setAddProjectForm)
  const [order, setOrder] = useState<string[] | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const placed = order === null ? projects : inOrder(projects, order)
  const agreed = placed.every((p, i) => p === projects[i])
  useEffect(() => {
    if (agreed) setOrder(null)
  }, [agreed])

  // The drop target is an insertion index into `placed`: how many tiles'
  // midpoints lie above the pointer. Off the rail there is none.
  const rail = useRef<HTMLDivElement>(null)
  const chips = useRef(new Map<string, HTMLElement>())
  const saving = useRef(Promise.resolve())
  const drops = useRef(0)
  // Set while a mouse press is usePressDrag's to settle. The browser still
  // fires a click when the press ends on the tile, which must not select
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
  const anyWaiting = Object.values(attentionByProject).some((n) => n > 0)

  return (
    <YProjectRail
      top={<>
        <YRailItem icon={InboxIcon} label="Home" active={homeActive} dot={anyWaiting} onClick={onHome} />
      </>}
      bottom={<LogoMenu />}
    >
      <div ref={rail} className="flex w-full flex-col">
        {listedProjects(placed, ops).map(({ op, ...p }, i) => {
          const current = p.id === activeProjectId && !homeActive
          const draggable = !readOnly && i < placed.length
          const state = tiles[p.id]
          return (
            <YRailItem
                key={p.id}
                label={p.name}
                tip={<YTip title={p.name} hint={tileHint(state, attentionByProject[p.id] ?? 0)} />}
                active={false}
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
                onPointerEnter={() => setHovered(p.id)}
                onPointerLeave={() => setHovered((h) => (h === p.id ? null : h))}
                aria-current={current || undefined}
                className={clsx('hover:bg-transparent', drag?.item === p.id && 'opacity-40')}
              >
                {(dropAt === i || (dropAt === placed.length && i === placed.length - 1)) && (
                  <span className={clsx('absolute inset-x-0 h-0.5 bg-accent', dropAt === i ? '-top-[3px]' : '-bottom-[3px]')} />
                )}
                {op !== undefined ? (
                  <ProjectChip project={p} op={op} iconSize={16} style={railChipStyle(p.id, false)}
                    className="flex h-11 w-11 items-center justify-center text-base font-semibold" />
                ) : (
                  <YProjectTile
                    id={p.id}
                    name={p.name}
                    {...(p.iconHash !== undefined ? { imageUrl: projectIconUrl(p.id, p.iconHash) } : {})}
                    agents={state?.agents ?? 0}
                    waiting={attentionByProject[p.id] ?? 0}
                    failed={state?.failed ?? false}
                    size={44}
                    current={current}
                    lit={hovered === p.id}
                  />
                )}
            </YRailItem>
          )
        })}
        {!readOnly && <YRailItem icon={AddIcon} label="Add a project" onClick={() => setAddProjectForm({ remoteUrl: '' })} />}
      </div>
    </YProjectRail>
  )
}

/** A tile's tooltip line: what is going on in the project. */
function tileHint(state: RailTileState | undefined, waiting: number): string | undefined {
  const parts = [
    waiting > 0 ? `${waiting} waiting for you` : '',
    state?.failed ? 'something failed' : '',
    state && state.agents > 0 ? `${state.agents} ${state.agents === 1 ? 'agent' : 'agents'} working` : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : undefined
}
