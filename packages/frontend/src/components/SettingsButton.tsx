import { memo, useEffect, useMemo, useState, type FormEvent, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BranchIcon,
  CloseIcon,
  DockerIcon,
  EnvIcon,
  GeneralIcon,
  KeyboardIcon,
  KeyIcon,
  NetworkIcon,
  ProjectConfigIcon,
  SettingsIcon,
  SkillsIcon,
  UsersIcon,
  VolumeIcon,
} from '#lib/icons'
import { api } from '#lib/api'
import { AUTH_LIST_KEY } from '#lib/useAuthList'
import {
  SHORTCUTS, chordFromEvent, chordsEqual, formatChord, isModifierCode, validateChord, type Chord, type ShortcutId,
} from '#lib/shortcuts'
import { deviceTimeZone, timeZoneQuery } from '#lib/time'
import { CredentialsPane } from '#components/settings/Credentials'
import { PhoneLinkField } from '#components/settings/PhoneLink'
import { PROJECT_PAGE_LABEL, ProjectSettings } from '#components/settings/ProjectSettings'
import { ProjectSelect, useSettingsProject } from '#components/settings/ProjectPicker'
import { ReposSettings } from '#components/settings/Repos'
import { SkillsSettings } from '#components/settings/Skills'
import { UsersPane } from '#components/settings/Users'
import { UserImagePane } from '#components/settings/Images'
import { SettingsPageTitle } from '#components/settings/SettingsPage'
import { BuildPage } from '#components/BuildPage'
import { useUiStore, type ProjectPage, type SettingsSection } from '#lib/store'
import type { ThemePref } from '#lib/theme'
import { useSnapshotSelect } from '#lib/useSnapshot'
import { useWhoami } from '#lib/viewer'
import { IS_MAC } from '#lib/platform'
import {
  cn, YButton, YDialog, YDialogClose, YDialogTitle, YInput, YListSection, YPageBody, YSection, YSegmented, YSelect,
  YSettingGroup, YSettingRow, YSwitch,
} from '#ui'

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

type NavIcon = typeof GeneralIcon

const ACCOUNT_SECTIONS: { key: SettingsSection; label: string; Icon: NavIcon }[] = [
  { key: 'general', label: 'General', Icon: GeneralIcon },
  { key: 'shortcuts', label: 'Shortcuts', Icon: KeyboardIcon },
  { key: 'credentials', label: 'Credentials', Icon: KeyIcon },
  { key: 'repos', label: 'Repos', Icon: BranchIcon },
  { key: 'skills', label: 'Skills', Icon: SkillsIcon },
  { key: 'userDockerfile', label: 'User Dockerfile', Icon: DockerIcon },
  { key: 'users', label: 'Users', Icon: UsersIcon },
]

const PROJECT_PAGES: { page: ProjectPage; Icon: NavIcon }[] = [
  { page: 'general', Icon: ProjectConfigIcon },
  { page: 'env', Icon: EnvIcon },
  { page: 'network', Icon: NetworkIcon },
  { page: 'storage', Icon: VolumeIcon },
  { page: 'images', Icon: DockerIcon },
]

/**
 * The mobile project screen's Settings row. The modal itself is
 * `SettingsDialog`, mounted once by the app; its open state lives in the
 * store so any surface (the logo menu, the new-workspace menu's "Sign in")
 * can open it on a given section.
 */
export function SettingsButton(): JSX.Element {
  const openSettings = useUiStore((s) => s.openSettings)
  return (
    <YButton
      variant="bare"
      onClick={() => openSettings()}
      title="Settings"
      className="flex w-full items-center gap-3 px-3 py-3 text-left text-base text-muted active:bg-selected"
    >
      <SettingsIcon size={18} aria-hidden />
      <span>Settings</span>
    </YButton>
  )
}

/**
 * The settings modal: a left nav beside the content pane, in two groups.
 * Account holds what is the user's or the install's; Project holds one
 * project's pages, for the project its picker names.
 */
