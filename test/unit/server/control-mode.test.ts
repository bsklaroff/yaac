import { describe, it, expect, vi } from 'vitest'

import {
  ControlModeClient,
  parseControlModeNotification,
  type ControlModeNotification,
} from '@/server/control-mode'

describe('parseControlModeNotification', () => {
  it('parses a %subscription-changed line into name/pane/value', () => {
    const n = parseControlModeNotification(
      '%subscription-changed status $0 @0 0 %3 : ⠋ working on task',
    )
    expect(n).toEqual({
      kind: 'subscription',
      name: 'status',
      paneId: '%3',
      value: '⠋ working on task',
    })
  })

  it('keeps colons inside the subscription value intact', () => {
    const n = parseControlModeNotification(
      '%subscription-changed status $0 @0 0 %3 : fix: parse a : b',
    )
    expect(n).toEqual({
      kind: 'subscription',
      name: 'status',
      paneId: '%3',
      value: 'fix: parse a : b',
    })
  })

  it('parses an empty subscription value (title cleared)', () => {
    const n = parseControlModeNotification('%subscription-changed status $0 @0 0 %3 : ')
    expect(n).toEqual({ kind: 'subscription', name: 'status', paneId: '%3', value: '' })
  })

  it('parses %output into a pane-id dirty signal', () => {
    expect(parseControlModeNotification('%output %5 \\033[1mhi')).toEqual({
      kind: 'output',
      paneId: '%5',
    })
  })

  it('parses %exit with and without a reason', () => {
    expect(parseControlModeNotification('%exit')).toEqual({ kind: 'exit' })
    expect(parseControlModeNotification('%exit detached')).toEqual({ kind: 'exit' })
  })

  it('returns null for notifications the watchers do not consume', () => {
    expect(parseControlModeNotification('%session-changed $0 yaac')).toBeNull()
    expect(parseControlModeNotification('%layout-change @0 ...')).toBeNull()
    expect(parseControlModeNotification('not a notification')).toBeNull()
  })

  it('returns null for a malformed subscription line', () => {
    expect(parseControlModeNotification('%subscription-changed status $0')).toBeNull()
  })
})

/** Feed helper: a client wired to capture writes and notifications. */
function makeClient(): {
  client: ControlModeClient
  writes: string[]
  notifications: ControlModeNotification[]
} {
  const writes: string[] = []
  const notifications: ControlModeNotification[] = []
  const client = new ControlModeClient(
    (data) => writes.push(data),
    (n) => notifications.push(n),
  )
  return { client, writes, notifications }
}

/** The unsolicited block tmux emits for the implicit attach command. */
function feedBanner(client: ControlModeClient): void {
  client.feed('%begin 1 100 0\n%end 1 100 0\n%session-changed $0 yaac\n')
}

describe('ControlModeClient', () => {
  it('consumes the attach banner and matches replies FIFO after it', async () => {
    const { client, writes } = makeClient()
    feedBanner(client)
    const first = client.send("display-message -p -t yaac:claude.0 '#{pane_id}'")
    const second = client.send('display-message -p ok')
    expect(writes).toHaveLength(2)
    client.feed('%begin 1 101 1\n%3\n%end 1 101 1\n')
    client.feed('%begin 1 102 1\nok\n%end 1 102 1\n')
    await expect(first).resolves.toBe('%3')
    await expect(second).resolves.toBe('ok')
  })

  it('does not misassign the banner to a command sent before it arrives', async () => {
    const { client } = makeClient()
    const cmd = client.send('display-message -p ok')
    feedBanner(client)
    client.feed('%begin 1 101 1\nok\n%end 1 101 1\n')
    await expect(cmd).resolves.toBe('ok')
  })

  it('rejects a command whose reply is %error, with the body as message', async () => {
    const { client } = makeClient()
    feedBanner(client)
    const cmd = client.send('bogus-command')
    client.feed('%begin 1 101 1\nparse error: unknown command: bogus-command\n%error 1 101 1\n')
    await expect(cmd).rejects.toThrow(/unknown command/)
  })

  it('treats %-prefixed lines inside a reply block as body, not notifications', async () => {
    const { client, notifications } = makeClient()
    feedBanner(client)
    const cmd = client.send('display-message -p #{pane_id}')
    client.feed('%begin 1 101 1\n%output-looking-line\n%end 1 101 1\n')
    await expect(cmd).resolves.toBe('%output-looking-line')
    expect(notifications).toHaveLength(0)
  })

  it('dispatches notifications outside reply blocks', () => {
    const { client, notifications } = makeClient()
    feedBanner(client)
    client.feed('%subscription-changed status $0 @0 0 %3 : ✳ idle\n%output %3 data\n')
    expect(notifications).toEqual([
      { kind: 'subscription', name: 'status', paneId: '%3', value: '✳ idle' },
      { kind: 'output', paneId: '%3' },
    ])
  })

  it('handles chunks split mid-line and CRLF endings', async () => {
    const { client } = makeClient()
    feedBanner(client)
    const cmd = client.send('display-message -p ok')
    client.feed('%begin 1 1')
    client.feed('01 1\r\nok\r\n%end 1 101 1\r\n')
    await expect(cmd).resolves.toBe('ok')
  })

  it('ignores a reply with nothing pending (post-banner, tmux-initiated)', () => {
    const { client, notifications } = makeClient()
    feedBanner(client)
    client.feed('%begin 1 101 1\nstray\n%end 1 101 1\n')
    client.feed('%output %3 still-works\n')
    expect(notifications).toEqual([{ kind: 'output', paneId: '%3' }])
  })

  it('fail() rejects in-flight sends and everything after', async () => {
    const { client } = makeClient()
    feedBanner(client)
    const inFlight = client.send('display-message -p ok')
    client.fail(new Error('stream died'))
    await expect(inFlight).rejects.toThrow('stream died')
    await expect(client.send('anything')).rejects.toThrow('stream died')
  })

  it('rejects immediately when the write throws', async () => {
    const client = new ControlModeClient(
      () => { throw new Error('EPIPE') },
      vi.fn(),
    )
    await expect(client.send('display-message -p ok')).rejects.toThrow('EPIPE')
  })
})
