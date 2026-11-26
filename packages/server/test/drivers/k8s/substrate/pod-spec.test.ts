import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  installSecurityContext,
  netshimContainer,
  processIdentity,
  sentryTmpfsAnnotations,
  socketVolume,
  socketsNodePath,
} from '#drivers/k8s/substrate'

describe('sentryTmpfsAnnotations', () => {
  it('keys the sentry tmpfs hints on the volume name and caps it at the size (builder pods use 16Gi)', () => {
    expect(sentryTmpfsAnnotations('podman-graphroot', 16 * 1024 ** 3)).toEqual({
      'dev.gvisor.spec.mount.podman-graphroot.type': 'bind',
      'dev.gvisor.spec.mount.podman-graphroot.share': 'container',
      'dev.gvisor.spec.mount.podman-graphroot.options': `rw,size=${16 * 1024 ** 3}`,
    })
  })
})

describe('installSecurityContext', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stamps the identity it is handed, and joins group 0 for the image', () => {
    // The uid is chosen per install. Group 0 lets one image run at any uid
    // (docs/arbitrary-uid-images.md).
    expect(installSecurityContext({ uid: 1000, gid: 1000 })).toEqual({
      runAsUser: 1000,
      runAsGroup: 1000,
      supplementalGroups: [0],
    })
  })

  it('defaults to this process\'s identity, which inside the server pod is the install\'s', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(501)
    vi.spyOn(process, 'getgid').mockReturnValue(20)
    expect(installSecurityContext()).toEqual({
      runAsUser: 501,
      runAsGroup: 20,
      supplementalGroups: [0],
    })
  })

})

describe('processIdentity', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads this process\'s uid and gid', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000)
    vi.spyOn(process, 'getgid').mockReturnValue(1000)
    expect(processIdentity()).toEqual({ uid: 1000, gid: 1000 })
  })

  it('refuses to invent a uid when the platform has none', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(undefined as unknown as number)
    expect(() => processIdentity()).toThrow(/POSIX/)
  })
})

describe('socketVolume', () => {
  it('names the sandbox\'s own directory under the install\'s socket root, made by kubelet when absent', () => {
    // The relay finds a pod's directory by this volume's name and path.
    expect(socketVolume('ws-1.0f0f0f0f')).toEqual({
      name: 'sockets', hostPath: { path: `${socketsNodePath()}/ws-1.0f0f0f0f`, type: 'DirectoryOrCreate' },
    })
  })
})

describe('netshimContainer', () => {
  it('runs netshim from the given image as a restarting sidecar with only the network capabilities it needs', () => {
    expect(netshimContainer('registry.local/yaac-mountd:abc')).toEqual({
      name: 'netshim',
      image: 'registry.local/yaac-mountd:abc',
      imagePullPolicy: 'IfNotPresent',
      restartPolicy: 'Always',
      command: ['/usr/local/bin/netshim'],
      // Its address goes on loopback, for a program that dials its own
      // hostname.
      env: [{ name: 'POD_IP', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } }],
      // Root for iptables, writable root filesystem for its lock, and no
      // capability but the two its route and NAT rules take.
      securityContext: { runAsUser: 0, runAsGroup: 0, capabilities: { drop: ['ALL'], add: ['NET_ADMIN', 'NET_RAW'] } },
      // Started once its ingress socket is bound, which it binds last.
      startupProbe: { exec: { command: ['test', '-S', '/run/yaac/ingress.sock'] }, periodSeconds: 1, failureThreshold: 30 },
      // Limits like every container, or kubelet sets no pod memory cap.
      resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '1', memory: '128Mi' } },
      volumeMounts: [{ name: 'sockets', mountPath: '/run/yaac' }],
    })
  })
})
