import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useQueries, useQueryClient, type QueryObserverResult } from '@tanstack/react-query'
import { api } from '#lib/api'
import type { AcpEvent } from '@yaac/shared/acp'

/**
 * A conversation's history a page at a time, for the chat pane and the
 * read-only one. The server splits a conversation into pages at each
 * compaction (and at a size cap), and a pane starts with only the last:
 * the live pane's `hello`, or the read-only pane's latest page, both of
 * which keep growing while the conversation runs.
 *
 * The pages shown are one unbroken run. Scrolling near its top reads the
 * page before it from the transcript route, keeping the reader where they
 * were; jumping to the top shows only the first page, and scrolling down from
 * there reads each next one until the run reaches the last page again.
 *
 * An agent restart numbers the pages afresh, so pages are kept per agent
 * life (`AcpTranscriptPage.life`): a new life starts the view over at its
 * end, and a page read for another life is not shown.
 */

/** How close to an end of the list, in pixels, the reader must be for the
 *  page past it to load. */
const LOAD_MARGIN_PX = 800

/** Where to put the list after the next render: as far from its bottom as
 *  it was (a page added above), or at an end. */
type Placement = { at: 'kept'; fromBottom: number } | { at: 'top' } | { at: 'bottom' }

/** The pages shown: `from` to `to`, where `last` and `end` follow the
 *  conversation's last page as it changes. `view` names the conversation
 *  and life they were read for. */
interface Span {
  view: string
  from: number | 'last'
  to: number | 'end'
}

export interface TranscriptPages {
  /** The shown pages' events, oldest first. */
  events: AcpEvent[]
  /** The shown pages end with the last, so new events show as they come. */
  atEnd: boolean
  /** A page past an end of the shown ones is being read. */
  loading: 'earlier' | 'later' | undefined
  /** Whether there is more of the conversation above or below the screen,
   *  for offering to jump there. */
  above: boolean
  below: boolean
  /** The scrolling element's `onScroll`. */
  onScroll: () => void
  jumpToTop: () => void
  jumpToBottom: () => void
}

/** One page's query: pages before the last never change within a life. A
 *  page the server numbered for another life fails, to be read again once
 *  the pane has caught up with it. */
function pageQuery(workspaceId: string, agentSessionId: string, life: string | undefined, page: number): {
  queryKey: readonly unknown[]
  queryFn: () => Promise<AcpEvent[]>
  staleTime: number
} {
  return {
    queryKey: ['transcript-page', workspaceId, agentSessionId, life, page],
    queryFn: async () => {
      const read = await api.workspace[':id']['agent-sessions'][':sessionId'].transcript.$get({
        param: { id: workspaceId, sessionId: agentSessionId },
        query: { page: String(page) },
      })
      if (read.life !== life) throw new Error('the conversation restarted')
      return read.events
    },
    staleTime: Infinity,
  }
}

/** The pages' data, combined by a stable function so the result keeps its
 *  identity until a page changes. */
const pagesData = (results: QueryObserverResult<AcpEvent[]>[]): (AcpEvent[] | undefined)[] => results.map((r) => r.data)

export function useTranscriptPages({ workspaceId, agentSessionId, life, last, lastEvents, scrollRef }: {
  workspaceId: string
  agentSessionId: string
  /** The agent life the last page is numbered for. */
  life: string | undefined
  /** The last page's number, and its events and any after it. */
  last: number
  lastEvents: AcpEvent[]
  scrollRef: RefObject<HTMLElement | null>
}): TranscriptPages {
  const queryClient = useQueryClient()
  const [stored, setSpan] = useState<Span>()
  const view = JSON.stringify([agentSessionId, life])
  const span: Span = stored?.view === view ? stored : { view, from: 'last', to: 'end' }
  const from = span.from === 'last' ? last : Math.min(span.from, last)
  const atEnd = span.to === 'end' || span.to >= last
  const to = atEnd ? last : span.to as number
  const numbers = Array.from({ length: (atEnd ? last : to + 1) - from }, (_, i) => from + i)
  const pages = useQueries({ queries: numbers.map((p) => pageQuery(workspaceId, agentSessionId, life, p)), combine: pagesData })
  const events = useMemo(
    () => [...pages.flatMap((p) => p ?? []), ...(atEnd ? lastEvents : [])],
    [pages, atEnd, lastEvents],
  )

  const [loading, setLoading] = useState<TranscriptPages['loading']>()
  const busy = useRef(false)
  const placement = useRef<Placement | undefined>(undefined)
  const [edges, setEdges] = useState({ above: false, below: false })

  /** Read `page`, then show it as `next` says. A failed read leaves the
   *  view as it was, for the next scroll to retry. */
  const show = (page: number, direction: 'earlier' | 'later', next: Span, place?: () => Placement): void => {
    if (busy.current) return
    busy.current = true
    setLoading(direction)
    queryClient.fetchQuery(pageQuery(workspaceId, agentSessionId, life, page))
      .then(() => {
        placement.current = place?.()
        setSpan(next)
      }, () => undefined)
      .finally(() => {
        busy.current = false
        setLoading(undefined)
      })
  }

  const measure = (): void => {
    const el = scrollRef.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const above = from > 0 || el.scrollTop > el.clientHeight
    const below = !atEnd || fromBottom > el.clientHeight
    setEdges((cur) => (cur.above === above && cur.below === below ? cur : { above, below }))
    if (el.scrollTop < LOAD_MARGIN_PX && from > 0) {
      show(from - 1, 'earlier', { ...span, from: from - 1 }, () => ({ at: 'kept', fromBottom: el.scrollHeight - el.scrollTop }))
    } else if (fromBottom < LOAD_MARGIN_PX && !atEnd) {
      if (to + 1 >= last) setSpan({ ...span, to: 'end' })
      else show(to + 1, 'later', { ...span, to: to + 1 })
    }
  }

  // A conversation opens at its end, as does each new life of it.
  const opened = useRef<string | undefined>(undefined)
  if (opened.current !== view && lastEvents.length > 0) {
    opened.current = view
    placement.current = { at: 'bottom' }
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    const place = placement.current
    if (!el || place === undefined) return
    placement.current = undefined
    el.scrollTop = place.at === 'kept' ? el.scrollHeight - place.fromBottom : place.at === 'top' ? 0 : el.scrollHeight
  }, [events, scrollRef])

  // A page too short to scroll leaves the reader near an edge with no
  // scroll to come, so check after every change too.
  useEffect(measure, [events, last])

  return {
    events,
    atEnd,
    loading,
    above: edges.above,
    below: edges.below,
    onScroll: measure,
    jumpToTop: () => {
      const el = scrollRef.current
      if (from === 0) {
        if (el) el.scrollTop = 0
        return
      }
      show(0, 'earlier', { view, from: 0, to: 0 }, () => ({ at: 'top' }))
    },
    jumpToBottom: () => {
      if (!atEnd) {
        placement.current = { at: 'bottom' }
        setSpan({ view, from: 'last', to: 'end' })
        return
      }
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    },
  }
}
