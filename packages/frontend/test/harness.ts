import { createElement, type ReactElement } from 'react'
import { vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, type RenderResult } from '@testing-library/react'
import { useUiStore } from '#lib/store'
import { whoamiQuery } from '#lib/viewer'
import type { XtermCore } from '#lib/xterm-internals'
import type { Terminal } from '@xterm/xterm'
import type { AcpEvent } from '@yaac/shared/acp'
import type {
  ConversationEntry, ProvisioningWorkspaceEntry, ServerSnapshot, Whoami, WorkspaceListEntry,
} from '@yaac/shared/types'

/**
 * A stub of the global `fetch`, which is where the SPA meets the server:
 * component tests answer the typed client's requests here rather than
 * mocking the modules that make them. Routes are keyed `'METHOD /api/path'`
 * (the query string is not part of the key). A route's reply is a JSON body,
 * a `Response`, or a function of the request returning either (or a promise
 * of one). Unrouted requests answer 404 NOT_FOUND, so a forgotten route
 * fails loudly. Vitest unstubs it after each test.
 */

export interface FetchCall {
  method: string
  path: string
  query: URLSearchParams
  /** The parsed JSON body, if any. */
  body: unknown
  signal?: AbortSignal
}

type Reply = unknown

export interface FetchMock {
  /** Every request so far, in order. */
  calls: FetchCall[]
  /** The requests made to one route. */
  called: (route: string) => FetchCall[]
  /** Add or replace a route's reply. */
  route: (route: string, reply: Reply) => void
}

/** An error reply in the server's `{ error: { code, message } }` shape. */
export function serverError(code: string, message = code, status = 500): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function mockFetch(routes: Record<string, Reply> = {}): FetchMock {
  const table = new Map(Object.entries(routes))
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input, 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    const text = typeof init?.body === 'string' ? init.body : ''
    const call: FetchCall = {
      method, path: url.pathname, query: url.searchParams, body: text ? JSON.parse(text) as unknown : undefined,
      ...(init?.signal ? { signal: init.signal } : {}),
    }
    calls.push(call)
    const key = `${method} ${url.pathname}`
    if (!table.has(key)) return serverError('NOT_FOUND', `no route for ${key}`, 404)
    const entry = table.get(key)
    const reply: unknown = await (typeof entry === 'function' ? (entry as (c: FetchCall) => unknown)(call) : entry)
    if (reply instanceof Response) return reply.clone()
    if (reply === undefined) return new Response(null, { status: 204 })
    return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } })
  })
  return {
    calls,
    called: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
    route: (route, reply) => { table.set(route, reply) },
  }
}

/** The caller a test's components see: a `local` install's one user, who
 *  owns every fixture project (`owner: TEST_USER_ID`). */
export const TEST_USER_ID = 'u-me'
export const TEST_WHOAMI: Whoami = {
  kind: 'local', userId: TEST_USER_ID, users: [{ id: TEST_USER_ID, login: null, name: 'Me' }],
}

/** A query client configured like the app's (main.tsx): no retries, and no
 *  refetches the test did not cause. It already holds `whoami`, as the app's
 *  does by the time anything below the bootstrap renders; pass null to
 *  leave it for the test to answer. A `snapshot` goes into the store the way
 *  the events socket delivers one (`receiveSnapshot`), so `useSnapshot`
 *  reads it. */
export function testQueryClient(whoami: Whoami | null = TEST_WHOAMI, snapshot?: ServerSnapshot): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  })
  if (whoami) client.setQueryData(whoamiQuery.queryKey, whoami)
  if (snapshot) useUiStore.getState().receiveSnapshot(snapshot)
  return client
}

/** A snapshot with nothing in it; `over` fills what a case is about. */
export const serverSnapshot = (over: Partial<ServerSnapshot> = {}): ServerSnapshot => ({
  driver: 'k8s',
  workspaces: [],
  workspaceGroups: [],
  stale: [],
  projects: [],
  provisioning: [],
  queuedWorkspaces: [],
  heldWorkspaces: [],
  draftWorkspaces: [],
  routines: [],
  gitAuthFailures: {},
  imageBuilds: [],
  planUsage: {},
  codexPlanUsage: {},
  ...over,
})