export const SettingsDialog = memo(function SettingsDialog(): JSX.Element {
  const open = useUiStore((s) => s.settingsOpen)
  const section = useUiStore((s) => s.settingsSection)
  const openSettings = useUiStore((s) => s.openSettings)
  const closeSettings = useUiStore((s) => s.closeSettings)
  const setSection = useUiStore((s) => s.setSettingsSection)
  const themePref = useUiStore((s) => s.themePref)
  const setThemePref = useUiStore((s) => s.setThemePref)
  const soundEnabled = useUiStore((s) => s.soundEnabled)
  const setSoundEnabled = useUiStore((s) => s.setSoundEnabled)
  const queryClient = useQueryClient()
  const buildsImages = useSnapshotSelect((s) => s?.driver) !== 'containerless'
  const multiUser = useWhoami()?.kind === 'tailnet'
  const { projects, selected, pick } = useSettingsProject()

  const navButton = (key: SettingsSection, label: string, Icon: NavIcon): JSX.Element => (
    <YButton
      key={key}
      variant="bare"
      onClick={() => setSection(key)}
      aria-current={section === key || undefined}
      className={cn(
        'flex h-8 w-full shrink-0 items-center gap-2.5 whitespace-nowrap px-2.5 text-left text-md',
        'max-md:h-9 max-md:w-auto',
        section === key ? 'bg-selected text-text' : 'text-muted hover:bg-hover hover:text-text',
      )}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
      {label}
    </YButton>
  )

  // Refetch credentials on open; the CLI may have changed them.
  useEffect(() => {
    if (!open) return
    void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
  }, [open, queryClient])

  // On small screens the nav becomes a scrolling row of chips above the
  // content.
  return (
    <YDialog
      open={open}
      onOpenChange={(next) => { if (next) openSettings(); else closeSettings() }}
      variant="split"
      className="max-md:flex-col"
    >
      <div className="flex w-52 shrink-0 flex-col border-r border-line bg-shell px-1.5 py-2
        max-md:w-full max-md:flex-row max-md:gap-0.5 max-md:overflow-x-auto max-md:border-b max-md:border-r-0">
        <YDialogTitle className="px-2.5 pb-1 pt-1 text-md font-semibold text-text max-md:hidden">
          Settings
        </YDialogTitle>
        <div role="group" aria-label="Account" className="contents">
          <YListSection label="Account" className="max-md:hidden" />
          {ACCOUNT_SECTIONS
            .filter((s) => (s.key !== 'userDockerfile' || buildsImages) && (s.key !== 'users' || multiUser))
            .map(({ key, label, Icon }) => navButton(key, label, Icon))}
        </div>
        <div role="group" aria-label="Project" className="contents">
          <YListSection label="Project" className="max-md:hidden" />
          {selected === undefined ? (
            <p className="px-2.5 text-sm text-subtle max-md:hidden">No projects yet</p>
          ) : <>
            <ProjectSelect
              projects={projects}
              value={selected.id}
              onChange={pick}
              className="mb-1 max-md:mb-0 max-md:ml-2 max-md:h-9 max-md:shrink-0"
            />
            {PROJECT_PAGES.filter((p) => p.page !== 'images' || buildsImages)
              .map(({ page, Icon }) => navButton(`project-${page}`, PROJECT_PAGE_LABEL[page], Icon))}
          </>}
        </div>
      </div>

      {/* The close button sits outside the scroller so it stays put, and
          above it so content scrolled beneath (which may paint in its own
          layer, like a faded disabled button) cannot swallow its clicks.
          Skills fills the pane with its own scrolling list and detail; the
          other sections scroll as one page column. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <YDialogClose render={(
          <YButton
            variant="ghost"
            size="sm"
            icon={CloseIcon}
            aria-label="Close settings"
            className="absolute right-3 top-3 z-10 bg-surface max-md:h-9 max-md:w-9"
          />
        )} />

        {section === 'skills' ? (
          <div className="flex min-h-0 flex-1 flex-col p-6 max-md:p-4 max-md:pt-12"><SkillsSettings /></div>
        ) : (
          <YPageBody className="max-md:pt-12">
            {section === 'general' && <>
              <SettingsPageTitle title="General" />
              <YSection title="Appearance">
                <YSettingGroup>
                  <YSettingRow label="Theme" hint="Follows your system appearance unless you pick one.">
                    <YSegmented options={THEMES} value={themePref} onChange={setThemePref} ariaLabel="Theme" />
                  </YSettingRow>
                  <YSettingRow label="Sounds" hint="Play a chime when a workspace needs your input.">
                    <YSwitch checked={soundEnabled} onCheckedChange={setSoundEnabled} aria-label="Sounds" />
                  </YSettingRow>
                </YSettingGroup>
              </YSection>
              <YSection title="Server">
                <YSettingGroup>
                  <GitIdentityField />
                  <TimeZoneField />
                  <PhoneLinkField />
                </YSettingGroup>
              </YSection>
            </>}

            {section === 'shortcuts' && <ShortcutsPane />}

            {section === 'credentials' && <CredentialsPane />}

            {section === 'repos' && <ReposSettings />}

            {section.startsWith('project-') && <ProjectSettings page={section.slice('project-'.length) as ProjectPage} />}

            {section === 'userDockerfile' && <UserImagePane />}

            {section === 'users' && <UsersPane />}
          </YPageBody>
        )}
      </div>
      {/* A build opened from here stacks on settings, nested in it. */}
      <BuildPage />
    </YDialog>
  )
})

