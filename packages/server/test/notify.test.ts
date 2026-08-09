import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  coalesceCalls,
  onWorktreeListChanged,
  notifyWorktreeListChanged,
  _resetWorktreeListChangedForTests,
} from '#notify'

afterEach(() => {
  _resetWorktreeListChangedForTests()
})

describe('session-list-changed signal', () => {
  it('fires the registered listener on notify', () => {
    const fn = vi.fn()
    onWorktreeListChanged(fn)
    notifyWorktreeListChanged()
    notifyWorktreeListChanged()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('is a no-op when nothing is registered', () => {
    expect(() => notifyWorktreeListChanged()).not.toThrow()
  })

  it('keeps only the latest listener (last registration wins)', () => {
    const first = vi.fn()
    const second = vi.fn()
    onWorktreeListChanged(first)
    onWorktreeListChanged(second)
    notifyWorktreeListChanged()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('coalesceCalls', () => {
  it('fires the first call immediately', () => {
    const fn = vi.fn()
    const wrapped = coalesceCalls(fn, 50)
    wrapped()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('collapses a burst into one trailing call', async () => {
    const fn = vi.fn()
    const wrapped = coalesceCalls(fn, 20)
    wrapped()
    wrapped()
    wrapped()
    wrapped()
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2))
    // No further pending call after the trailing one.
    await new Promise((r) => setTimeout(r, 30))
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not fire a trailing call when nothing arrived during the window', async () => {
    const fn = vi.fn()
    const wrapped = coalesceCalls(fn, 10)
    wrapped()
    await new Promise((r) => setTimeout(r, 30))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('fires immediately again once the window has passed', async () => {
    const fn = vi.fn()
    const wrapped = coalesceCalls(fn, 10)
    wrapped()
    await new Promise((r) => setTimeout(r, 30))
    wrapped()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
