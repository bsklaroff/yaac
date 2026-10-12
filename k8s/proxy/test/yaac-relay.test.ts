import { describe, it, expect } from 'vitest'
import { relayHeaders, relayTarget } from 'yaac-proxy-sidecar/yaac-relay'

const RELAY = 'http://yaac-server-mama.ns.svc.cluster.local:8788/api/workspace/mama'
const REPO = '/api/workspace/git/0a0a0a0a-0000-4000-8000-000000000001.git'

describe('relayTarget', () => {
  it('relays yaac-mama and a hosted remote\'s smart-HTTP paths, and nothing else', () => {
    expect(relayTarget('/api/workspace/mama', RELAY)).toBe(RELAY)
    // A git request keeps its own path and query on the listener's origin.
    expect(relayTarget(`${REPO}/info/refs?service=git-receive-pack`, RELAY))
      .toBe(`http://yaac-server-mama.ns.svc.cluster.local:8788${REPO}/info/refs?service=git-receive-pack`)
    expect(relayTarget(`${REPO}/git-upload-pack`, RELAY))
      .toBe(`http://yaac-server-mama.ns.svc.cluster.local:8788${REPO}/git-upload-pack`)
    expect(relayTarget(`${REPO}/git-receive-pack`, RELAY))
      .toBe(`http://yaac-server-mama.ns.svc.cluster.local:8788${REPO}/git-receive-pack`)

    // The dumb protocol's file reads, other server paths, and traversal are
    // not relayed.
    expect(relayTarget(`${REPO}/HEAD`, RELAY)).toBeNull()
    expect(relayTarget(`${REPO}/objects/info/packs`, RELAY)).toBeNull()
    expect(relayTarget('/api/workspace/list', RELAY)).toBeNull()
    expect(relayTarget('/api/workspace/git/../../project/list/info/refs', RELAY)).toBeNull()
    expect(relayTarget('/api/workspace/git/../info/refs', RELAY)).toBeNull()
    expect(relayTarget('/cmd', RELAY)).toBeNull()
    expect(relayTarget('/', RELAY)).toBeNull()
  })
})

describe('relayHeaders', () => {
  it('names the workspace, authenticates as the proxy, and forwards only what git and yaac-mama need', () => {
    const headers = relayHeaders({
      'content-type': 'application/x-git-receive-pack-request',
      'content-encoding': 'gzip',
      'git-protocol': 'version=2',
      'accept': 'application/x-git-receive-pack-result',
      // A workspace must not be able to name another workspace or a bearer.
      'x-yaac-workspace-id': 'someone-else',
      'authorization': 'Bearer forged',
      'host': '127.0.0.1',
      'cookie': 'x=y',
    }, 'ws-1', 'proxy-secret')
    expect(headers).toEqual({
      'authorization': 'Bearer proxy-secret',
      'x-yaac-workspace-id': 'ws-1',
      'content-type': 'application/x-git-receive-pack-request',
      'content-encoding': 'gzip',
      'git-protocol': 'version=2',
      'accept': 'application/x-git-receive-pack-result',
    })
  })
})
