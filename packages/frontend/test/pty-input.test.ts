import { describe, it, expect, vi } from 'vitest'
import { PTY_KEYS, paneKey, registerPtyInput, sendPtyInput } from '#lib/ptyInput'

describe('pty input registry', () => {
  it('routes a key press to the pane that registered', () => {
    const send = vi.fn()
    const off = registerPtyInput(paneKey('s1', 'agent'), send)
    expect(sendPtyInput(paneKey('s1', 'agent'), PTY_KEYS.escape)).toBe(true)
    expect(send).toHaveBeenCalledWith('\x1b')
    off()
  })

  it('reports a miss rather than throwing for a pane that is gone', () => {
    const send = vi.fn()
    const off = registerPtyInput(paneKey('s2', 'agent'), send)
    off()
    expect(sendPtyInput(paneKey('s2', 'agent'), PTY_KEYS.tab)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps panes of the same worktree apart', () => {
    const agent = vi.fn()
    const shell = vi.fn()
    const offA = registerPtyInput(paneKey('s3', 'agent'), agent)
    const offS = registerPtyInput(paneKey('s3', 'shell:one'), shell)
    sendPtyInput(paneKey('s3', 'shell:one'), PTY_KEYS.ctrlC)
    expect(shell).toHaveBeenCalledWith('\x03')
    expect(agent).not.toHaveBeenCalled()
    offA()
    offS()
  })

  it('survives a remount, where the new terminal registers before the old one cleans up', () => {
    const oldSend = vi.fn()
    const newSend = vi.fn()
    const key = paneKey('s4', 'agent')
    const offOld = registerPtyInput(key, oldSend)
    const offNew = registerPtyInput(key, newSend)
    // React's effect order: the replacement registers, THEN the old cleanup
    // runs. A naive delete would leave the live pane unreachable.
    offOld()
    expect(sendPtyInput(key, PTY_KEYS.up)).toBe(true)
    expect(newSend).toHaveBeenCalledWith('\x1b[A')
    expect(oldSend).not.toHaveBeenCalled()
    offNew()
  })

  it('sends the byte sequences xterm itself emits for those keys', () => {
    expect(PTY_KEYS).toEqual({
      escape: '\x1b',
      tab: '\t',
      shiftTab: '\x1b[Z',
      ctrlC: '\x03',
      up: '\x1b[A',
      down: '\x1b[B',
      right: '\x1b[C',
      left: '\x1b[D',
    })
  })
})
