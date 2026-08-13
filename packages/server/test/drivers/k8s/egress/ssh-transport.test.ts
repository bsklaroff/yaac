import { describe, it, expect } from 'vitest'
import { workspaceSshTransport } from '#drivers/k8s/egress/ssh-transport'
import {
  SSH_AGENT_PORT,
  SSH_AGENT_SOCKET_PATH,
  SSH_TUNNEL_SENTINEL,
  TUNNEL_INGRESS_PORT,
} from '#drivers/k8s/substrate'

const KNOWN_HOSTS = '/data/projects/demo/known_hosts'

describe('workspaceSshTransport', () => {
  it('tunnels git\'s SSH through the proxy with CONNECT, so the allowlist still sees the host', () => {
    // A raw port-22 redirect would lose the hostname; CONNECT carries it.
    const { env } = workspaceSshTransport(KNOWN_HOSTS, '10.96.0.5')
    const gitSsh = env.find((e) => e.startsWith('GIT_SSH_COMMAND='))

    expect(gitSsh).toContain(`--proxy ${SSH_TUNNEL_SENTINEL}:${TUNNEL_INGRESS_PORT}`)
    expect(gitSsh).toContain('--proxy-type http')
    expect(gitSsh).toContain('%h %p')
  })

  it('verifies against the project\'s own known_hosts, mounted read-only', () => {
    const { mounts, env } = workspaceSshTransport(KNOWN_HOSTS, '10.96.0.5')

    expect(mounts).toEqual([{
      source: { kind: 'hostPath', path: KNOWN_HOSTS, type: 'File' },
      mountPath: '/home/yaac/.ssh/yaac/known_hosts',
      readOnly: true,
    }])
    const gitSsh = env.find((e) => e.startsWith('GIT_SSH_COMMAND='))
    expect(gitSsh).toContain('UserKnownHostsFile=/home/yaac/.ssh/yaac/known_hosts')
    // The whole point of shipping our own file: an unknown host must fail
    // rather than be accepted on first sight.
    expect(gitSsh).toContain('StrictHostKeyChecking=yes')
    // And nothing the user's own ssh config could weaken.
    expect(gitSsh).toContain('-F /dev/null')
  })

  it('points identity at the forwarded agent — never a key inside the workspace', () => {
    // The rendezvous is a TCP hop to the proxy, re-exposed in-pod as the
    // socket SSH_AUTH_SOCK names, so a pod scheduled away from the proxy
    // still gets an agent.
    const { env, mounts } = workspaceSshTransport(KNOWN_HOSTS, '10.96.0.5')

    expect(env).toContain(`SSH_AUTH_SOCK=${SSH_AGENT_SOCKET_PATH}`)
    expect(env).toContain(`YAAC_SSH_AGENT_UPSTREAM=10.96.0.5:${SSH_AGENT_PORT}`)
    expect(mounts.map((m) => m.mountPath)).not.toContain('/home/yaac/.ssh/id_rsa')
    expect(env.join('\n')).not.toContain('IdentityFile')
  })
})