/** Render inside a fresh query client. */
export function renderWithClient(ui: ReactElement, client = testQueryClient()): RenderResult {
  return render(createElement(QueryClientProvider, { client }, ui))
}

/*
 * Fixture builders. Each returns a minimal valid row, with `over` setting
 * whatever a case is about.
 */

/** A running workspace with no agents, ports or blocked hosts. */
export const workspaceEntry = (over: Partial<WorkspaceListEntry> = {}): WorkspaceListEntry => ({
  workspaceId: 's1',
  projectId: 'proj',
  tool: 'claude',
  status: 'running',
  createdAt: '2026-08-10 00:00:00',
  conversations: [],
  blockedHosts: [],
  forwardedPorts: [],
  unforwardedPorts: [],
  ...over,
})

/** A workspace being created. */
export const provisioningEntry = (over: Partial<ProvisioningWorkspaceEntry> = {}): ProvisioningWorkspaceEntry => ({
  workspaceId: 'p1',
  projectId: 'proj',
  tool: 'claude',
  kind: 'create',
  message: 'Starting…',
  createdAt: '2026-01-01 00:00:00',
  ...over,
})

/** A workspace's first, active agent conversation. */
export const conversation = (over: Partial<ConversationEntry> = {}): ConversationEntry => ({
  conversationId: 'c1', tool: 'claude', mode: 'acp', ordinal: 0, active: true, ...over,
})

/** A user prompt in a conversation (or a subagent's `thread`). */
export const userEvent = (seq: number, text: string, thread?: string): AcpEvent =>
  ({ type: 'user', seq, ...(thread !== undefined ? { thread } : {}), content: [{ type: 'text', text }] })

/** An agent message in a conversation (or a subagent's `thread`). */
export const agentEvent = (seq: number, text: string, thread?: string): AcpEvent =>
  ({ type: 'agent', seq, ...(thread !== undefined ? { thread } : {}), content: [{ type: 'text', text }] })

/** A WebSocket a test opens, feeds and closes by hand. Stub it in with
 *  `vi.stubGlobal('WebSocket', FakeSocket)`. */
export class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  /** The socket opened last. */
  static latest(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1]
  }

  readyState = FakeSocket.CONNECTING
  binaryType = 'blob'
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  /** Complete the handshake. */
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  /** Deliver a server frame: a string as is, anything else as JSON. */
  deliver(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) })
  }
}

/**
 * An opened xterm Terminal as #lib/xterm-internals sees it: every private
 * member `xtermCore` checks, with `core` replacing whole services and `term`
 * adding the public members the code under test calls.
 */
export function fakeXterm(core: Partial<XtermCore> = {}, term: object = {}): Terminal {
  const el = document.createElement('div')
  return {
    ...term,
    _core: {
      element: el,
      screenElement: el,
      _selectionService: { shouldForceSelection: () => false, clearSelection: () => {}, disable: () => {} },
      coreService: { triggerDataEvent: () => {} },
      _mouseService: { getMouseReportCoords: () => ({ col: 3, row: 4, x: 30, y: 40 }) },
      coreMouseService: { areMouseEventsActive: true, triggerMouseEvent: () => true, consumeWheelEvent: () => 0 },
      _renderService: { dimensions: { css: { cell: { height: 17 } }, device: { cell: { height: 34 } } } },
      _coreBrowserService: { dpr: 2 },
      ...core,
    },
  } as unknown as Terminal
}

/**
 * Type `text` into an input as a keystroke would. `fireEvent.change` reads
 * as autofill to Base UI's Combobox, which then skips what it does for typing
 * (highlighting the first match); an input event with an `inputType` does not.
 */
export function typeInto(input: HTMLElement, text: string): void {
  fireEvent.input(input, { target: { value: text }, inputType: 'insertText' })
}
