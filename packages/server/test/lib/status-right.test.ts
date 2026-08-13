import { describe, it, expect } from 'vitest'
import { buildStatusRight, setStatusRightCmd } from '#lib/status-right'

describe('buildStatusRight', () => {
  it('omits port info when no ports forwarded', () => {
    expect(buildStatusRight('myproj', 'abcdef0123456789', [])).toBe(' myproj abcdef01 ')
  })

  it('includes host->container mappings for each port', () => {
    const result = buildStatusRight('myproj', 'abcdef0123456789', [
      { hostPort: 3000, containerPort: 3000 },
      { hostPort: 5432, containerPort: 5432 },
    ])
    expect(result).toBe(' myproj abcdef01 :3000->3000 :5432->5432 ')
  })

  it('truncates the session id to 8 characters', () => {
    expect(buildStatusRight('p', 'xxxxxxxxyyyyyyyy', [])).toBe(' p xxxxxxxx ')
  })
})

describe('setStatusRightCmd', () => {
  it('sets the option on the workspace tmux server, value quoted', () => {
    expect(setStatusRightCmd(' proj abcdef01 :3000->3000 ', '/tmp/yaac-tmux/server'))
      .toBe("tmux -S /tmp/yaac-tmux/server set-option -t yaac status-right ' proj abcdef01 :3000->3000 '")
  })

  it('addresses the socket the caller was handed', () => {
    // Which socket a workspace's tmux listens on is the driver's answer, so
    // a containerless workspace's per-worktree socket has to arrive intact.
    expect(setStatusRightCmd(' p ', '/tmp/yaac-cl-ab12cd34/wt-9.sock'))
      .toBe("tmux -S /tmp/yaac-cl-ab12cd34/wt-9.sock set-option -t yaac status-right ' p '")
  })

  it('escapes a value that would otherwise close the quoting', () => {
    // The bar carries a project slug, and nothing upstream promises it is
    // shell-safe — an unescaped quote here would run as a command.
    const cmd = setStatusRightCmd(" it's ", '/tmp/yaac-tmux/server')
    expect(cmd).toContain("'\\''")
    expect(cmd.startsWith("tmux -S /tmp/yaac-tmux/server set-option -t yaac status-right '")).toBe(true)
  })
})
