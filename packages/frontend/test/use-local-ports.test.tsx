import { describe, it, expect, afterEach } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useLocalPorts } from '#lib/useLocalPorts'
import type { LocalPortRemap, PortMapping } from '@yaac/shared/types'

const PORTS: PortMapping[] = [{ containerPort: 8790, hostPort: 8790 }, { containerPort: 3000, hostPort: 3000 }]

afterEach(() => {
  cleanup()
  delete (window as unknown as { yaacWindow?: unknown }).yaacWindow
})

describe('useLocalPorts', () => {
  it('swaps in the port the desktop app holds, following its updates until unmounted', () => {
    let push: (remaps: LocalPortRemap[]) => void = () => {}
    let subscribed = 0
    ;(window as unknown as { yaacWindow?: unknown }).yaacWindow = {
      onForwardRemaps: (cb: (remaps: LocalPortRemap[]) => void) => {
        subscribed++
        push = cb
        cb([{ workspaceId: 'a', containerPort: 8790, hostPort: 8790, localPort: 8791 }])
        return () => { subscribed-- }
      },
    }
    const { result, rerender, unmount } = renderHook(({ id }) => useLocalPorts(id, PORTS), {
      initialProps: { id: 'a' },
    })
    expect(result.current).toEqual([{ containerPort: 8790, hostPort: 8791 }, PORTS[1]])

    // Another workspace's remap leaves this one's ports alone.
    rerender({ id: 'b' })
    expect(result.current).toEqual(PORTS)

    rerender({ id: 'a' })
    act(() => push([]))
    expect(result.current).toEqual(PORTS)
    unmount()
    expect(subscribed).toBe(0)
  })

  it('returns the server\'s ports in a browser', () => {
    const { result } = renderHook(() => useLocalPorts('a', PORTS))
    expect(result.current).toEqual(PORTS)
  })
})
