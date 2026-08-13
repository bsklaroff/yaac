import { create } from 'zustand'
import { addColumn, isWorkspace, singleColumn, withActive, type Workspace } from '#lib/layout'
import { PREVIEW_TARGET } from '#lib/preview'
import { CHANGES_TARGET } from '#lib/changesApi'
import { DEFAULT_BINDINGS, type BindingMap, type Chord, type ShortcutId } from '#lib/shortcuts'
import { applyThemeAttribute, loadThemePref, persistThemePref, type ThemePref } from '#lib/theme'
import type { AgentTool, StoppedWorktreeEntry, ProvisioningWorktreeEntry, WorktreeListEntry } from '@yaac/shared/types'

const LAYOUTS_LS_KEY = 'yaac.layouts.v2'
const VIEWMODE_LS_KEY = 'yaac.viewmode.v1'
const SELECTION_LS_KEY = 'yaac.selection.v1'
const READ_WAITING_LS_KEY = 'yaac.readwaiting.v1'
const PINNED_USAGE_LS_KEY = 'yaac.pinnedusage.v1'
const SOUND_LS_KEY = 'yaac.sound.v1'
const CHAT_DRAFTS_LS_KEY = 'yaac.chatdrafts.v1'
const MOBILE_SCREEN_LS_KEY = 'yaac.mobilescreen.v1'
const AUTO_APPROVE_LS_KEY = 'yaac.autoapprove.v1'
const SIDEBAR_WIDTH_LS_KEY = 'yaac.sidebarwidth.v1'

/** Desktop worktree-sidebar width, in px: the drag handle's resting place and
 *  the bounds it may be dragged between. The floor keeps a row's name and its
 *  chits legible; the ceiling keeps the pane the larger half on a laptop. */
export const DEFAULT_SIDEBAR_WIDTH = 256
export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 640

/** Hold a dragged/restored width inside the bounds (exported for tests). */
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_SIDEBAR_WIDTH
  return Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, px)))
}

/** Persisted sidebar width, falling back to the default when unset or
 *  unparseable (exported for tests). */
export function loadSidebarWidth(): number {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_LS_KEY)
      if (raw !== null && raw.trim() !== '') {
        const px = Number(raw)
        if (Number.isFinite(px)) return clampSidebarWidth(px)
      }
    }
  } catch { /* fall through to the default */ }
  return DEFAULT_SIDEBAR_WIDTH
}

/** Persist the sidebar width; best-effort (exported for tests). */
export function persistSidebarWidth(px: number): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SIDEBAR_WIDTH_LS_KEY, String(px))
  } catch { /* non-fatal — the width just won't stick */ }
}

/** Whether the attention chime plays; defaults on (exported for tests). */
export function loadSoundEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(SOUND_LS_KEY) !== '0'
  } catch { /* fall through to the default */ }
  return true
}

/** Persist the sound preference; best-effort (exported for tests). */
export function persistSoundEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SOUND_LS_KEY, enabled ? '1' : '0')
  } catch { /* non-fatal */ }
}

/**
 * Whether the new-worktree popover's "yolo mode" box starts checked.
 *
 * Remembered across creates because it is a working style rather than a
 * per-worktree decision — someone who wants their agents to act freely wants
 * that every time, and someone who does not wants the opposite every time.
 * `undefined` means they have never touched it, and the caller falls back to
 * the server's default for its driver: on where the worktree is sandboxed,
 * off where the agent's reach is the whole machine.
 */
export function loadAutoApprovePref(): boolean | undefined {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(AUTO_APPROVE_LS_KEY)
      if (raw === '1') return true
      if (raw === '0') return false
    }
  } catch { /* fall through to "never chosen" */ }
  return undefined
}

/** Remember the last "yolo mode" choice; best-effort. */
export function persistAutoApprovePref(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AUTO_APPROVE_LS_KEY, enabled ? '1' : '0')
    }
  } catch { /* non-fatal */ }
}

/**
 * Which of the three mobile screens is showing. Below the mobile breakpoint
 * the desktop's rail / sidebar / pane columns become full-screen views the
 * user moves between; above it this is inert and nothing reads it.
 *
 * Deliberately explicit rather than derived from
 * `activeProjectSlug`/`selectedWorktreeId`, which it looks like it could be:
 * App auto-selects a worktree as soon as a project has one, so a derived
 * screen would jump straight past the worktree list on every project tap.
 *
 * Navigation follows user *intent* instead, which means each change has two
 * actions: the one a tap goes through moves the screen (`setActiveProject`,
 * `selectWorktree`, `openWorktree`) and the one the app's own effects go
 * through does not (`restoreActiveProject`, `autoSelectWorktree`).
 */
export type MobileScreen = 'projects' | 'worktrees' | 'pane'

/**
 * Read the persisted mobile screen, so a reload on a phone comes back to the
 * view it left (exported for tests).
 *
 * With nothing persisted, a `?worktree=` in the URL means this is a shared
 * link being opened somewhere for the first time — the sender pointed at a
 * worktree, so open it. The two conditions have to be taken together:
 * persistSelection mirrors the selection into the URL on every change, so
 * after any use the param is always there and on its own it would drag every
 * reload back to the pane.
 */
export function loadMobileScreen(): MobileScreen {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(MOBILE_SCREEN_LS_KEY)
      if (raw === 'projects' || raw === 'worktrees' || raw === 'pane') return raw
    }
  } catch { /* fall through — treat as never visited */ }
  try {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      if (params.get('worktree')) return 'pane'
      if (params.get('project')) return 'worktrees'
    }
  } catch { /* fall through to the default */ }
  return 'projects'
}

/** Persist the mobile screen; best-effort (exported for tests). */
export function persistMobileScreen(screen: MobileScreen): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(MOBILE_SCREEN_LS_KEY, screen)
  } catch { /* non-fatal */ }
}

/** How the workspace renders its terminals: a tiling window manager, or
 *  one-at-a-time tabs (better on small screens). */
