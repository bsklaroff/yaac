import { useState, type JSX, type ReactNode } from 'react'
import { cn } from './cn'
import { identityFamily, identityInitial, identityStyle } from './identity'
import { YShaderTile } from './YShaderTile'
import { YStatus } from './YStatus'

/*
 * A project: its tile (the rail and the cards), and its card on Home.
 */

export interface YProjectTileProps {
  id: string
  name: string
  /** A picture to show instead of the initial. */
  imageUrl?: string
  size?: number
  /** Agents working: the lanes run, faster with more (up to three). */
  agents?: number
  /** Sessions waiting for you: an amber count in the corner. */
  waiting?: number
  /** Something failed: a red "!" in the corner, ahead of a count. */
  failed?: boolean
  /** The project in view: solid fill, and a notch into the sidebar. */
  current?: boolean
  /** Lit by hover or focus. */
  lit?: boolean
  notch?: boolean
  className?: string
}

/**
 * A project's tile. Colour only when something is going on: a quiet
 * project is a softened initial; one that is working, waiting or failed
 * sits on its family's tint; the current or hovered one is solid.
 */
export function YProjectTile({ id, name, imageUrl, size = 38, agents = 0, waiting = 0, failed = false, current = false, lit = false, notch = true, className }: YProjectTileProps): JSX.Element {
  const family = identityFamily(id)
  const solid = current || lit
  const active = solid || agents > 0 || waiting > 0 || failed
  const colours = identityStyle(family, solid)
  // A picture that fails to load falls back to the initial, until the URL changes.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const picture = imageUrl !== undefined && imageUrl !== failedUrl ? imageUrl : undefined
  return (
    <span
      className={cn('relative inline-flex shrink-0 items-center justify-center font-semibold leading-none', className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: active ? colours.background : 'transparent',
        color: active ? colours.color : `var(--proj-${family}-ink)`,
      }}
    >
      {agents > 0 && (
        <span className="absolute inset-0 overflow-hidden">
          <YShaderTile family={family} seedKey={id} size={size} rate={agents} bright={solid} />
        </span>
      )}
      {picture
        ? <img src={picture} alt="" onError={() => setFailedUrl(picture)} className="relative h-[70%] w-[70%] object-contain" />
        : <span className="relative" style={{ opacity: active ? 1 : 0.55 }}>{identityInitial(name)}</span>}
      {current && notch && (
        <span aria-hidden className="absolute -right-px top-1/2 -mt-[5px] h-0 w-0 border-y-[5px] border-r-[5px] border-y-transparent border-r-shell" />
      )}
      {failed ? (
        <span className="absolute right-0 top-0 flex h-[13px] w-[13px] items-center justify-center bg-danger text-xs font-bold leading-none
          text-on-danger">!</span>
      ) : waiting > 0 && (
        <span className="absolute right-0 top-0 flex h-[13px] min-w-[13px] items-center justify-center bg-warning px-[3px] text-xs leading-none
          tabular-nums text-on-warning">{waiting}</span>
      )}
    </span>
  )
}

/** A project on Home: its tile, name and remote, what needs you and what is
 *  working, a week of activity, and its last change and routine. */
export function YProjectCard({ id, name, remote, imageUrl, waiting = 0, working = 0, failed = false, activity, rows, onOpen }: {
  id: string
  name: string
  remote?: ReactNode
  imageUrl?: string
  waiting?: number
  working?: number
  failed?: boolean
  /** Bars for the last days, oldest first. */
  activity?: ReactNode
  /** Label and value lines under the counts ("Last change", "Routine"). */
  rows?: readonly { label: string; value: ReactNode; meta?: ReactNode }[]
  onOpen: () => void
}): JSX.Element {
  return (
    <div className="group/card relative flex flex-col gap-3 rounded-sm p-4 shadow-inset hover:bg-hover">
      <button type="button" aria-label={`Open ${name}`} onClick={onOpen}
        className="absolute inset-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent" />
      <div className="pointer-events-none flex items-center gap-3">
        <YProjectTile id={id} name={name} imageUrl={imageUrl} size={44} agents={working} waiting={waiting} failed={failed} notch={false} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-text">{name}</div>
          {remote && <div className="truncate text-sm text-subtle">{remote}</div>}
        </div>
        {activity}
      </div>
      <div className="pointer-events-none flex items-center gap-4 text-md text-muted">
        {waiting > 0 && <span className="flex items-center gap-1.5"><YStatus kind="need" />{waiting} needs you</span>}
        {working > 0 && <span className="flex items-center gap-1.5"><YStatus kind="work" />{working} working</span>}
        {waiting === 0 && working === 0 && <span className="text-subtle">Nothing running</span>}
      </div>
      {rows && rows.length > 0 && (
        <div className="pointer-events-none flex flex-col gap-1 border-t border-line pt-3 text-md">
          {rows.map((r) => (
            <div key={r.label} className="flex min-w-0 items-baseline gap-3">
              <span className="w-24 shrink-0 text-subtle">{r.label}</span>
              <span className="min-w-0 flex-1 truncate text-text">{r.value}</span>
              {r.meta && <span className="shrink-0 text-subtle">{r.meta}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