/**
 * View and rebind keyboard shortcuts. Click a row to record; the next unbound
 * chord with a modifier becomes its binding. While recording, the store's
 * `recordingShortcut` flag stops other keydown listeners from also running
 * the command.
 */
function ShortcutsPane(): JSX.Element {
  const bindings = useUiStore((s) => s.bindings)
  const setBinding = useUiStore((s) => s.setBinding)
  const resetBindings = useUiStore((s) => s.resetBindings)
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null)
  const [error, setError] = useState<string | null>(null)
  // null resets every binding.
  const saveBinding = useMutation({
    mutationFn: (b: { id: ShortcutId; chord: Chord } | null) => (b === null
      ? api.shortcuts.reset.$post()
      : api.shortcuts.set.$post({ json: b })),
  })

  useEffect(() => {
    if (!recordingId) return
    const setRecording = useUiStore.getState().setRecordingShortcut
    setRecording(true)
    const onKeyDown = (e: KeyboardEvent): void => {
      // Keep the chord from triggering browser shortcuts. Reserved ones
      // (Ctrl+W, …) never reach the page, so they cannot be recorded.
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') { setRecordingId(null); setError(null); return }
      if (isModifierCode(e.code)) return // still waiting for the non-modifier key
      const chord = chordFromEvent(e)
      const check = validateChord(chord, bindings, recordingId)
      if (!check.ok) { setError(check.reason); return }
      const id = recordingId
      setRecordingId(null)
      setError(null)
      setBinding(id, chord)
      saveBinding.mutate({ id, chord })
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      setRecording(false)
    }
  }, [recordingId, bindings, setBinding, saveBinding.mutate])

  const startRecording = (id: ShortcutId): void => {
    setError(null)
    setRecordingId((cur) => (cur === id ? null : id)) // click the active row again to cancel
  }

  const resetOne = (id: ShortcutId): void => {
    const def = SHORTCUTS.find((s) => s.id === id)
    if (!def) return
    // The default may since have been taken by another command's override.
    const check = validateChord(def.defaultChord, bindings, id)
    if (!check.ok) { setError(check.reason); return }
    setError(null)
    setBinding(id, def.defaultChord)
    saveBinding.mutate({ id, chord: def.defaultChord })
  }

  const resetAll = (): void => {
    setRecordingId(null)
    setError(null)
    resetBindings()
    saveBinding.mutate(null)
  }

  return (
    <>
      {/* Title only: the dialog's close button owns the top-right corner,
          so "Reset all" goes in a footer. */}
      <SettingsPageTitle title="Shortcuts">
        Click a shortcut, then press a new key combination (hold Alt, Ctrl, or Cmd).
        Some chords the browser reserves — like Ctrl+W — can’t be captured.
        {error && <p className="mt-2 text-danger">{error}</p>}
        {saveBinding.error && <p className="mt-2 text-danger">Not saved: {saveBinding.error.message}</p>}
      </SettingsPageTitle>

      <YSettingGroup>
        {SHORTCUTS.map((def) => {
          const chord = bindings[def.id]
          const overridden = !chordsEqual(chord, def.defaultChord)
          const recording = recordingId === def.id
          return (
            <YSettingRow key={def.id} label={def.label} hint={def.description}>
              <div className="flex items-center gap-1.5">
                {overridden && !recording && (
                  <YButton variant="secondary" size="sm" onClick={() => resetOne(def.id)} title="Reset to default">
                    Reset
                  </YButton>
                )}
                <YButton
                  onClick={() => startRecording(def.id)}
                  className={cn('min-w-[88px] font-mono text-md', recording && 'text-accent outline outline-accent')}
                >
                  {recording ? 'Press…' : formatChord(chord, IS_MAC)}
                </YButton>
              </div>
            </YSettingRow>
          )
        })}
      </YSettingGroup>

      <YButton size="sm" onClick={resetAll} className="self-start">
        Reset all to defaults
      </YButton>
    </>
  )
}