export type ViewMode = 'tiles' | 'tabs'

/** Persisted view mode; first-run default keys off the viewport width
 *  (exported for tests). */
export function loadViewMode(viewportWidth?: number): ViewMode {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(VIEWMODE_LS_KEY)
      if (raw === 'tiles' || raw === 'tabs') return raw
    }
  } catch { /* fall through to the default */ }
  const width = viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1440)
  return width < 1024 ? 'tabs' : 'tiles'
}

function persistViewMode(mode: ViewMode): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(VIEWMODE_LS_KEY, mode)
  } catch { /* non-fatal */ }
}

/** The project + worktree the workspace is currently viewing — persisted so a
 *  reload, or a shared/bookmarked link, reopens the same view. */
export interface PersistedSelection {
  projectSlug: string | null
  worktreeId: string | null
}

/**
 * Read the persisted selection. The URL query wins over localStorage — a
 * shared `?project=…&worktree=…` link should override the last local view —
 * with localStorage as the fallback for a bare reload. The worktree is only a
 * hint: App drops it if that worktree is no longer active. Exported for tests.
 */
export function loadSelection(): PersistedSelection {
  try {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const projectSlug = params.get('project')
      if (projectSlug) return { projectSlug, worktreeId: params.get('worktree') }
    }
  } catch { /* fall through to localStorage */ }
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(SELECTION_LS_KEY)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          const p = parsed as Record<string, unknown>
          return {
            projectSlug: typeof p.projectSlug === 'string' ? p.projectSlug : null,
            worktreeId: typeof p.worktreeId === 'string' ? p.worktreeId : null,
          }
        }
      }
    }
  } catch { /* fall through to the empty default */ }
  return { projectSlug: null, worktreeId: null }
}

/**
 * Persist the selection to localStorage and mirror it into the URL bar as
 * `?project=&worktree=` query params (replaceState — no navigation; unrelated
 * params like `token` are preserved). The SPA is served only at `/`, so
 * query params (not a path) keep deep links working on a hard reload.
 * Best-effort. Exported for tests.
 */
export function persistSelection(projectSlug: string | null, worktreeId: string | null): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SELECTION_LS_KEY, JSON.stringify({ projectSlug, worktreeId }))
    }
  } catch { /* quota/serialization failures are non-fatal */ }
  try {
    if (typeof window !== 'undefined' && window.history) {
      const url = new URL(window.location.href)
      if (projectSlug) url.searchParams.set('project', projectSlug)
      else url.searchParams.delete('project')
      if (worktreeId) url.searchParams.set('worktree', worktreeId)
      else url.searchParams.delete('worktree')
      // Keep whatever state the current entry carries — the mobile shell
      // stamps its screen there, and replacing it with {} would blank the
      // entry the back button reads on the way out.
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    }
  } catch { /* history failures are non-fatal */ }
}

/** Read the persisted pinned plan-usage metric key (a UsageBadge
 *  `metricKey`), null when nothing is pinned (exported for tests). */
export function loadPinnedUsageMetric(): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(PINNED_USAGE_LS_KEY)
      if (raw) return raw
    }
  } catch { /* fall through to the default */ }
  return null
}

/** Persist the pinned plan-usage metric key (null clears the pin);
 *  best-effort (exported for tests). */
export function persistPinnedUsageMetric(key: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (key) localStorage.setItem(PINNED_USAGE_LS_KEY, key)
    else localStorage.removeItem(PINNED_USAGE_LS_KEY)
  } catch { /* non-fatal — the pin just won't stick */ }
}

/** Read persisted workspace layouts, dropping anything structurally
 *  invalid (exported for tests). */
export function loadPersistedLayouts(): Record<string, Workspace | null> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(LAYOUTS_LS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, Workspace | null> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || isWorkspace(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Read persisted read-waiting marks (worktreeId → waitingSinceMs of the spell
 *  that was viewed), dropping anything that isn't a number (exported for
 *  tests). Stale marks are pruned against the first snapshot by
 *  syncWaitingRead. */
export function loadReadWaiting(): Record<string, number> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(READ_WAITING_LS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Persist read-waiting marks; best-effort (exported for tests). */
export function persistReadWaiting(marks: Record<string, number>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(READ_WAITING_LS_KEY, JSON.stringify(marks))
  } catch {
    // quota/serialization failures are non-fatal — marks just won't stick
  }
}

/** Key a chat pane's draft by its conversation: a worktree can run several ACP
 *  sessions at once, each its own pane with its own half-typed message. Same
 *  `id|target` shape WorktreeView keys its mounted panes with (neither id
 *  contains a pipe). */
export function chatDraftKey(worktreeId: string, agentSessionId: string): string {
  return `${worktreeId}|${agentSessionId}`
}

/**
 * One chat pane's input box, as it survives the pane.
 *
 * `sent` is the exact text this box last handed to the socket without seeing
 * the server's echo. It is what makes "is the box holding a message that was
 * already delivered?" an identity question rather than a guess: the pane can
 * ask whether the text it restored is *the one it sent*, instead of whether it
 * merely reads like the last thing the conversation heard — which a user
 * retyping "ok" would too.
 */
export interface ChatDraft {
  text: string
  sent?: string
}

/** A draft this long is a paste, not a message being typed. It stays in memory
 *  (so navigating away still keeps it) but never reaches localStorage, where it
 *  could exhaust the quota and take every other key's writes down with it. */
const MAX_PERSISTED_DRAFT = 64 * 1024

/** Read persisted chat drafts (conversation key → box state), dropping
 *  anything not shaped like a draft (exported for tests). Stale keys are
 *  pruned against the first snapshot by syncChatDrafts. */
export function loadChatDrafts(): Record<string, ChatDraft> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(CHAT_DRAFTS_LS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, ChatDraft> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const { text, sent } = v as { text?: unknown; sent?: unknown }
      if (typeof text !== 'string') continue
      if (sent !== undefined && typeof sent !== 'string') continue
      if (text === '' && sent === undefined) continue
      out[k] = sent === undefined ? { text } : { text, sent }
    }
    return out
  } catch {
    return {}
  }
}

