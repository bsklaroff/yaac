import { describe, it, expect } from 'vitest'
import {
  CA_CERT_PATH,
  CA_CONFIGMAP_KEY,
  CA_CONFIGMAP_NAME,
  CA_MOUNT_DIR,
  NESTED_GRAPHROOT_PATH,
  SHARED_IMAGE_STORE_DST_PATH,
  SHARED_IMAGE_STORE_PATH,
  assertSessionLabels,
  buildSessionJobManifest,
  parseEnvEntry,
  type NestedContainersParams,
  type SessionJobParams,
} from '@/lib/k8s/pod-spec'

describe('CA constants', () => {
  it('compose the in-container cert path from dir + key', () => {
    expect(CA_CONFIGMAP_NAME).toBe('yaac-proxy-ca')
    expect(CA_CONFIGMAP_KEY).toBe('proxy-ca.pem')
    expect(CA_MOUNT_DIR).toBe('/etc/yaac/certs')
    expect(CA_CERT_PATH).toBe('/etc/yaac/certs/proxy-ca.pem')
  })
})

describe('parseEnvEntry', () => {
  it('splits NAME=VALUE at the first equals sign', () => {
    expect(parseEnvEntry('FOO=bar')).toEqual({ name: 'FOO', value: 'bar' })
  })

  it('keeps equals signs inside the value', () => {
    expect(parseEnvEntry('URL=http://x:sid@host:10255?a=b')).toEqual({
      name: 'URL',
      value: 'http://x:sid@host:10255?a=b',
    })
  })

  it('returns an empty value for a bare name', () => {
    expect(parseEnvEntry('NOVALUE')).toEqual({ name: 'NOVALUE', value: '' })
  })

  it('handles an empty value after the equals sign', () => {
    expect(parseEnvEntry('EMPTY=')).toEqual({ name: 'EMPTY', value: '' })
  })
})

function params(overrides: Partial<SessionJobParams> = {}): SessionJobParams {
  return {
    jobName: 'yaac-demo-abcd',
    namespace: 'test-ns',
    labels: {
      'yaac.project': 'demo',
      'yaac.session-id': 'abcd',
      'yaac.data-dir-hash': 'ddh',
      'yaac.tool': 'claude',
    },
    image: 'localhost:5000/yaac-tools:abc',
    env: ['YAAC_SESSION_ID=abcd', 'X=a=b'],
    hostPathMounts: [],
    memoryLimitBytes: 8 * 1024 ** 3,
    egress: {
      redirectImage: 'localhost:5001/yaac-redirect-init:def',
      relayImage: 'localhost:5001/yaac-relay:abc',
      relayHttpsPort: 15001,
      relayHttpPort: 15002,
      relayConnectPort: 15003,
      relayDnsPort: 15004,
      relayUid: 1337,
      // The pinned proxy Service VIP — an IP, never a DNS name.
      proxyHost: '10.96.0.179',
      transparentHttpsPort: 10256,
      transparentHttpPort: 10257,
      transparentTunnelPort: 10258,
      sessionId: 'abcd',
      relayToken: 'deadbeef'.repeat(8),
    },
    ...overrides,
  }
}

interface Manifest {
  apiVersion: string
  kind: string
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: {
    backoffLimit: number
    template: {
      metadata: { labels: Record<string, string> }
      spec: {
        restartPolicy: string
        terminationGracePeriodSeconds: number
        automountServiceAccountToken: boolean
        enableServiceLinks: boolean
        hostUsers?: boolean
        securityContext: { seccompProfile: { type: string }; fsGroup?: number }
        initContainers: Array<{
          name: string
          image: string
          imagePullPolicy: string
          restartPolicy?: string
          command?: string[]
          securityContext: {
            runAsUser?: number
            allowPrivilegeEscalation?: boolean
            capabilities?: { add?: string[]; drop?: string[] }
          }
          env: Array<{ name: string; value: string }>
          startupProbe?: { exec: { command: string[] } }
          volumeMounts?: Array<{ name: string; mountPath: string }>
        }>
        containers: Array<{
          name: string
          image: string
          imagePullPolicy: string
          workingDir: string
          env: Array<{ name: string; value: string }>
          securityContext?: {
            capabilities?: { add?: string[] }
            allowPrivilegeEscalation?: boolean
          }
          volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>
          resources: { limits: Record<string, string> }
        }>
        volumes: Array<{
          name: string
          hostPath?: { path: string; type: string }
          configMap?: { name: string }
          emptyDir?: Record<string, never>
        }>
      }
    }
  }
}

