import { useEffect, useMemo, useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@base-ui/react/dialog'
import { Modal } from '#components/ui/Modal'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import {
  CloseIcon,
  DockerIcon,
  GeneralIcon,
  KeyboardIcon,
  KeyIcon,
  ProjectConfigIcon,
  ServerIcon,
  SettingsIcon,
} from '#lib/icons'
import { api } from '#lib/api'
import { AUTH_LIST_KEY } from '#lib/useAuthList'
import {
  SHORTCUTS, chordFromEvent, chordsEqual, formatChord, isModifierCode, validateChord, type Chord, type ShortcutId,
} from '#lib/shortcuts'
import { deviceTimeZone } from '#lib/time'
import { CredentialsPane } from '#components/settings/Credentials'
import { Field } from '#components/settings/Field'
import { ProjectSettings } from '#components/settings/ProjectSettings'
import { ServerSettings } from '#components/settings/ServerSettings'
import { serverBridge } from '#lib/desktopServer'
import { FileEditor } from '#components/settings/FileEditor'
import { BuildFiles } from '#components/settings/BuildFiles'
import { userBuildFilesApi } from '#lib/buildFilesApi'
import { useUiStore, type SettingsSection } from '#lib/store'
import type { ThemePref } from '#lib/theme'
import { useSnapshot } from '#lib/useSnapshot'
import { IS_MAC } from '#lib/platform'

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const SECTIONS: { key: SettingsSection; label: string; Icon: typeof GeneralIcon }[] = [
  { key: 'general', label: 'General', Icon: GeneralIcon },
  { key: 'server', label: 'Server', Icon: ServerIcon },
  { key: 'shortcuts', label: 'Shortcuts', Icon: KeyboardIcon },
  { key: 'credentials', label: 'Credentials', Icon: KeyIcon },
  { key: 'project', label: 'Project Config', Icon: ProjectConfigIcon },
  { key: 'userDockerfile', label: 'User Dockerfile', Icon: DockerIcon },
]

/**
 * The nav sections this environment can use. The server section needs the
 * desktop shell (it switches servers); the user Dockerfile needs a server
 * that builds images.
 */
function visibleSections(buildsImages: boolean): typeof SECTIONS {
  return SECTIONS.filter((s) =>
    (s.key !== 'server' || serverBridge())
    && (s.key !== 'userDockerfile' || buildsImages))
}

/**
 * The settings button and its modal: a left nav of sections beside a
 * scrollable content pane. Open state lives in the store so other surfaces
 * (e.g. the new-workspace menu's "Sign in") can open it on a given section.
 */
export function SettingsButton(
  /** 'rail' is the desktop rail's 40px chip; 'row' is the mobile project
   *  screen's full-width labelled row. */
  { variant = 'rail' }: { variant?: 'rail' | 'row' } = {},
): JSX.Element {
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
  const buildsImages = useSnapshot()?.driver !== 'containerless'

  // Refetch credentials on open; the CLI may have changed them.
  useEffect(() => {
    if (!open) return
    void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
  }, [open, queryClient])

  return (
    <>
      <button
        onClick={() => openSettings()}
        title="Settings"
        className={variant === 'row'
          ? 'flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-text-dim transition '
            + 'active:bg-surface-2'
          : 'flex h-10 w-10 items-center justify-center rounded-[20px] text-text-faint transition-all '
            + 'hover:rounded-xl hover:text-text-dim'}
      >
        <SettingsIcon size={18} />
        {variant === 'row' && <span>Settings</span>}
      </button>

      {/* On small screens the dialog goes full-screen and the nav becomes
          a scrolling row of chips above the content. */}
      <Modal
        open={open}
        onOpenChange={(next) => { if (next) openSettings(); else closeSettings() }}
        className="flex h-[480px] w-[720px] max-md:flex-col"
      >
        <div className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-hairline-soft bg-bg/50 p-2
          max-md:w-full max-md:flex-row max-md:overflow-x-auto max-md:border-b max-md:border-r-0">
          <Dialog.Title className="px-2 pb-2 pt-1 text-xs font-semibold text-text-dim max-md:hidden">
            Settings
          </Dialog.Title>
          {visibleSections(buildsImages).map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setSection(key)}
              className={clsx(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition',
                'max-md:h-9 max-md:shrink-0 max-md:whitespace-nowrap',
                section === key
                  ? 'bg-surface-2 font-medium text-text'
                  : 'text-text-dim hover:bg-surface-2/60 hover:text-text',
              )}
            >
              <Icon size={13} className="shrink-0" />
              {label}
            </button>
          ))}
        </div>

        <div className="relative min-w-0 flex-1 overflow-y-auto p-6 max-md:p-4 max-md:pt-10">
          <Dialog.Close className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded
            text-text-faint transition hover:bg-surface-2 hover:text-text max-md:h-9 max-md:w-9"
            aria-label="Close settings">
            <CloseIcon size={14} />
          </Dialog.Close>

          {section === 'general' && (
            <section>
              <h2 className="text-sm font-semibold">General</h2>
              <Field
                label="Theme"
                hint="Follows your system appearance unless you pick one."
              >
                <RadioGroup
                  value={themePref}
                  onValueChange={(value) => setThemePref(value as ThemePref)}
                  className="flex flex-col gap-1"
                >
                  {THEMES.map((t) => (
                    <label
                      key={t.value}
                      className="flex w-fit cursor-default items-center gap-2.5 rounded-md py-1 pr-2 text-xs
                        text-text-dim transition hover:text-text"
                    >
                      <Radio.Root
                        value={t.value}
                        className="flex h-4 w-4 items-center justify-center rounded-full border border-border-strong
                          transition data-[checked]:border-accent data-[checked]:bg-accent"
                      >
                        <Radio.Indicator className="h-1.5 w-1.5 rounded-full bg-surface data-[unchecked]:hidden" />
                      </Radio.Root>
                      {t.label}
                    </label>
                  ))}
                </RadioGroup>
              </Field>
              <Field
                label="Sounds"
                hint="Play a chime when a workspace needs your input."
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={soundEnabled}
                  aria-label="Sounds"
                  onClick={() => setSoundEnabled(!soundEnabled)}
                  className={clsx(
                    'relative flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                    soundEnabled ? 'bg-accent' : 'bg-surface-3',
                  )}
                >
                  <span
                    className={clsx(
                      'h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                      soundEnabled ? 'translate-x-[18px]' : 'translate-x-0.5',
                    )}
                  />
                </button>
              </Field>
              <GitIdentityField />
              <TimeZoneField />
            </section>
          )}

          {section === 'server' && <ServerSettings />}

          {section === 'shortcuts' && <ShortcutsPane />}

          {section === 'credentials' && <CredentialsPane />}

          {section === 'project' && <ProjectSettings />}

          {section === 'userDockerfile' && <UserDockerfilePane />}
        </div>
      </Modal>
    </>
  )
}

