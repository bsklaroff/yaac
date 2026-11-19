import { useState, type JSX } from 'react'
import { FeedbackDialog } from '#components/FeedbackButton'
import { serverLabel } from '#components/ServerBadge'
import { ServerHealthOverlay } from '#components/ServerHealthOverlay'
import { UserItems, useUserSwitch } from '#components/UserSwitcher'
import { FeedbackIcon, HealthIcon, ServerIcon, SettingsIcon, UsersIcon } from '#lib/icons'
import { windowApi } from '#lib/platform'
import { useUiStore } from '#lib/store'
import { useSnapshot } from '#lib/useSnapshot'
import { useTeammateName, useWhoami } from '#lib/viewer'
import { cn, YAvatar, YLogoMark, YMenu, YMenuItem, YMenuPopup } from '#ui'

/*
 * The logo at the foot of the rail, and its menu: who you are and which
 * server, settings, the server's health and the desktop app's server list,
 * feedback, and on a shared server whose projects to view. While a
 * teammate's projects are shown, the logo sits on the accent tint and its
 * label names them, so the read-only view is never unexplained.
 */
export function LogoMenu(): JSX.Element {
  const whoami = useWhoami()
  const snapshot = useSnapshot()
  const openSettings = useUiStore((s) => s.openSettings)
  const switcher = useUserSwitch()
  const showServers = windowApi()?.showServers
  const [health, setHealth] = useState(false)
  const [feedback, setFeedback] = useState(false)
  const me = whoami?.users.find((u) => u.id === whoami.userId)
  const name = me?.name ?? 'You'
  const teammate = useTeammateName()
  return (
    <>
      <YMenu.Root>
        <YMenu.Trigger
          aria-label={teammate !== undefined ? `yaac menu, viewing ${teammate}'s projects` : 'yaac menu'}
          title={teammate !== undefined ? `Viewing ${teammate}'s projects` : undefined}
          className={cn('flex h-11 w-11 items-center justify-center outline-none hover:bg-hover',
            'focus-visible:outline-2 focus-visible:outline-accent data-[popup-open]:bg-selected', teammate !== undefined && 'bg-accent-soft')}
        >
          <YLogoMark height={20} colour />
        </YMenu.Trigger>
        <YMenuPopup side="right" align="end" sideOffset={8} className="w-60">
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <YAvatar id={whoami?.userId ?? 'me'} name={name} size={26} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-md font-semibold text-text">{name}</span>
              <span className="truncate text-sm text-subtle">{serverLabel(window.location.origin)}</span>
            </span>
          </div>
          <YMenuItem icon={SettingsIcon} onClick={() => openSettings()}>Settings</YMenuItem>
          <YMenuItem icon={HealthIcon} onClick={() => setHealth(true)}>Server health</YMenuItem>
          {showServers && (
            <YMenuItem icon={ServerIcon} onClick={() => useUiStore.getState().navigate(showServers)}>Servers</YMenuItem>
          )}
          {snapshot?.feedbackHost != null && (
            <YMenuItem icon={FeedbackIcon} onClick={() => setFeedback(true)}>Send feedback</YMenuItem>
          )}
          {switcher !== null && (
            <YMenu.SubmenuRoot onOpenChange={(open) => { if (open) switcher.refresh() }}>
              <YMenu.SubmenuTrigger className="flex min-h-7 w-full cursor-default select-none items-center gap-2 rounded-xs
                px-2.5 py-1 text-md text-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-text
                data-[popup-open]:bg-hover">
                <UsersIcon size={14} strokeWidth={1.75} aria-hidden />
                <span className="flex-1">{switcher.label}</span>
              </YMenu.SubmenuTrigger>
              <YMenuPopup side="right" align="start" className="w-72">
                <UserItems switcher={switcher} />
              </YMenuPopup>
            </YMenu.SubmenuRoot>
          )}
        </YMenuPopup>
      </YMenu.Root>
      <ServerHealthOverlay open={health} onOpenChange={setHealth} />
      <FeedbackDialog open={feedback} onOpenChange={setFeedback} />
    </>
  )
}