function build(overrides: Partial<SessionJobParams> = {}): Manifest {
  return buildSessionJobManifest(params(overrides)) as unknown as Manifest
}

describe('buildSessionJobManifest', () => {
  it('builds a single-shot Job: backoffLimit 0, restartPolicy Never', () => {
    const m = build()
    expect(m.apiVersion).toBe('batch/v1')
    expect(m.kind).toBe('Job')
    expect(m.spec.backoffLimit).toBe(0)
    expect(m.spec.template.spec.restartPolicy).toBe('Never')
  })

  it('sets name/namespace and applies labels to both the Job and the pod template', () => {
    const m = build()
    expect(m.metadata.name).toBe('yaac-demo-abcd')
    expect(m.metadata.namespace).toBe('test-ns')
    expect(m.metadata.labels).toEqual(params().labels)
    expect(m.spec.template.metadata.labels).toEqual(params().labels)
  })

  it('hardens the pod: no service account token, no service links', () => {
    const spec = build().spec.template.spec
    expect(spec.automountServiceAccountToken).toBe(false)
    expect(spec.enableServiceLinks).toBe(false)
  })

  it('hardens the pod: default seccomp profile and a user namespace', () => {
    const spec = build().spec.template.spec
    expect(spec.securityContext).toEqual({ seccompProfile: { type: 'RuntimeDefault' } })
    expect(spec.hostUsers).toBe(false)
  })

  it('defaults terminationGracePeriodSeconds to 5 and honors an override', () => {
    expect(build().spec.template.spec.terminationGracePeriodSeconds).toBe(5)
    expect(
      build({ terminationGracePeriodSeconds: 30 }).spec.template.spec.terminationGracePeriodSeconds,
    ).toBe(30)
  })

  it('configures the session container: image, pull policy, workdir, memory limit', () => {
    const c = build().spec.template.spec.containers[0]
    expect(c.name).toBe('session')
    expect(c.image).toBe('localhost:5000/yaac-tools:abc')
    expect(c.imagePullPolicy).toBe('IfNotPresent')
    expect(c.workingDir).toBe('/workspace')
    expect(c.resources.limits.memory).toBe(String(8 * 1024 ** 3))
  })

  it('parses env entries, preserving equals signs inside values', () => {
    const c = build().spec.template.spec.containers[0]
    expect(c.env).toEqual([
      { name: 'YAAC_SESSION_ID', value: 'abcd' },
      { name: 'X', value: 'a=b' },
    ])
  })

  it('renders hostPath mounts with the Directory default, File, and "" types', () => {
    const m = build({
      hostPathMounts: [
        { hostPath: '/host/dir', mountPath: '/workspace' },
        { hostPath: '/host/file.json', mountPath: '/home/yaac/.claude.json', type: 'File' },
        { hostPath: '/host/any', mountPath: '/mnt/any', type: '' },
      ],
    })
    const { volumes, containers } = m.spec.template.spec
    expect(volumes[0]).toEqual({ name: 'hp-0', hostPath: { path: '/host/dir', type: 'Directory' } })
    expect(volumes[1]).toEqual({ name: 'hp-1', hostPath: { path: '/host/file.json', type: 'File' } })
    expect(volumes[2]).toEqual({ name: 'hp-2', hostPath: { path: '/host/any', type: '' } })
    expect(containers[0].volumeMounts.slice(0, 3)).toEqual([
      { name: 'hp-0', mountPath: '/workspace' },
      { name: 'hp-1', mountPath: '/home/yaac/.claude.json' },
      { name: 'hp-2', mountPath: '/mnt/any' },
    ])
  })

  it('marks readOnly mounts and omits the key otherwise', () => {
    const m = build({
      hostPathMounts: [
        { hostPath: '/ro', mountPath: '/mnt/ro', readOnly: true },
        { hostPath: '/rw', mountPath: '/mnt/rw' },
      ],
    })
    const mounts = m.spec.template.spec.containers[0].volumeMounts
    expect(mounts[0]).toEqual({ name: 'hp-0', mountPath: '/mnt/ro', readOnly: true })
    expect(mounts[1]).toEqual({ name: 'hp-1', mountPath: '/mnt/rw' })
  })

  it('emits redirect-init then relay, with NET_ADMIN only on redirect-init', () => {
    const spec = build().spec.template.spec
    expect(spec.initContainers.map((c) => c.name)).toEqual(['yaac-redirect-init', 'yaac-relay'])

    const redirect = spec.initContainers[0]
    expect(redirect.image).toBe('localhost:5001/yaac-redirect-init:def')
    expect(redirect.imagePullPolicy).toBe('IfNotPresent')
    expect(redirect.securityContext).toEqual({ capabilities: { add: ['NET_ADMIN'] } })
    expect(redirect.restartPolicy).toBeUndefined() // run-to-completion

    // The session container itself must carry no added capability.
    expect(spec.containers[0]).not.toHaveProperty('securityContext')
  })

  it('threads the REDIRECT ports and filter default-deny params into the redirect-init env', () => {
    const env = build().spec.template.spec.initContainers[0].env
    expect(env).toEqual([
      { name: 'REDIRECT_HTTPS_PORT', value: '15001' },
      { name: 'REDIRECT_HTTP_PORT', value: '15002' },
      { name: 'REDIRECT_DNS_PORT', value: '15004' },
      // Filter-table default-deny: the carve-out is keyed on the relay
      // uid and scoped to the proxy VIP's transport ports — exactly the
      // pinned ClusterIP, never a CIDR-wide rule.
      { name: 'RELAY_UID', value: '1337' },
      { name: 'PROXY_CLUSTER_IP', value: '10.96.0.179' },
      { name: 'TRANSPARENT_HTTPS_PORT', value: '10256' },
      { name: 'TRANSPARENT_HTTP_PORT', value: '10257' },
      { name: 'TRANSPARENT_TUNNEL_PORT', value: '10258' },
    ])
  })

  it('runs the relay as a native sidecar (restartPolicy Always) with a ready-file probe and no caps', () => {
    const relay = build().spec.template.spec.initContainers[1]
    expect(relay.name).toBe('yaac-relay')
    expect(relay.image).toBe('localhost:5001/yaac-relay:abc')
    expect(relay.restartPolicy).toBe('Always')
    expect(relay.securityContext.runAsUser).toBe(1337)
    expect(relay.securityContext.allowPrivilegeEscalation).toBe(false)
    expect(relay.securityContext.capabilities).toEqual({ drop: ['ALL'] })
    // Exec probe on a ready file the relay writes after binding loopback
    // (a tcpSocket probe would dial the unreachable pod IP).
    expect(relay.startupProbe?.exec.command).toEqual([
      'sh', '-c', 'test -f /tmp/yaac-relay-ready',
    ])
  })

  it('carries the session credential and all four listen ports on the relay container only', () => {
    const spec = build().spec.template.spec
    const relayEnv = spec.initContainers[1].env
    expect(relayEnv).toContainEqual({ name: 'SESSION_ID', value: 'abcd' })
    expect(relayEnv).toContainEqual({ name: 'RELAY_TOKEN', value: 'deadbeef'.repeat(8) })
    // The pinned VIP rides through verbatim — the relay never resolves DNS.
    expect(relayEnv).toContainEqual({ name: 'PROXY_HOST', value: '10.96.0.179' })
    expect(relayEnv).toContainEqual({ name: 'TRANSPARENT_HTTPS_PORT', value: '10256' })
    expect(relayEnv).toContainEqual({ name: 'TRANSPARENT_HTTP_PORT', value: '10257' })
    expect(relayEnv).toContainEqual({ name: 'TRANSPARENT_TUNNEL_PORT', value: '10258' })
    expect(relayEnv).toContainEqual({ name: 'LISTEN_HTTPS_PORT', value: '15001' })
    expect(relayEnv).toContainEqual({ name: 'LISTEN_HTTP_PORT', value: '15002' })
    expect(relayEnv).toContainEqual({ name: 'LISTEN_CONNECT_PORT', value: '15003' })
    expect(relayEnv).toContainEqual({ name: 'LISTEN_DNS_PORT', value: '15004' })
    // The workload container must never see the token.
    const sessionEnvNames = spec.containers[0].env.map((e) => e.name)
    expect(sessionEnvNames).not.toContain('RELAY_TOKEN')
  })

  it('emits no EXTRA_TCP_ACCEPT env and no hostAliases by default', () => {
    const spec = build().spec.template.spec
    const redirectEnvNames = spec.initContainers[0].env.map((e) => e.name)
    expect(redirectEnvNames).not.toContain('EXTRA_TCP_ACCEPT')
    expect(spec).not.toHaveProperty('hostAliases')
    // Empty lists behave like absent ones — byte-identical output.
    const bare = buildSessionJobManifest(params())
    const empty = buildSessionJobManifest({
      ...params({ hostAliases: [] }),
      egress: { ...params().egress, extraTcpAccept: [] },
    })
    expect(JSON.stringify(empty)).toBe(JSON.stringify(bare))
  })

  it('joins extraTcpAccept pairs into the redirect-init EXTRA_TCP_ACCEPT env', () => {
    const m = build({
      egress: {
        ...params().egress,
        extraTcpAccept: ['10.96.12.34:5000', '10.96.56.78:8443'],
      },
    })
    const env = m.spec.template.spec.initContainers[0].env
    expect(env).toContainEqual({
      name: 'EXTRA_TCP_ACCEPT',
      value: '10.96.12.34:5000,10.96.56.78:8443',
    })
    // The carve-out rides the redirect-init container only.
    const relayEnvNames = m.spec.template.spec.initContainers[1].env.map((e) => e.name)
    expect(relayEnvNames).not.toContain('EXTRA_TCP_ACCEPT')
  })

  it('emits pod hostAliases when provided (registry name → pinned VIP)', () => {
    const m = build({
      hostAliases: [{ ip: '10.96.12.34', hostnames: ['yaac-reg-demo-abcd1234.test-ns.svc'] }],
    }) as unknown as Manifest & {
      spec: { template: { spec: { hostAliases?: Array<{ ip: string; hostnames: string[] }> } } }
    }
    expect(m.spec.template.spec.hostAliases).toEqual([
      { ip: '10.96.12.34', hostnames: ['yaac-reg-demo-abcd1234.test-ns.svc'] },
    ])
  })

  it('always appends the proxy-CA ConfigMap volume mounted read-only at the CA dir', () => {
    const m = build()
    const { volumes, containers } = m.spec.template.spec
    expect(volumes).toContainEqual({
      name: 'proxy-ca',
      configMap: { name: CA_CONFIGMAP_NAME },
    })
    expect(containers[0].volumeMounts).toContainEqual({
      name: 'proxy-ca',
      mountPath: CA_MOUNT_DIR,
      readOnly: true,
    })
  })
})

