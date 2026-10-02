import { useEffect, useRef, useState, type RefObject } from 'react'
import { isFileTarget } from '#lib/files'
import { paneTargets, type PaneLayout } from '#lib/layout'
import { paneStillLive } from '#lib/panes'
import { layoutOf } from '#lib/store'
import type { WorkspaceListEntry } from '@yaac/shared/types'

export interface PaneRect { left: number; top: number; width: number; height: number }

const keyId = (key: string): string => key.slice(0, key.indexOf('|'))
const keyTarget = (key: string): string => key.slice(key.indexOf('|') + 1)

/**
 * The panes WorkspaceView keeps mounted, as `<workspaceId>|<target>` keys.
 * Every pane ever shown stays mounted (hidden) so switching back is
 * instant, until it is closed (`forget`) or its workspace no longer has it.
 *
 * `eagerKeys` are mounted hidden from the start, so they attach in the
 * background and the first click shows them instantly; they get `eagerRect`
 * so they attach at the size they will be shown at. `lastRects` keeps each
 * mounted pane's last shown rect, so showing a hidden one needs no resize.
 */
export function useKeptPanes({ sid, layout, layouts, workspaces, eagerKeys, eagerRect }: {
  sid: string | null
  layout: PaneLayout
  layouts: Record<string, PaneLayout>
  workspaces: WorkspaceListEntry[]
  eagerKeys: string[]
  /** Null until the pane area has a size. */
  eagerRect: PaneRect | null
}): { mounted: string[]; forget: (key: string) => void; lastRects: RefObject<Map<string, PaneRect>> } {
  const [opened, setOpened] = useState<string[]>([])
  const add = (keys: string[]): void => setOpened((prev) => {
    const fresh = keys.filter((k) => !prev.includes(k))
    return fresh.length ? [...prev, ...fresh] : prev
  })
  const drop = (keep: (key: string) => boolean): void => setOpened((prev) => {
    const next = prev.filter(keep)
    return next.length === prev.length ? prev : next
  })

  useEffect(() => {
    if (sid) add(paneTargets(layout).map((t) => `${sid}|${t}`))
  }, [sid, layout])

  const keyWorkspace = (key: string): WorkspaceListEntry | undefined =>
    workspaces.find((s) => s.workspaceId === keyId(key))

  // Permanently drop a pane its workspace no longer has. Filtering `mounted`
  // alone isn't enough: an ACP workspace's early `agent` key would come back
  // while the workspace stops (it then reports no conversations) and attach
  // a PTY to a workspace being torn down. Workspaces missing from this
  // snapshot are left alone.
  useEffect(() => {
    drop((key) => {
      const w = keyWorkspace(key)
      return w === undefined || paneStillLive(w, keyTarget(key))
    })
  }, [workspaces])

  // Likewise drop a file pane that left its layout (renamed or deleted).
  useEffect(() => {
    drop((key) => !isFileTarget(keyTarget(key)) || paneTargets(layoutOf(layouts, keyId(key))).includes(keyTarget(key)))
  }, [layouts])

  const mounted = opened.filter((key) => {
    const w = keyWorkspace(key)
    return w !== undefined && paneStillLive(w, keyTarget(key))
  })

  const lastRects = useRef(new Map<string, PaneRect>())
  for (const k of [...lastRects.current.keys()]) {
    if (!mounted.includes(k)) lastRects.current.delete(k)
  }

  const eager = eagerKeys.join(',')
  const { left = 0, top = 0, width = 0, height = 0 } = eagerRect ?? {}
  useEffect(() => {
    if (eagerRect === null || eager === '') return
    const keys = eager.split(',')
    for (const k of keys) {
      if (!lastRects.current.has(k)) lastRects.current.set(k, { left, top, width, height })
    }
    add(keys)
  }, [eager, left, top, width, height])

  return { mounted, forget: (key) => drop((k) => k !== key), lastRects }
}