/**
 * The global user image layer: the Dockerfile.user editor plus the support
 * files sharing its build dir (the layer's whole build context).
 */
function UserDockerfilePane(): JSX.Element {
  const filesApi = useMemo(() => userBuildFilesApi(), [])
  return (
    <section>
      <h2 className="text-sm font-semibold">User Dockerfile</h2>
      <Field
        label="Dockerfile.user"
        hint={(
          <>
            Layered atop every project image. Must start with{' '}
            <code className="text-text-dim">{'ARG BASE_IMAGE'}</code> and{' '}
            <code className="text-text-dim">{'FROM ${BASE_IMAGE}'}</code>.
          </>
        )}
      >
        <FileEditor
          title="Dockerfile.user"
          language="dockerfile"
          queryKey={['user-dockerfile']}
          load={async () => (await api.config['user-dockerfile'].$get()).content}
          save={async (content) => { await api.config['user-dockerfile'].$put({ json: { content } }) }}
        />
      </Field>
      <Field
        label="Build files"
        hint={(
          <>
            Files stored next to Dockerfile.user as its build context — reference them
            with <code className="text-text-dim">COPY</code>. Changes apply on the next
            workspace create.
          </>
        )}
      >
        <BuildFiles filesApi={filesApi} title="Dockerfile.user" />
      </Field>
    </section>
  )
}

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
    <section>
      {/* Title only: the dialog's close button owns the top-right corner,
          so "Reset all" goes in a footer. */}
      <h2 className="text-sm font-semibold">Shortcuts</h2>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Click a shortcut, then press a new key combination (hold Alt, Ctrl, or Cmd).
        Some chords the browser reserves — like Ctrl+W — can’t be captured.
      </p>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {saveBinding.error && (
        <p className="mt-2 text-xs text-red-400">Not saved: {saveBinding.error.message}</p>
      )}

      <div className="mt-4 space-y-1">
        {SHORTCUTS.map((def) => {
          const chord = bindings[def.id]
          const overridden = !chordsEqual(chord, def.defaultChord)
          const recording = recordingId === def.id
          return (
            <div key={def.id} className="flex items-center justify-between gap-3 rounded-md bg-bg px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs font-medium text-text">{def.label}</div>
                <div className="truncate text-[11px] text-text-faint">{def.description}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {overridden && !recording && (
                  <button
                    onClick={() => resetOne(def.id)}
                    title="Reset to default"
                    className="rounded px-1.5 py-0.5 text-[11px] text-text-faint transition hover:text-text"
                  >
                    Reset
                  </button>
                )}
                <button
                  onClick={() => startRecording(def.id)}
                  className={clsx(
                    'min-w-[88px] rounded-md border px-2.5 py-1 text-center font-mono text-xs transition',
                    recording
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border bg-surface-2 text-text-dim hover:border-border-strong hover:text-text',
                  )}
                >
                  {recording ? 'Press…' : formatChord(chord, IS_MAC)}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <button
        onClick={resetAll}
        className="mt-4 rounded-md border border-border px-2.5 py-1 text-[11px] text-text-faint transition
          hover:border-border-strong hover:text-text"
      >
        Reset all to defaults
      </button>
    </section>
  )
}

/**
 * The git identity this server's workspaces commit under. It is a server
 * setting because the server's host may have no git config (a k8s pod) or
 * someone else's (a remote install). The CLI and auth daemon seed it from
 * your machine's git config on first contact, so it is usually already set.
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

  const inputClass = 'flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono '
    + 'text-xs text-text outline-none focus:border-border-strong'

  return (
    <Field
      label="Git identity"
      hint={identity === null
        ? 'Not set — workspaces cannot be created until it is. The yaac CLI and '
          + 'the auth server fill this in from your machine\'s git config.'
        : 'What workspaces on this server commit as.'}
    >
      <form onSubmit={submit}>
        <div className="flex gap-2">
          <input
            value={shownName}
            onChange={(e) => { setName(e.target.value); save.reset() }}
            placeholder="Your Name"
            className={inputClass}
          />
          <input
            value={shownEmail}
            onChange={(e) => { setEmail(e.target.value); save.reset() }}
            placeholder="you@example.com"
            className={inputClass}
          />
          <button
            type="submit"
            disabled={save.isPending || shownName.trim() === '' || shownEmail.trim() === ''}
            className="shrink-0 rounded-md bg-surface-3 px-3 text-xs font-medium text-text transition
              hover:bg-border-strong disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved' : 'Save'}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error.message}</p>}
      </form>
    </Field>
  )
}

/**
 * The time zone this server's workspaces launch with. Automatic follows the
 * device that last opened the web app, started the auth server or created a
 * workspace from the CLI; picking a zone here pins it.
 */
function TimeZoneField(): JSX.Element {
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), [])
  const queryClient = useQueryClient()
  const { data: setting, error: loadError } = useQuery({
    queryKey: ['time-zone'],
    queryFn: () => api.config['time-zone'].$get(),
    staleTime: 0,
  })
  /** '' is Automatic: report this device's zone and unpin. */
  const choose = useMutation({
    mutationFn: (value: string) => api.config['time-zone'].$put({
      json: { timeZone: value === '' ? deviceTimeZone() : value, pinned: value !== '' },
    }),
    onSuccess: (saved) => queryClient.setQueryData(['time-zone'], saved),
  })
  const error = choose.error ?? loadError

  // Unpinned, the stored zone is the last device's, which may not be this one.
  const automatic = setting?.pinned === false && setting.timeZone ? setting.timeZone : deviceTimeZone()

  return (
    <Field
      label="Time zone"
      hint={'The zone new workspaces launch in. Automatic follows whichever device last '
        + 'connected, so it changes as you switch between machines in different zones; '
        + 'pick a zone to pin it. A running workspace keeps the zone it started with.'}
    >
      <>
        <select
          aria-label="Time zone"
          value={setting?.pinned ? setting.timeZone ?? '' : ''}
          disabled={setting === undefined}
          onChange={(e) => choose.mutate(e.target.value)}
          className="rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text
            outline-none focus:border-border-strong disabled:opacity-50"
        >
          <option value="">Automatic ({automatic})</option>
          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
        {error && <p className="mt-2 text-xs text-red-400">{error.message}</p>}
      </>
    </Field>
  )
}
