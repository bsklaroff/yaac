// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { usePressDrag } from '#lib/usePressDrag'

/**
 * A press on a row or tab: a click until it travels, then a drag whose
 * drop target follows the pointer. A cancelled pointer is neither.
 */

const down = (x: number, y: number): ReactPointerEvent =>
  ({ clientX: x, clientY: y, preventDefault: () => {} }) as unknown as ReactPointerEvent

function pointer(type: string, x = 0, y = 0): void {
  const e = new MouseEvent(type, { clientX: x, clientY: y })
  act(() => { window.dispatchEvent(e) })
}

function setup(): { result: { current: ReturnType<typeof usePressDrag<string, string>> }; onDrop: ReturnType<typeof vi.fn> } {
  const onDrop = vi.fn()
  const { result } = renderHook(() => usePressDrag<string, string>({ over: (x) => (x > 50 ? 'right' : 'left'), onDrop }))
  return { result, onDrop }
}

describe('usePressDrag', () => {
  it('treats a press that barely moves as a click', () => {
    const { result, onDrop } = setup()
    const onClick = vi.fn()
    act(() => result.current.start(down(10, 10), 'tab-a', onClick))
    pointer('pointermove', 13, 12)
    expect(result.current.drag).toBeNull()
    pointer('pointerup')
    expect(onClick).toHaveBeenCalledOnce()
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('drags past the threshold, tracking the target, and drops on release', () => {
    const { result, onDrop } = setup()
    const onClick = vi.fn()
    act(() => result.current.start(down(10, 10), 'tab-a', onClick))
    pointer('pointermove', 30, 10)
    expect(result.current.drag).toEqual({ item: 'tab-a', over: 'left' })
    pointer('pointermove', 80, 10)
    expect(result.current.drag).toEqual({ item: 'tab-a', over: 'right' })
    pointer('pointerup')
    expect(onDrop).toHaveBeenCalledWith({ item: 'tab-a', over: 'right' })
    expect(onClick).not.toHaveBeenCalled()
    expect(result.current.drag).toBeNull()
  })

  it('abandons the press on pointercancel, so a later release does nothing', () => {
    const { result, onDrop } = setup()
    const onClick = vi.fn()
    act(() => result.current.start(down(10, 10), 'tab-a', onClick))
    pointer('pointermove', 80, 10)
    pointer('pointercancel')
    expect(result.current.drag).toBeNull()
    pointer('pointermove', 90, 10)
    pointer('pointerup')
    expect(onDrop).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
  })
})
