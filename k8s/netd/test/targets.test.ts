import { describe, expect, it } from 'vitest'
import {
  LABEL_WORKTREE_ID,
  PROXY_APP_NAME,
  distinctTargets,
  selectTargets,
  type NetdPod,
} from 'yaac-netd/targets'

const INSTALL_NS = 'yaac'
const OUTER_IP = '10.96.0.50'

function pod(name: string, namespace: string, labels: Record<string, string>, podIp = '10.244.0.9'): NetdPod {
  return { name, namespace, podIp, labels }
}

function select(pods: NetdPod[]) {
  return selectTargets({ pods, installNamespace: INSTALL_NS, outerProxyClusterIp: OUTER_IP })
}

describe('selectTargets', () => {
  it('an install-namespace worktree pod goes to the proxy', () => {
    const p = pod('sess-1', INSTALL_NS, { [LABEL_WORKTREE_ID]: 's1' })
    expect(select([p])).toEqual([{ pod: p, target: { key: `outer/${INSTALL_NS}`, ip: OUTER_IP } }])
  })

  it('never redirects the proxy itself (a self-redirect would loop)', () => {
    expect(select([pod('proxy', INSTALL_NS, { app: PROXY_APP_NAME })])).toEqual([])
  })

  it('ignores non-worktree pods in the install namespace', () => {
    expect(select([pod('registry', INSTALL_NS, { app: 'yaac-registry' })])).toEqual([])
  })

  it('ignores pods with no IP yet', () => {
    expect(select([pod('sess', INSTALL_NS, { [LABEL_WORKTREE_ID]: 's' }, '')])).toEqual([])
  })

  it('never redirects ANOTHER install\'s worktree pods', () => {
    // The bug this guards: netd watches every namespace, so without the
    // ownership check the real install's netd redirects an e2e install's
    // pods at its own proxy. Both installs append a PREROUTING jump, so the
    // first-appended chain wins and the loser's pods reach a proxy that
    // cannot resolve them — silent, total egress loss for whichever install
    // lost, decided by restart order.
    expect(select([pod('theirs', 'yaac-test-r1', { [LABEL_WORKTREE_ID]: 't1' })])).toEqual([])
  })

  it('selects nothing at all when the proxy is not up yet', () => {
    expect(selectTargets({
      pods: [pod('sess', INSTALL_NS, { [LABEL_WORKTREE_ID]: 's' })],
      installNamespace: INSTALL_NS,
      outerProxyClusterIp: null,
    })).toEqual([])
  })

  it('is stably ordered so renderings are byte-stable between passes', () => {
    const a = pod('a', INSTALL_NS, { [LABEL_WORKTREE_ID]: '1' })
    const b = pod('b', INSTALL_NS, { [LABEL_WORKTREE_ID]: '2' })
    expect(select([b, a]).map((s) => s.pod.name)).toEqual(['a', 'b'])
  })
})

describe('distinctTargets', () => {
  it('dedupes by key in stable order', () => {
    const selected = select([
      pod('s1', INSTALL_NS, { [LABEL_WORKTREE_ID]: '1' }),
      pod('s2', INSTALL_NS, { [LABEL_WORKTREE_ID]: '2' }),
    ])
    expect(distinctTargets(selected).map((t) => t.key)).toEqual([`outer/${INSTALL_NS}`])
  })
})