/** Persist chat drafts; best-effort (exported for tests). */
export function persistChatDrafts(drafts: Record<string, ChatDraft>): void {
  try {
    if (typeof localStorage === 'undefined') return
    const storable = Object.fromEntries(
      Object.entries(drafts).filter(([, d]) =>
        d.text.length <= MAX_PERSISTED_DRAFT && (d.sent ?? '').length <= MAX_PERSISTED_DRAFT),
    )
    localStorage.setItem(CHAT_DRAFTS_LS_KEY, JSON.stringify(storable))
  } catch {
    // quota/serialization failures are non-fatal — drafts just won't stick
  }
}

/** Persist workspace layouts; best-effort (exported for tests). */
export function persistLayouts(layouts: Record<string, Workspace | null>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(LAYOUTS_LS_KEY, JSON.stringify(layouts))
  } catch {
    // quota/serialization failures are non-fatal — layouts just won't stick
  }
}

/**
 * Insert a special (non-terminal) pane — preview or changes — into a worktree's
 * workspace as a new equal-width column beside the existing panes; a workspace
 * already showing it is returned unchanged. Exported for tests.
 */
export function injectPaneLeaf(base: Workspace | null, target: string): Workspace {
  return addColumn(base ?? singleColumn('agent'), target)
}

/** The preview-specific injector (kept for the auto-open/open-preview paths). */
export function injectPreviewLeaf(base: Workspace | null): Workspace {
  return injectPaneLeaf(base, PREVIEW_TARGET)
}

/**
 * Merge server-snapshot provisioning rows with local optimistic ones, deduped
 * by worktreeId (the snapshot wins — it carries the live message/error), sorted
 * by createdAt then id for a stable sidebar order. The optimistic copy only
 * fills the gap between clicking create and the first snapshot frame; once the
 * snapshot knows the id, App prunes it.
 */
export function mergeProvisioning(
  snapshot: ProvisioningWorktreeEntry[],
  optimistic: ProvisioningWorktreeEntry[],
): ProvisioningWorktreeEntry[] {
  const byId = new Map<string, ProvisioningWorktreeEntry>()
  for (const e of optimistic) byId.set(e.worktreeId, e)
  for (const e of snapshot) byId.set(e.worktreeId, e)
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.worktreeId.localeCompare(b.worktreeId),
  )
}

/** A terminal pane identity — a /pty/attach target:
 *  'agent', 'shell:<name>', or 'window:@<id>'. */
export type TerminalTab = string

/**
 * Whether a worktree is waiting and its current waiting spell hasn't been
 * viewed. A read mark stores the spell's waitingSinceMs, so a mark from an
 * earlier spell (worktree ran and is waiting again — even across a page
 * reload) no longer matches and the worktree re-flags. A missing
 * waitingSinceMs (server predating the field) is normalized to 0.
 */
export function isUnreadWaiting(
  worktree: Pick<WorktreeListEntry, 'worktreeId' | 'status' | 'waitingSinceMs'>,
  readWaiting: Record<string, number>,
): boolean {
  return worktree.status === 'waiting' && readWaiting[worktree.worktreeId] !== (worktree.waitingSinceMs ?? 0)
}

/**
 * Whether a deleted worktree died for an abnormal reason the user hasn't looked
 * at yet. Only the stale reaper sets deathReason (a plain user delete leaves it
 * null), so this flags exactly the unexpected deaths. `seen` is server-persisted
 * on the worktree row and resets to false when a reused id dies anew, so
 * a re-death re-flags without any client-side spell keying.
 */
export function isUnseenDeath(
  entry: Pick<StoppedWorktreeEntry, 'deathReason' | 'seen'>,
): boolean {
  return !!entry.deathReason && !entry.seen
}

/**
 * Per-project count of unread waiting worktrees — waiting and not yet viewed
 * during the current waiting spell. Drives the rail attention badge, so a
 * waiting worktree the user has already looked at doesn't keep flagging.
 * Terminating worktrees never count: the server marks them `stopping` (and
 * forces their status off 'waiting'), and a UI-initiated delete not yet
 * reflected in the snapshot is covered by `pendingDeleteIds` — either way a
 * worktree on its way out must not flash the badge.
 */
export function unreadWaitingBySlug(
  worktrees: Pick<WorktreeListEntry, 'worktreeId' | 'projectSlug' | 'status' | 'waitingSinceMs' | 'stopping'>[],
  readWaiting: Record<string, number>,
  pendingDeleteIds: string[] = [],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of worktrees) {
    if (s.stopping || pendingDeleteIds.includes(s.worktreeId)) continue
    if (isUnreadWaiting(s, readWaiting)) {
      out[s.projectSlug] = (out[s.projectSlug] ?? 0) + 1
    }
  }
  return out
}

/**
 * The worktree Alt+B lands on: the one most in need of attention. Callers pass
 * the sidebar's worktrees (mid-delete rows already filtered out); status order
 * within the array matches the display order, since the Waiting group renders
 * above Running and each group preserves array order. Priority:
 *   1. the topmost worktree with an unread waiting notification,
 *   2. else the topmost waiting worktree (already viewed this spell),
 *   3. else the topmost running worktree.
 * Null when there's nothing to jump to.
 */
export function resolveAttentionTarget(
  worktrees: Pick<WorktreeListEntry, 'worktreeId' | 'status' | 'waitingSinceMs'>[],
  readWaiting: Record<string, number>,
): string | null {
  const unread = worktrees.find((s) => isUnreadWaiting(s, readWaiting))
  if (unread) return unread.worktreeId
  const waiting = worktrees.find((s) => s.status === 'waiting')
  if (waiting) return waiting.worktreeId
  return worktrees.find((s) => s.status === 'running')?.worktreeId ?? null
}