/**
 * The git identity this server's workspaces commit under. It is a server
 * setting because the server's host may have no git config (a k8s pod) or
 * someone else's (a remote install). `yaac auth update` and the desktop app
 * seed it from your machine's git config, so it is usually already set.
 */
function GitIdentityField(): JSX.Element {
  const [name, setName] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const { data: identity, error: loadError } = useQuery({
    queryKey: ['git-identity'],
    queryFn: async () => (await api.config['git-identity'].$get()).identity,
    staleTime: 0,
  })
  const save = useMutation({
    mutationFn: async (v: { name: string; email: string }) => (await api.config['git-identity'].$put({ json: v })).identity,
    onSuccess: (saved) => {
      queryClient.setQueryData(['git-identity'], saved)
      setName(null)
      setEmail(null)
    },
  })
  // The fields show the stored identity until edited.
  const shownName = name ?? identity?.name ?? ''
  const shownEmail = email ?? identity?.email ?? ''
  const error = save.error ?? loadError
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    save.mutate({ name: shownName.trim(), email: shownEmail.trim() })
  }

  return (
    <YSettingRow
      stacked
      label="Git identity"
      hint={identity === null
        ? 'Not set — workspaces cannot be created until it is. The yaac desktop '
          + 'app and `yaac auth update` fill this in from your machine\'s git config.'
        : 'What workspaces on this server commit as.'}
    >
      <form onSubmit={submit}>
        <div className="flex gap-2">
          <YInput
            value={shownName}
            onChange={(e) => { setName(e.target.value); save.reset() }}
            placeholder="Your Name"
            className="flex-1 font-mono"
          />
          <YInput
            value={shownEmail}
            onChange={(e) => { setEmail(e.target.value); save.reset() }}
            placeholder="you@example.com"
            className="flex-1 font-mono"
          />
          <YButton type="submit" disabled={save.isPending || shownName.trim() === '' || shownEmail.trim() === ''}>
            {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved' : 'Save'}
          </YButton>
        </div>
        {error && <p className="mt-2 text-md text-danger">{error.message}</p>}
      </form>
    </YSettingRow>
  )
}

/**
 * The time zone this server's workspaces launch with, and chat panes show
 * times in (`useTimeZone`). Automatic follows the device that last opened
 * the web app or the desktop app, or created a workspace from the CLI, and
 * a pane shows times in the zone of the device it is on; picking a zone
 * here pins both.
 */
function TimeZoneField(): JSX.Element {
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), [])
  const queryClient = useQueryClient()
  const { data: setting, error: loadError } = useQuery({ ...timeZoneQuery, staleTime: 0 })
  /** '' is Automatic: report this device's zone and unpin. */
  const choose = useMutation({
    mutationFn: (value: string) => api.config['time-zone'].$put({
      json: { timeZone: value === '' ? deviceTimeZone() : value, pinned: value !== '' },
    }),
    onSuccess: (saved) => queryClient.setQueryData(timeZoneQuery.queryKey, saved),
  })
  const error = choose.error ?? loadError

  // Unpinned, the stored zone is the last device's, which may not be this one.
  const automatic = setting?.pinned === false && setting.timeZone ? setting.timeZone : deviceTimeZone()

  return (
    <YSettingRow
      label="Time zone"
      hint="For new workspaces and chat times."
    >
      <YSelect
        aria-label="Time zone"
        value={setting?.pinned ? setting.timeZone ?? '' : ''}
        disabled={setting === undefined}
        onChange={(e) => choose.mutate(e.target.value)}
        className="w-60 max-md:w-full"
      >
        <option value="">Automatic ({automatic})</option>
        {zones.map((z) => <option key={z} value={z}>{z}</option>)}
      </YSelect>
      {error && <p className="mt-2 w-60 text-md text-danger">{error.message}</p>}
    </YSettingRow>
  )
}
