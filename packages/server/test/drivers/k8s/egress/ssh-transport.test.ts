import { describe, it, expect } from 'vitest'
import { workspaceSshEnv } from '#drivers/k8s/egress/ssh-transport'
import { SSH_HOST_KEY_ALIAS, SSH_TUNNEL_SENTINEL, TUNNEL_INGRESS_PORT } from '#drivers/k8s/substrate'

describe('workspaceSshEnv', () => {
  const gitSsh = workspaceSshEnv().find((e) => e.startsWith('GIT_SSH_COMMAND=')) ?? ''

  it('tunnels git\'s SSH through the proxy with CONNECT, so the allowlist still sees the host', () => {
    // A raw port-22 redirect would lose the hostname; CONNECT carries it.
    expect(gitSsh).toContain(`--proxy ${SSH_TUNNEL_SENTINEL}:${TUNNEL_INGRESS_PORT}`)
    expect(gitSsh).toContain('--proxy-type http')
    expect(gitSsh).toContain('%h %p')
  })

  it('trusts the proxy\'s host key alone, under one name for every git host', () => {
    // The proxy ends the session, so its key is the one presented whatever
    // host git names; the file sits beside the proxy's CA in every pod.
    expect(gitSsh).toContain('UserKnownHostsFile=/etc/yaac/certs/ssh_known_hosts')
    expect(gitSsh).toContain(`HostKeyAlias=${SSH_HOST_KEY_ALIAS}`)
    // An unknown key fails rather than being trusted on first use.
    expect(gitSsh).toContain('StrictHostKeyChecking=yes')
    // No user ssh config can weaken this.
    expect(gitSsh).toContain('-F /dev/null')
  })

  it('offers no identity: the workspace holds no key and reaches no agent', () => {
    expect(workspaceSshEnv()).toEqual([gitSsh])
    expect(gitSsh).toContain('IdentityAgent=none')
    expect(gitSsh).not.toContain('IdentityFile')
  })
})