/**
 * The tool the new-worktree shortcut would launch — the selected worktree's
 * tool, else claude — gated on its credentials being configured. Null means
 * the shortcut must be ignored: the target tool has no stored credential
 * (which includes the moment before the auth list has loaded).
 */
export function resolveNewWorktreeTool(
  worktrees: Pick<WorktreeListEntry, 'worktreeId' | 'tool'>[],
  selectedWorktreeId: string | null,
  configured: ReadonlySet<AgentTool>,
): AgentTool | null {
  const tool = worktrees.find((s) => s.worktreeId === selectedWorktreeId)?.tool ?? 'claude'
  return configured.has(tool) ? tool : null
}

/** Sections of the settings modal (left-nav entries). 'server' shows only in the desktop shell. */
export type SettingsSection =
  | 'general' | 'shortcuts' | 'credentials' | 'project' | 'userDockerfile' | 'server'

/** Local-only UI state (not server state — that lives in the snapshot). */
interface UiState {
  /** Project whose worktrees the sidebar is scoped to (rail selection). */
  activeProjectSlug: string | null
  /** Worktree shown in the main pane. */
  selectedWorktreeId: string | null
  /** Bumped every time a worktree is selected or opened. The view watches it
   *  to pull keyboard focus into that worktree's primary pane — a plain
   *  textarea focus, never a synthetic click (which would clobber any
   *  local selection in the terminal). */
  focusNonce: number
  /** Per-worktree counter; bumping one forces that terminal to remount +
   *  reattach (e.g. after a restart) without disturbing the others. */
  terminalNonces: Record<string, number>
  /** Per-worktree workspace: a row of equal-width columns, each a tabbed group.
   *  Missing key = the default single agent column; null = an explicitly
   *  emptied workspace. */
  layouts: Record<string, Workspace | null>
  /** Per-worktree container port the (single) preview pane currently shows.
   *  Missing = show the first forwarded port. */
  previewPort: Record<string, number>
  /** Point the preview pane at another forwarded port (toolbar dropdown). */
  setPreviewPort: (worktreeId: string, containerPort: number) => void
  /** Open/focus the preview pane (the header chip). Seeds the shown port
   *  when unset. */
  openPreview: (worktreeId: string, containerPort?: number) => void
  /** Open/focus the changes (review-diff) pane for a worktree. */
  openChanges: (worktreeId: string) => void
  /** Whether the worktree sidebar is shown. Desktop only — the mobile shell
   *  gives the worktree list a screen of its own. */
  sidebarOpen: boolean
  /** The worktree sidebar's width in px, set by its drag handle. Desktop
   *  only, like `sidebarOpen`; persisted, and clamped to the bounds above. */
  sidebarWidth: number
  setSidebarWidth: (px: number) => void
  /** Which mobile screen is showing (inert above the mobile breakpoint).
   *  Persisted. */
  mobileScreen: MobileScreen
  /** Move to a mobile screen directly. The back affordances go through
   *  `history.back()` instead, so the history stack stays in step. */
  setMobileScreen: (screen: MobileScreen) => void
  /** Light/dark preference. 'system' follows the OS; setThemePref persists it
   *  and reflects it onto <html data-theme> for the CSS palette (index.css). */
  themePref: ThemePref
  setThemePref: (pref: ThemePref) => void
  /** Whether the attention chime plays when a worktree flips to waiting. */
  soundEnabled: boolean
  setSoundEnabled: (enabled: boolean) => void
  /** Tiling WM vs one-at-a-time tabs (persisted; small screens default
   *  to tabs). The layout tree stays canonical in both modes. */
  viewMode: ViewMode
  /** Plan-usage metric pinned to the sidebar pill (a UsageBadge
   *  `metricKey`); null shows the tightest limit. Persisted. */
  pinnedUsageMetric: string | null
  setPinnedUsageMetric: (key: string | null) => void
  /** Per-worktree active terminal: the visible tab in tabs mode, the
   *  last-focused pane in tiles mode. Tab-switch shortcuts cycle from it. */
  activeTabs: Record<string, string>
  /** Per-worktree set of expanded file paths in the Changes (review-diff)
   *  pane. Kept in the store — not WorktreeChanges' local state — so the
   *  accordion survives the pane being torn down off-screen on a tab or
   *  worktree switch, the same way previewPort survives it. A missing key
   *  means the pane hasn't loaded for that worktree yet: WorktreeChanges seeds
   *  it by auto-opening the first file, so any existing entry (even empty) is
   *  the user's own choice and no auto-open reapplies. */
  changesExpanded: Record<string, string[]>
  /** Replace a worktree's expanded-files set in the Changes pane. */
  setChangesExpanded: (worktreeId: string, paths: string[]) => void
  /** Per-worktree scroll offset of the Changes pane's file list, so returning
   *  to the pane lands where the user left off. In-memory like
   *  changesExpanded — it survives a tab/worktree switch, not a reload. */
  changesScroll: Record<string, number>
  /** Record a worktree's Changes-pane scroll offset. */
  setChangesScroll: (worktreeId: string, scrollTop: number) => void
  /** Per-worktree base branch the Changes pane diffs against. In-memory like
   *  changesExpanded — survives a tab/worktree switch, not a reload. Absent = the
   *  worktree's own fork base (@{upstream}), i.e. today's default. */
  changesBase: Record<string, string>
  /** Set (or, with undefined, clear back to the default) a worktree's Changes
   *  base branch. */
  setChangesBase: (worktreeId: string, branch: string | undefined) => void
  /** Per-worktree find query filtering the Changes pane's file list. In-memory
   *  like changesExpanded — survives a tab/worktree switch, not a reload.
   *  Absent = no filter. */
  changesFind: Record<string, string>
  /** Set (or, with '', clear) a worktree's Changes find query. */
  setChangesFind: (worktreeId: string, query: string) => void
  /** Half-typed ACP messages, keyed by chatDraftKey(worktreeId,
   *  agentSessionId). Lives here — not in WorktreeChat's local state — because
   *  a chat pane is torn down whenever it goes off-screen, which would
   *  otherwise throw away whatever the user was in the middle of writing.
   *  Persisted (unlike the Changes pane's view state): typed text is the
   *  user's own work, and a reload should not eat it. */
  chatDrafts: Record<string, ChatDraft>
  /** Record (or, with '', clear) a conversation's half-typed message. Editing
   *  the text drops any `sent` marker: the box no longer holds the message
   *  that went to the socket. */
  setChatDraft: (worktreeId: string, agentSessionId: string, text: string) => void
  /** Mark the text a conversation's box just handed to the socket, or clear
   *  the mark (undefined) once the server's echo settles it. */
  setChatSent: (worktreeId: string, agentSessionId: string, sent: string | undefined) => void
  /** GC drafts belonging to worktrees the snapshot no longer lists. Keyed on
   *  the worktree alone: an agent session that goes inactive and comes back
   *  with the same id is the same conversation, and keeps its draft. */
  syncChatDrafts: (worktreeIds: string[]) => void
  /** One-shot "focus the Changes find box" request, raised by the find-changes
   *  shortcut alongside openChanges. The mounted WorktreeChanges pane consumes
   *  it (focuses its input, then clears the flag), so a pane mounted later —
   *  e.g. opened by the header button — never steals focus for a stale press. */
  changesFindPending: boolean
  setChangesFindPending: (pending: boolean) => void
  /** Locally-initiated provisioning rows, shown the instant create/restart is
   *  clicked. The server snapshot's `provisioning[]` is the source of truth;
   *  these only bridge the gap until the first snapshot frame carries the id,
   *  then they're pruned. */
  optimisticProvisioning: ProvisioningWorktreeEntry[]
  /** Worktrees whose delete was confirmed — rendered as "stopping…"
   *  optimistically (bridging the gap before the snapshot carries the
   *  server's own `stopping` flag) until the snapshot drops them. */
  pendingDeleteIds: string[]
  /** Just-deleted worktrees (that had history) shown optimistically in the
   *  deleted-worktrees view until the server's list-deleted catches up. */
  optimisticStopped: StoppedWorktreeEntry[]
  /** Read marks for waiting worktrees: worktreeId → waitingSinceMs of the
   *  spell the user viewed. Keying by spell means a mark from an earlier
   *  wait never hides a new one, even across reloads or a page that was
   *  closed through the whole round trip. Persisted; syncWaitingRead GCs
   *  marks whose spell is over. */
  readWaiting: Record<string, number>
  /** Keyboard-shortcut bindings (command id → chord). Starts at the factory
   *  defaults and is replaced once the server's saved overrides load at
   *  startup; the window keydown listeners read this at event time. */
  bindings: BindingMap
  /** Replace the whole binding map — used to hydrate the saved overrides. */
  setBindings: (bindings: BindingMap) => void
  /** Rebind a single command. */
  setBinding: (id: ShortcutId, chord: Chord) => void
  /** Restore every command to its factory default. */
  resetBindings: () => void
  /** True while the settings pane is capturing a chord for a rebind. The
   *  workspace keydown listeners bail on it, so the recorded chord doesn't also
   *  fire the command it's being bound to. */
  recordingShortcut: boolean
  setRecordingShortcut: (recording: boolean) => void
  /** Whether the settings modal is open. Lives here (not in the gear button)
   *  so other surfaces — e.g. a "Sign in" item in the new-worktree menu — can
   *  open settings onto a specific section. */
  settingsOpen: boolean
  /** Section the settings modal shows; sticky across open/close. */
  settingsSection: SettingsSection
  /** Tool whose sign-in form the credentials section auto-expands — set when
   *  settings was opened via a "Sign in" affordance; cleared on close. */
  settingsFocusTool: AgentTool | null
  /** Open settings — optionally onto a section, with a tool's sign-in form
   *  expanded. Without args it reopens on the last-viewed section. */
  openSettings: (section?: SettingsSection, focusTool?: AgentTool) => void
  closeSettings: () => void
  setSettingsSection: (section: SettingsSection) => void
  /** Whether the full-screen deleted-worktrees view is open. Opened from the
   *  sidebar header; scoped to the active project when rendered. */
  stoppedOverlayOpen: boolean
  openStoppedOverlay: () => void
  closeStoppedOverlay: () => void
  /** Whether the full-screen skills view is open. Opened from the sidebar
   *  header; scoped to the active project when rendered. */
  skillsOverlayOpen: boolean
  openSkillsOverlay: () => void
  closeSkillsOverlay: () => void
  /** Add a locally-initiated provisioning row (dedup by id). */
  addOptimisticProvisioning: (entry: ProvisioningWorktreeEntry) => void
  /** Patch a tracked optimistic row's message or error (no-op if absent). */
  updateOptimisticProvisioning: (worktreeId: string, patch: { message?: string; error?: string }) => void
  /** Drop an optimistic row — once the snapshot knows the id, or on dismiss. */
  removeOptimisticProvisioning: (worktreeId: string) => void
  setActiveProject: (slug: string | null) => void
  /** The app picked a project on the user's behalf — App's recovery from a
   *  missing or never-set `activeProjectSlug`. Like `setActiveProject` but it
   *  leaves the mobile screen alone, so a cold load lands on the project list
   *  rather than being thrown one screen in by a default nobody chose. */
  restoreActiveProject: (slug: string) => void
  /** The user picked a worktree (a sidebar/list tap) — on mobile this is what
   *  advances to the pane screen. */
  selectWorktree: (id: string | null) => void
  /** The app picked a worktree on the user's behalf (App's auto-select, which
   *  never leaves the pane empty). Identical to `selectWorktree` except that
   *  it leaves the mobile screen alone — otherwise merely opening a project
   *  would fling the user past its worktree list. */
  autoSelectWorktree: (id: string) => void
  /** Jump to a specific worktree, switching the active project to match. */
  openWorktree: (projectSlug: string, worktreeId: string) => void
  reconnectTerminal: (worktreeId: string) => void
  /** Replace a worktree's workspace layout (built with the pure helpers in
   *  lib/layout). */
  setWorktreeLayout: (worktreeId: string, layout: Workspace | null) => void
  toggleSidebar: () => void
  setViewMode: (mode: ViewMode) => void
  /** Record a worktree's active terminal without moving keyboard focus —
   *  for focus changes the DOM already made (clicking into a pane). */
  setActiveTab: (worktreeId: string, target: string) => void
  /** Make a terminal active AND pull keyboard focus into it — for tab
   *  clicks and the tab-switch shortcuts. */
  focusTerminal: (worktreeId: string, target: string) => void
  /** Optimistically hide a worktree being deleted. */
  beginDelete: (worktreeId: string) => void
  /** Stop hiding a worktree — on delete error (restore) or once the snapshot
   *  confirms it's gone (prune). */
  endDelete: (worktreeId: string) => void
  /** Optimistically show a just-deleted worktree in the Deleted group. */
  addOptimisticStopped: (entry: StoppedWorktreeEntry) => void
  /** Drop an optimistic deleted entry — once list-deleted includes it, or on
   *  restart. */
  removeOptimisticStopped: (worktreeId: string) => void
  /** Mark a worktree's current waiting spell as seen (it's open in the main
   *  pane). Pass the entry's waitingSinceMs (normalized: missing → 0). */
  markWaitingRead: (worktreeId: string, waitingSinceMs: number) => void
  /** GC read marks against the currently-waiting (worktreeId, waitingSinceMs)
   *  pairs: a mark whose spell is over (worktree running, gone, or waiting
   *  anew) no longer matches anything and is dropped. Correctness doesn't
   *  depend on this — isUnreadWaiting compares spells — it only keeps the
   *  persisted map from growing. */
  syncWaitingRead: (waiting: { worktreeId: string; waitingSinceMs: number }[]) => void
}

