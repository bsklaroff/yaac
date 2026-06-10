import { useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { Collapsible } from '@base-ui/react/collapsible'
import { ChevronIcon, SidebarIcon } from '@/frontend/lib/icons'
import { BarIconButton } from '@/frontend/components/ui/WorkspaceBar'
import { useUiStore } from '@/frontend/store'

/**
 * Shared chrome for the flush base-layer sidebars (the Build tab's session
 * list and the Plan tab's doc list). One source of truth for the shell,
 * header strip, group triggers, and row treatment so the two can't drift.
 */

export function SidebarShell({ children }: { children: ReactNode }): JSX.Element {
  return <aside className="flex h-full w-64 flex-col text-text">{children}</aside>
}

/** The strip at the top ("Sessions" / "Plans" + action icons). The collapse
 *  toggle lives here — in the sidebar itself — while open; the workspace bar
 *  only shows a toggle when the sidebar is closed. Same height (and leading
 *  padding) as the WorkspaceBar so the toggle doesn't move when the sidebar
 *  opens or closes. */
export function SidebarHeader({ children }: { children: ReactNode }): JSX.Element {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 pl-2 pr-2">
      <BarIconButton title="Close sidebar" onClick={toggleSidebar}>
        <SidebarIcon size={14} />
      </BarIconButton>
      {children}
    </div>
  )
}

/** Sidebar section title — identical across tabs so the headers can't
 *  drift apart in weight or size. */
export function SidebarTitle({ children }: { children: ReactNode }): JSX.Element {
  return <span className="truncate text-sm font-medium">{children}</span>
}

export function SidebarBody({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex-1 overflow-y-auto py-1">{children}</div>
}

/** Collapsible row group with the chevron + label + count trigger. Controlled
 *  when `open`/`onOpenChange` are given; otherwise self-managed. */
export function SidebarGroup({
  label,
  count,
  defaultOpen = true,
  open,
  onOpenChange,
  children,
}: {
  label: string
  count: number
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}): JSX.Element {
  const [selfOpen, setSelfOpen] = useState(defaultOpen)
  const isOpen = open ?? selfOpen
  const setOpen = onOpenChange ?? setSelfOpen
  return (
    <Collapsible.Root open={isOpen} onOpenChange={setOpen} className="py-1">
      <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium
        text-text-faint outline-none transition hover:text-text-dim">
        <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', isOpen && 'rotate-90')} />
        <span>{label}</span>
        <span className="text-text-faint/70">{count}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel>{children}</Collapsible.Panel>
    </Collapsible.Root>
  )
}

/**
 * One sidebar row. Interactive (button) when `onClick` is given, otherwise
 * a static div (e.g. the provisioning placeholder). `selected` applies the
 * persistent highlight.
 */
export function SidebarRow({
  selected = false,
  onClick,
  title,
  className,
  children,
}: {
  selected?: boolean
  onClick?: () => void
  title?: string
  className?: string
  children: ReactNode
}): JSX.Element {
  const base = clsx(
    'mx-2 flex w-[calc(100%-1rem)] rounded-lg px-2.5 py-2 text-left text-sm',
    onClick && 'transition hover:bg-surface-2/60',
    selected && 'bg-surface-2 hover:bg-surface-2',
    className,
  )
  if (!onClick) return <div className={base}>{children}</div>
  return (
    <button onClick={onClick} title={title} className={base}>
      {children}
    </button>
  )
}

export function SidebarEmpty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="px-4 py-2 text-sm text-text-faint">{children}</div>
}
