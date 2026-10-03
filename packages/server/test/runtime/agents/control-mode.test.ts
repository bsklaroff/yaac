import { describe, it, expect } from 'vitest'
import { ControlModeClient, type ControlModeNotification } from '#runtime/agents'

/** A client wired to capture writes and notifications, past the reply
 *  block tmux sends for the attach itself. */
function attached(): { client: ControlModeClient; writes: string[]; notes: ControlModeNotification[] } {
  const writes: string[] = []
  const notes: ControlModeNotification[] = []
  const client = new ControlModeClient((data) => writes.push(data), (n) => notes.push(n))
  client.feed('%begin 1 100 0\n%end 1 100 0\n%session-changed $0 yaac\n')
  return { client, writes, notes }
}

describe('ControlModeClient', () => {
  it('parses the notifications outside reply blocks', () => {
    const { client, notes } = attached()
    client.feed([
      '%subscription-changed status $0 @0 0 %3 : fix: parse a : b',
      '%subscription-changed status $0 @0 0 %4 : ',
      '%output %5 \\033[1mhi there',
      '%layout-change @2 b25d,80x24,0,0,3 b25d,80x24,0,0,3 *',
      '%window-add @4',
      '%window-close @4',
      '%unlinked-window-close @5',
      '%exit detached',
      // Ignored, and a malformed subscription.
      '%pane-mode-changed %1',
      '%subscription-changed status $0',
      'noise',
    ].join('\n') + '\n')
    expect(notes).toEqual([
      // The value follows the first ` : ` and keeps later colons.
      { kind: 'subscription', name: 'status', paneId: '%3', value: 'fix: parse a : b' },
      { kind: 'subscription', name: 'status', paneId: '%4', value: '' },
      // Output stays escaped as tmux sent it.
      { kind: 'output', paneId: '%5', data: '\\033[1mhi there' },
      { kind: 'layout', windowId: '@2', layout: 'b25d,80x24,0,0,3' },
      { kind: 'windows-changed' },
      { kind: 'windows-changed', closedWindowId: '@4' },
      { kind: 'windows-changed', closedWindowId: '@5' },
      { kind: 'exit' },
    ])
  })

  it('matches replies FIFO, ending a block only on its own %end', async () => {
    const writes: string[] = []
    const notes: ControlModeNotification[] = []
    const client = new ControlModeClient((data) => writes.push(data), (n) => notes.push(n))
    // Sent before the attach's own reply arrives, which must not answer it.
    const first = client.send("display-message -p '#{pane_id}'")
    client.feed('%begin 1 100 0\n%end 1 100 0\n')
    const capture = client.send('capture-pane -p')
    const failing = client.send('bogus-command')
    expect(writes).toEqual(["display-message -p '#{pane_id}'\n", 'capture-pane -p\n', 'bogus-command\n'])
    // Split mid-line, with CRLF endings.
    client.feed('%begin 1 1')
    client.feed('01 1\r\n%3\r\n%end 1 101 1\r\n')
    // Captured text can look like a block end or a notification.
    client.feed('%begin 9 102 1\n%end 1 2 3\n%output %1 x\n%end 9 102 1\n')
    client.feed('%begin 1 103 1\nunknown command: bogus-command\n%error 1 103 1\n')
    await expect(first).resolves.toBe('%3')
    await expect(capture).resolves.toBe('%end 1 2 3\n%output %1 x')
    await expect(failing).rejects.toThrow(/unknown command/)
    expect(notes).toEqual([])
    expect(client.repliesSeen).toBe(3)

    // A reply nobody waits for is dropped without disturbing what follows.
    client.feed('%begin 1 104 1\nstray\n%end 1 104 1\n%output %3 still-works\n')
    expect(notes).toEqual([{ kind: 'output', paneId: '%3', data: 'still-works' }])
  })

  it('sends a group on one line and stays aligned when one of it fails', async () => {
    const { client, writes } = attached()
    const group = client.sendGroup(['display -p a', 'capture-pane -t %9', 'display -p c'])
    const after = client.send('display -p after')
    expect(writes).toEqual(['display -p a ; capture-pane -t %9 ; display -p c\n', 'display -p after\n'])
    expect(client.commandsSent).toBe(4)
    // tmux skips the rest of a line after a failing command.
    client.feed('%begin 1 101 1\na\n%end 1 101 1\n')
    client.feed("%begin 1 102 1\ncan't find pane: %9\n%error 1 102 1\n")
    expect(client.repliesSeen).toBe(3)
    client.feed('%begin 1 103 1\nafter\n%end 1 103 1\n')
    await expect(group).rejects.toThrow(/can't find pane/)
    await expect(after).resolves.toBe('after')

    const ok = client.sendGroup(['display -p x', 'display -p y'])
    client.feed('%begin 1 104 1\nx\n%end 1 104 1\n%begin 1 105 1\ny\n%end 1 105 1\n')
    await expect(ok).resolves.toEqual(['x', 'y'])
  })

  it('fails in-flight and later sends once torn down or unwritable', async () => {
    const { client } = attached()
    const inFlight = client.send('display-message -p ok')
    client.fail(new Error('stream died'))
    await expect(inFlight).rejects.toThrow('stream died')
    await expect(client.send('anything')).rejects.toThrow('stream died')

    const broken = new ControlModeClient(() => { throw new Error('EPIPE') }, () => {})
    await expect(broken.send('display-message -p ok')).rejects.toThrow('EPIPE')
    expect(broken.commandsSent).toBe(0)
  })
})