const initialSelection = loadSelection()

export const useUiStore = create<UiState>((set) => ({
  activeProjectSlug: initialSelection.projectSlug,
  selectedWorktreeId: initialSelection.worktreeId,
  focusNonce: 0,
  terminalNonces: {},
  layouts: loadPersistedLayouts(),
  previewPort: {},
  sidebarOpen: true,
  sidebarWidth: loadSidebarWidth(),
  mobileScreen: loadMobileScreen(),
  setMobileScreen: (screen) => set((s) => (s.mobileScreen === screen ? s : { mobileScreen: screen })),
  themePref: loadThemePref(),
  soundEnabled: loadSoundEnabled(),
  viewMode: loadViewMode(),
  pinnedUsageMetric: loadPinnedUsageMetric(),
  activeTabs: {},
  changesExpanded: {},
  changesScroll: {},
  changesBase: {},
  changesFind: {},
  changesFindPending: false,
  chatDrafts: loadChatDrafts(),
  optimisticProvisioning: [],
  pendingDeleteIds: [],
  optimisticStopped: [],
  readWaiting: loadReadWaiting(),
  bindings: DEFAULT_BINDINGS,
  setBindings: (bindings) => set({ bindings }),
  setBinding: (id, chord) => set((s) => ({ bindings: { ...s.bindings, [id]: chord } })),
  resetBindings: () => set({ bindings: DEFAULT_BINDINGS }),
  recordingShortcut: false,
  setRecordingShortcut: (recording) => set({ recordingShortcut: recording }),
  settingsOpen: false,
  settingsSection: 'general',
  settingsFocusTool: null,
  openSettings: (section, focusTool) => set((s) => ({
    settingsOpen: true,
    settingsSection: section ?? s.settingsSection,
    settingsFocusTool: focusTool ?? null,
  })),
  closeSettings: () => set({ settingsOpen: false, settingsFocusTool: null }),
  setSettingsSection: (section) => set({ settingsSection: section }),
  stoppedOverlayOpen: false,
  openStoppedOverlay: () => set({ stoppedOverlayOpen: true }),
  closeStoppedOverlay: () => set({ stoppedOverlayOpen: false }),

  skillsOverlayOpen: false,
  openSkillsOverlay: () => set({ skillsOverlayOpen: true }),
  closeSkillsOverlay: () => set({ skillsOverlayOpen: false }),
  addOptimisticProvisioning: (entry) => set((s) => (
    s.optimisticProvisioning.some((e) => e.worktreeId === entry.worktreeId)
      ? s
      : { optimisticProvisioning: [...s.optimisticProvisioning, entry] }
  )),
  updateOptimisticProvisioning: (worktreeId, patch) => set((s) => (
    s.optimisticProvisioning.some((e) => e.worktreeId === worktreeId)
      ? {
          optimisticProvisioning: s.optimisticProvisioning.map((e) =>
            e.worktreeId === worktreeId ? { ...e, ...patch } : e),
        }
      : s
  )),
  removeOptimisticProvisioning: (worktreeId) => set((s) => (
    s.optimisticProvisioning.some((e) => e.worktreeId === worktreeId)
      ? { optimisticProvisioning: s.optimisticProvisioning.filter((e) => e.worktreeId !== worktreeId) }
      : s
  )),
  // Switching projects clears the open worktree — the sidebar now shows a
  // different project's worktrees, so the old selection no longer belongs.
  // On mobile that lands on the project's worktree list; clearing the project
  // entirely (its removal) falls back to the project list, which is the only
  // screen with anything left to do.
  setActiveProject: (slug) => set({
    activeProjectSlug: slug,
    selectedWorktreeId: null,
    mobileScreen: slug ? 'worktrees' : 'projects',
  }),
  restoreActiveProject: (slug) => set({ activeProjectSlug: slug, selectedWorktreeId: null }),
  // Only a real selection navigates: `selectWorktree(null)` is a deselect
  // (dismissing a failed provisioning row), which should leave the user on
  // the list they dismissed it from.
  selectWorktree: (id) => set((s) => ({
    selectedWorktreeId: id,
    focusNonce: s.focusNonce + 1,
    mobileScreen: id ? 'pane' : s.mobileScreen,
  })),
  autoSelectWorktree: (id) => set((s) => ({ selectedWorktreeId: id, focusNonce: s.focusNonce + 1 })),
  openWorktree: (projectSlug, worktreeId) => set((s) => ({
    activeProjectSlug: projectSlug,
    selectedWorktreeId: worktreeId,
    focusNonce: s.focusNonce + 1,
    mobileScreen: 'pane',
  })),
  reconnectTerminal: (worktreeId) => set((s) => ({
    terminalNonces: { ...s.terminalNonces, [worktreeId]: (s.terminalNonces[worktreeId] ?? 0) + 1 },
  })),
  setWorktreeLayout: (worktreeId, layout) => set((s) => ({
    layouts: { ...s.layouts, [worktreeId]: layout },
  })),
  setPreviewPort: (worktreeId, containerPort) => set((s) => (
    s.previewPort[worktreeId] === containerPort
      ? s
      : { previewPort: { ...s.previewPort, [worktreeId]: containerPort } }
  )),
  openPreview: (worktreeId, containerPort) => set((s) => {
    const base = worktreeId in s.layouts ? s.layouts[worktreeId] : singleColumn('agent')
    const previewPort = containerPort !== undefined && s.previewPort[worktreeId] === undefined
      ? { ...s.previewPort, [worktreeId]: containerPort }
      : s.previewPort
    return {
      layouts: { ...s.layouts, [worktreeId]: injectPreviewLeaf(base) },
      previewPort,
      activeTabs: { ...s.activeTabs, [worktreeId]: PREVIEW_TARGET },
      focusNonce: s.focusNonce + 1,
    }
  }),
  openChanges: (worktreeId) => set((s) => {
    const base = worktreeId in s.layouts ? s.layouts[worktreeId] : singleColumn('agent')
    return {
      layouts: { ...s.layouts, [worktreeId]: injectPaneLeaf(base, CHANGES_TARGET) },
      activeTabs: { ...s.activeTabs, [worktreeId]: CHANGES_TARGET },
      focusNonce: s.focusNonce + 1,
    }
  }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (px) => set((s) => {
    const width = clampSidebarWidth(px)
    return width === s.sidebarWidth ? s : { sidebarWidth: width }
  }),
  setThemePref: (pref) => {
    persistThemePref(pref)
    applyThemeAttribute(pref)
    set({ themePref: pref })
  },
  setSoundEnabled: (enabled) => {
    persistSoundEnabled(enabled)
    set({ soundEnabled: enabled })
  },
  setViewMode: (mode) => {
    persistViewMode(mode)
    set({ viewMode: mode })
  },
  setPinnedUsageMetric: (key) => {
    persistPinnedUsageMetric(key)
    set({ pinnedUsageMetric: key })
  },
  setActiveTab: (worktreeId, target) => set((s) => (
    s.activeTabs[worktreeId] === target
      ? s
      : { activeTabs: { ...s.activeTabs, [worktreeId]: target } }
  )),
  setChangesExpanded: (worktreeId, paths) => set((s) => ({
    changesExpanded: { ...s.changesExpanded, [worktreeId]: paths },
  })),
  setChangesScroll: (worktreeId, scrollTop) => set((s) => (
    s.changesScroll[worktreeId] === scrollTop
      ? s
      : { changesScroll: { ...s.changesScroll, [worktreeId]: scrollTop } }
  )),
  setChangesBase: (worktreeId, branch) => set((s) => {
    const next = { ...s.changesBase }
    if (branch) next[worktreeId] = branch
    else delete next[worktreeId]
    return { changesBase: next }
  }),
  setChangesFind: (worktreeId, query) => set((s) => {
    const next = { ...s.changesFind }
    if (query) next[worktreeId] = query
    else delete next[worktreeId]
    return { changesFind: next }
  }),
  setChangesFindPending: (pending) => set((s) => (
    s.changesFindPending === pending ? s : { changesFindPending: pending }
  )),
  setChatDraft: (worktreeId, agentSessionId, text) => set((s) => {
    const key = chatDraftKey(worktreeId, agentSessionId)
    const cur = s.chatDrafts[key]
    // Unchanged text is a no-op, so a pane re-mirroring the draft it just
    // restored doesn't churn the state.
    if ((cur?.text ?? '') === text) return s
    // Edited text is no longer the message that went to the socket, so the
    // marker goes with it — what's in the box now is new work either way.
    const next = { ...s.chatDrafts }
    if (text === '') delete next[key]
    else next[key] = { text }
    return { chatDrafts: next }
  }),
  setChatSent: (worktreeId, agentSessionId, sent) => set((s) => {
    const key = chatDraftKey(worktreeId, agentSessionId)
    const cur = s.chatDrafts[key]
    if ((cur?.sent) === sent) return s
    const next = { ...s.chatDrafts }
    // An emptied box with nothing in flight leaves no key behind — a settled
    // message shouldn't linger in the persisted map as an empty draft.
    if (sent === undefined && (cur?.text ?? '') === '') delete next[key]
    else if (sent === undefined) next[key] = { text: cur?.text ?? '' }
    else next[key] = { text: cur?.text ?? '', sent }
    return { chatDrafts: next }
  }),
  syncChatDrafts: (worktreeIds) => set((s) => {
    const live = new Set(worktreeIds)
    const kept: Record<string, ChatDraft> = {}
    for (const [key, draft] of Object.entries(s.chatDrafts)) {
      if (live.has(key.slice(0, key.indexOf('|')))) kept[key] = draft
    }
    return Object.keys(kept).length === Object.keys(s.chatDrafts).length ? s : { chatDrafts: kept }
  }),
  focusTerminal: (worktreeId, target) => set((s) => {
    // Also surface the target in its column: cycle shortcuts / preview / changes
    // may focus a pane that's currently a hidden tab, and it must become the
    // column's active (visible) tab. Missing key = the default agent column;
    // withActive is a no-op (same reference) when the target is already active
    // or absent — only then touch `layouts`, so a plain focus doesn't churn the
    // persisted workspace.
    const cur = worktreeId in s.layouts ? s.layouts[worktreeId] : singleColumn('agent')
    const next = withActive(cur, target)
    return {
      ...(next === cur ? {} : { layouts: { ...s.layouts, [worktreeId]: next } }),
      activeTabs: { ...s.activeTabs, [worktreeId]: target },
      focusNonce: s.focusNonce + 1,
    }
  }),
  beginDelete: (worktreeId) => set((s) => (
    s.pendingDeleteIds.includes(worktreeId)
      ? s
      : { pendingDeleteIds: [...s.pendingDeleteIds, worktreeId] }
  )),
  endDelete: (worktreeId) => set((s) => (
    s.pendingDeleteIds.includes(worktreeId)
      ? { pendingDeleteIds: s.pendingDeleteIds.filter((id) => id !== worktreeId) }
      : s
  )),
  addOptimisticStopped: (entry) => set((s) => (
    s.optimisticStopped.some((e) => e.worktreeId === entry.worktreeId)
      ? s
      : { optimisticStopped: [entry, ...s.optimisticStopped] }
  )),
  removeOptimisticStopped: (worktreeId) => set((s) => (
    s.optimisticStopped.some((e) => e.worktreeId === worktreeId)
      ? { optimisticStopped: s.optimisticStopped.filter((e) => e.worktreeId !== worktreeId) }
      : s
  )),
  markWaitingRead: (worktreeId, waitingSinceMs) => set((s) => (
    s.readWaiting[worktreeId] === waitingSinceMs
      ? s
      : { readWaiting: { ...s.readWaiting, [worktreeId]: waitingSinceMs } }
  )),
  syncWaitingRead: (waiting) => set((s) => {
    const current = new Map(waiting.map((w) => [w.worktreeId, w.waitingSinceMs]))
    const kept: Record<string, number> = {}
    for (const [id, since] of Object.entries(s.readWaiting)) {
      if (current.get(id) === since) kept[id] = since
    }
    return Object.keys(kept).length === Object.keys(s.readWaiting).length ? s : { readWaiting: kept }
  }),
}))

// Workspace layouts survive reloads. Worktree ids are stable across restarts
// (restart resumes the same id), so a restored worktree gets its old layout
// back too.
useUiStore.subscribe((state, prev) => {
  if (state.layouts !== prev.layouts) persistLayouts(state.layouts)
})

// The sidebar's dragged width survives reloads. Written per changed pixel
// during a drag — a two-digit string, so no debounce is worth the state.
useUiStore.subscribe((state, prev) => {
  if (state.sidebarWidth !== prev.sidebarWidth) persistSidebarWidth(state.sidebarWidth)
})

// The active project + worktree survive reloads and are mirrored into the URL
// bar so a link is shareable. Only the worktree is liveness-gated — App drops a
// restored selection whose worktree is no longer active.
useUiStore.subscribe((state, prev) => {
  if (
    state.activeProjectSlug !== prev.activeProjectSlug
    || state.selectedWorktreeId !== prev.selectedWorktreeId
  ) {
    persistSelection(state.activeProjectSlug, state.selectedWorktreeId)
  }
})

// Read marks survive reloads so already-viewed waiting worktrees don't
// re-flag. Marks are keyed by the server's waitingSinceMs, so a worktree
// that waited anew while the page was closed carries a different spell
// timestamp and correctly shows unread; restored stale marks are GC'd
// against the first snapshot.
useUiStore.subscribe((state, prev) => {
  if (state.readWaiting !== prev.readWaiting) persistReadWaiting(state.readWaiting)
})

/** How long a keystroke waits before the draft map is re-serialized. */
const CHAT_DRAFT_PERSIST_MS = 400

let draftTimer: ReturnType<typeof setTimeout> | undefined
let unwrittenDrafts: Record<string, ChatDraft> | null = null

/** Write any pending draft change now. Called when the page is going away — a
 *  tab closed mid-sentence must not lose the last few hundred milliseconds of
 *  typing — and exported for tests, which would otherwise have to wait out the
 *  timer. Idempotent: with nothing unwritten it does nothing. */
export function flushChatDrafts(): void {
  if (draftTimer !== undefined) {
    clearTimeout(draftTimer)
    draftTimer = undefined
  }
  if (unwrittenDrafts === null) return
  persistChatDrafts(unwrittenDrafts)
  unwrittenDrafts = null
}

// Drafts survive reloads, but on a trailing timer rather than per keystroke:
// alone among the persisted maps this one changes on every character typed,
// and each write re-serializes the whole thing.
useUiStore.subscribe((state, prev) => {
  if (state.chatDrafts === prev.chatDrafts) return
  unwrittenDrafts = state.chatDrafts
  if (draftTimer !== undefined) clearTimeout(draftTimer)
  draftTimer = setTimeout(flushChatDrafts, CHAT_DRAFT_PERSIST_MS)
})

// `pagehide` is the primary signal, but mobile and bfcache kill paths skip it;
// a hidden `visibilitychange` is the one browsers reliably deliver. Flushing on
// both costs nothing — the second firing finds nothing unwritten.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushChatDrafts)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushChatDrafts()
  })
}
// The mobile screen survives reloads alongside the selection it goes with, so
// a phone that reloads mid-conversation comes back to the pane rather than to
// the project list.
useUiStore.subscribe((state, prev) => {
  if (state.mobileScreen !== prev.mobileScreen) persistMobileScreen(state.mobileScreen)
})