describe('buildSessionJobManifest — nestedContainers', () => {
  const nested: NestedContainersParams = {
    uid: 501,
    sharedImagesHostPath: '/var/lib/yaac/imagecache/ddh16/demo',
  }

  it('leaves the non-nested manifest byte-identical when nested is absent', () => {
    const withoutField = buildSessionJobManifest(params())
    const withUndefined = buildSessionJobManifest({ ...params(), nested: undefined })
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(withoutField))

    const spec = build().spec.template.spec
    expect(spec.securityContext).toEqual({ seccompProfile: { type: 'RuntimeDefault' } })
    expect(spec.initContainers.map((c) => c.name)).toEqual(['yaac-redirect-init', 'yaac-relay'])
    expect(spec.volumes.some((v) => v.name === 'podman-graphroot' || v.name === 'shared-images')).toBe(false)
    expect(spec.containers[0].resources.limits).toEqual({ memory: String(8 * 1024 ** 3) })
  })

  it('keeps RuntimeDefault and adds only SYS_ADMIN on the session container', () => {
    const spec = build({ nested }).spec.template.spec
    // seccompProfile stays RuntimeDefault — the userns-scoped cap is what
    // unlocks the mount family in containerd's profile, not Unconfined.
    expect(spec.securityContext.seccompProfile).toEqual({ type: 'RuntimeDefault' })
    expect(spec.hostUsers).toBe(false)
    // No explicit allowPrivilegeEscalation — the kubelet forces it true
    // under CAP_SYS_ADMIN, so it would be redundant.
    expect(spec.containers[0].securityContext).toEqual({
      capabilities: { add: ['SYS_ADMIN'] },
    })
  })

  it('sets fsGroup to the yaac uid for the graphroot emptyDir', () => {
    const spec = build({ nested }).spec.template.spec
    expect(spec.securityContext.fsGroup).toBe(501)
    expect(spec.volumes).toContainEqual({ name: 'podman-graphroot', emptyDir: {} })
    expect(spec.containers[0].volumeMounts).toContainEqual({
      name: 'podman-graphroot',
      mountPath: NESTED_GRAPHROOT_PATH,
    })
  })

  it('mounts the shared image store rw and chowns it via a first init container', () => {
    const spec = build({ nested }).spec.template.spec
    expect(spec.volumes).toContainEqual({
      name: 'shared-images',
      hostPath: { path: '/var/lib/yaac/imagecache/ddh16/demo', type: 'DirectoryOrCreate' },
    })
    // rw mount (no readOnly key): additionalimagestores creates lock dirs.
    expect(spec.containers[0].volumeMounts).toContainEqual({
      name: 'shared-images',
      mountPath: SHARED_IMAGE_STORE_PATH,
    })
    // A second mount of the same volume — the promoter's write-side
    // destination root, dodging the read-only additional-store lock.
    expect(spec.containers[0].volumeMounts).toContainEqual({
      name: 'shared-images',
      mountPath: SHARED_IMAGE_STORE_DST_PATH,
    })

    // The chown init runs FIRST — before the landed redirect-init/relay
    // pair — as root-in-userns, on the session image itself.
    expect(spec.initContainers.map((c) => c.name)).toEqual([
      'yaac-imagestore-init', 'yaac-redirect-init', 'yaac-relay',
    ])
    const chown = spec.initContainers[0]
    expect(chown.image).toBe('localhost:5000/yaac-tools:abc')
    expect(chown.securityContext).toEqual({ runAsUser: 0 })
    expect(chown.command).toEqual([
      'sh', '-c', `chown 501:501 ${SHARED_IMAGE_STORE_PATH}`,
    ])
    expect(chown.volumeMounts).toEqual([
      { name: 'shared-images', mountPath: SHARED_IMAGE_STORE_PATH },
    ])
  })

  it('keeps the resource limits identical to a non-nested pod (memory only)', () => {
    const limits = build({ nested }).spec.template.spec.containers[0].resources.limits
    expect(limits).toEqual({ memory: String(8 * 1024 ** 3) })
  })
})

describe('assertSessionLabels', () => {
  it('passes when the session-id label is present', () => {
    expect(() => assertSessionLabels({ 'yaac.session-id': 'abc' })).not.toThrow()
  })

  it('throws when the session-id label is missing or empty', () => {
    expect(() => assertSessionLabels({})).toThrow(/yaac\.session-id/)
    expect(() => assertSessionLabels({ 'yaac.session-id': '' })).toThrow(/yaac\.session-id/)
  })
})
