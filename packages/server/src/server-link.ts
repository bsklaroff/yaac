import { serverLog } from '#log'
import type { AgentTool } from '@yaac/shared/types'
import type { HerdEvent } from '@yaac/shared/herd'

/**
 * The herd's handle on the server — the only direction of traffic a herd
 * initiates, and the mirror of `#herd` (docs/plans/herd-split.md).
 *
 * A herd owns bulk bytes and live runtime state; the server owns every
 * durable fact a client can ask about. So a herd never writes a row, never
 * pushes a snapshot, and never decides what a request means. It reports, and
 * the server acts. Every one of those reports is a method here, which is what
 * makes the herd half constructible against a link rather than against the
 * server's modules: nothing under the herd imports `#main`, `#routes`,
 * `#http` or `#notify`.
 *
 * Deliberately a zero-dependency module at the package root, for the same
 * reason as `#notify`: the callers are spread across the herd's features and
 * none of them should acquire a dependency on the server's tables, its event
 * hub or its HTTP layer for a one-line report.
 */
export interface ServerLink {
  /**
   * A discovery to persist. Resolves only once the row is written — that is
   * what a caller tearing a worktree down needs, since a listing between the
   * report and the write would show a worktree as neither running nor
   * stopped, and it is why this is a call rather than a fire-and-forget
   * notification. Over a link it stays one; an event whose ordering does not
   * matter can be relaxed to a notification later, per event, on purpose.
   */
  workspaceEvent(event: HerdEvent): Promise<void>

  /**
   * Something the worktree list shows has changed — a build row, a port that
   * came up, a workspace that went away. Fire-and-forget: the server decides
   * whether that is worth a snapshot, and how many of them to coalesce.
   */
  workspacesChanged(): void

  /**
   * An in-worktree `yaac-spawn` reached the proxy and the herd drained it.
   *
   * The herd resolves only what the substrate can answer — which workspace
   * called, in which project, running which tool — and reports it. Deciding
   * what the request means is the server's: the tool precedence, the fan-out
   * cap, the id the new workspace gets, and the sidebar row it provisions
   * under. The minted id comes back because the caller's pod is blocked on
   * it at the proxy.
   */
  spawnRequested(request: SpawnRequest): Promise<SpawnDecision>

  /**
   * The conversations the server has recorded in a workspace, with the handle
   * each was last seen on.
   *
   * The one lookup in the contract, and it earns its place: an ACP driver
   * attaching to a live pod has to re-address conversations it did not start
   * (and `session/load` them after a restart), and which conversation sits on
   * a handle is a row the herd never sees. Delivered on demand rather than
   * pushed because it is asked per workspace, at watcher start, and a stale
   * copy would re-address the wrong conversation.
   */
  recordedConversations(workspace: {
    projectSlug: string
    workspaceId: string
  }): Promise<RecordedConversation[]>
}

/** A drained `yaac-spawn`, with everything the substrate could resolve. */
export interface SpawnRequest {
  /** Correlates the answer back to the pod blocked at the proxy. */
  requestId: string
  /** The workspace that called. */
  callerWorkspaceId: string
  /** Its project — the new workspace is created in the caller's project. */
  callerProjectSlug: string
  /** The tool the caller itself runs, when the substrate labelled it. Second
   *  in the tool precedence, behind the request's own choice. */
  callerTool?: AgentTool
  prompt: string
  tool?: string
  model?: string
}

/** What the server decided about one spawn request. */
export type SpawnDecision =
  | { ok: true; workspaceId: string }
  | { ok: false; error: string }

/** A conversation the server has on record for a workspace. */
export interface RecordedConversation {
  /** The driver's handle it was last seen on — a tmux pane id under `tui`,
   *  the acpd window name under `acp`. */
  handle: string
  agentSessionId: string
}

let link: ServerLink | null = null

/** Server side: install the link every herd-side report is delivered to.
 *  Replaces any previous link (last registration wins). */
export function setServerLink(next: ServerLink): void {
  link = next
}

/**
 * Herd side: the server, as the herd is allowed to see it.
 *
 * With no link installed every method is inert — events are dropped and
 * logged, a spawn is refused, a workspace has no recorded conversations.
 * That is the normal state in a unit test that is not exercising the server
 * half, and a bug anywhere else, so it must not pass silently.
 */
export function serverLink(): ServerLink {
  return link ?? DETACHED
}

const DETACHED: ServerLink = {
  workspaceEvent: (event) => {
    serverLog(`[herd] no server link for ${event.type}; event dropped`)
    return Promise.resolve()
  },
  workspacesChanged: () => {},
  spawnRequested: () => {
    serverLog('[herd] no server link; spawn request refused')
    return Promise.resolve({ ok: false, error: 'server link unavailable' })
  },
  recordedConversations: () => Promise.resolve([]),
}

/** Test helper: drop the installed link. */
export function _resetServerLinkForTests(): void {
  link = null
}

/** Test helper: install a link carrying only the methods a test cares about.
 *  Everything else stays inert, so a test asserting on reported events does
 *  not have to spell out a spawn policy it never exercises. */
export function _setServerLinkForTests(partial: Partial<ServerLink>): void {
  link = { ...DETACHED, ...partial }
}
