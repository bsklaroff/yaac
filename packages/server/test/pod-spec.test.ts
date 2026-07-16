import { describe, it, expect } from 'vitest'
import {
  CA_BUNDLE_KEY,
  CA_BUNDLE_PATH,
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
} from '#lib/k8s/pod-spec'

describe('CA constants', () => {
  it('compose the in-container cert path from dir + key', () => {
    expect(CA_CONFIGMAP_NAME).toBe('yaac-proxy-ca')
    expect(CA_CONFIGMAP_KEY).toBe('proxy-ca.pem')
    expect(CA_MOUNT_DIR).toBe('/etc/yaac/certs')
    expect(CA_CERT_PATH).toBe('/etc/yaac/certs/proxy-ca.pem')
  })

  it('compose the combined-bundle path from dir + bundle key', () => {
    expect(CA_BUNDLE_KEY).toBe('ca-bundle.pem')
    expect(CA_BUNDLE_PATH).toBe('/etc/yaac/certs/ca-bundle.pem')
    expect(CA_BUNDLE_PATH).not.toBe(CA_CERT_PATH)
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
    memoryRequestBytes: 1 * 1024 ** 3,
    memoryLimitBytes: 8 * 1024 ** 3,
    // The pinned proxy Service VIP — an IP, never a DNS name.
    proxyHost: '10.96.0.179',
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
      metadata: { labels: Record<string, string>; annotations?: Record<string, string> }
      spec: {
        restartPolicy: string
        terminationGracePeriodSeconds: number
        automountServiceAccountToken: boolean
        enableServiceLinks: boolean
        hostUsers?: boolean
        runtimeClassName?: string
        dnsPolicy?: string
        dnsConfig?: { nameservers: string[] }
        securityContext: { seccompProfile: { type: string }; fsGroup?: number }
        initContainers?: Array<{
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
          resources: { requests: Record<string, string>; limits: Record<string, string> }
        }>
        volumes: Array<{
          name: string
          hostPath?: { path: string; type: string }
          configMap?: { name: string }
          emptyDir?: { medium?: string; sizeLimit?: string }
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

  it('hardens the pod: default seccomp profile', () => {
    const spec = build().spec.template.spec
    expect(spec.securityContext).toEqual({ seccompProfile: { type: 'RuntimeDefault' } })
  })

  it('host pod: stamps the gvisor RuntimeClass and no user namespace', () => {
    const spec = build().spec.template.spec
    expect(spec.runtimeClassName).toBe('gvisor')
    // The sentry is the containment — no hostUsers key at all.
    expect(spec.hostUsers).toBeUndefined()
  })

  it('inner yaac: stamps no RuntimeClass and no userns', () => {
    // Inside a vcluster there are no RuntimeClass objects; the host syncer
    // sets the runtime. No userns of its own (incompatible with gvisor).
    const spec = build({ innerYaac: true }).spec.template.spec
    expect(spec.runtimeClassName).toBeUndefined()
    expect(spec.hostUsers).toBeUndefined()
  })

  it('defaults terminationGracePeriodSeconds to 5 and honors an override', () => {
    expect(build().spec.template.spec.terminationGracePeriodSeconds).toBe(5)
    expect(
      build({ terminationGracePeriodSeconds: 30 }).spec.template.spec.terminationGracePeriodSeconds,
    ).toBe(30)
  })

  it('configures the session container: image, pull policy, workdir, memory request/limit', () => {
    const c = build().spec.template.spec.containers[0]
    expect(c.name).toBe('session')
    expect(c.image).toBe('localhost:5000/yaac-tools:abc')
    expect(c.imagePullPolicy).toBe('IfNotPresent')
    expect(c.workingDir).toBe('/workspace')
    expect(c.resources.requests.memory).toBe(String(1 * 1024 ** 3))
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

  it('injects no per-pod egress sidecars — egress is redirected at the cluster level', () => {
    const spec = build().spec.template.spec
    // No redirect-init / relay; a non-nested pod has no init containers at all.
    expect(spec.initContainers).toBeUndefined()
    // The session container itself must carry no added capability.
    expect(spec.containers[0]).not.toHaveProperty('securityContext')
  })

  it('points the pod resolver at the proxy VIP DNS stub (dnsPolicy None)', () => {
    const spec = build().spec.template.spec
    expect(spec.dnsPolicy).toBe('None')
    expect(spec.dnsConfig).toEqual({ nameservers: ['10.96.0.179'] })
  })

  it('never leaks a relay token into the session container env', () => {
    const spec = build().spec.template.spec
    const sessionEnvNames = spec.containers[0].env.map((e) => e.name)
    expect(sessionEnvNames).not.toContain('RELAY_TOKEN')
  })

  it('never emits hostAliases (in-cluster names resolve via the proxy DNS)', () => {
    const spec = build().spec.template.spec
    expect(spec).not.toHaveProperty('hostAliases')
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
    sharedImagesHostPath: '/var/lib/yaac/imagecache/ddh16/demo',
  }

  it('leaves the non-nested manifest byte-identical when nested is absent', () => {
    const withoutField = buildSessionJobManifest(params())
    const withUndefined = buildSessionJobManifest({ ...params(), nested: undefined })
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(withoutField))

    const spec = build().spec.template.spec
    expect(spec.securityContext).toEqual({ seccompProfile: { type: 'RuntimeDefault' } })
    expect(spec.initContainers).toBeUndefined()
    expect(spec.volumes.some((v) => v.name === 'podman-graphroot' || v.name === 'shared-images')).toBe(false)
    // No graphroot-tmpfs annotations on a non-nested pod.
    expect(build().spec.template.metadata.annotations).toBeUndefined()
    expect(spec.containers[0].resources).toEqual({
      requests: { memory: String(1 * 1024 ** 3) },
      limits: { memory: String(8 * 1024 ** 3) },
    })
  })

  it('nested host pod: maps to the gvisor-nested handler, no userns', () => {
    const spec = build({ nested }).spec.template.spec
    expect(spec.runtimeClassName).toBe('gvisor-nested')
    expect(spec.hostUsers).toBeUndefined()
  })

  it('inner-yaac nested: no RuntimeClass, no userns', () => {
    const spec = build({ nested, innerYaac: true }).spec.template.spec
    expect(spec.runtimeClassName).toBeUndefined()
    expect(spec.hostUsers).toBeUndefined()
  })

  it('adds the rootful engine caps and no fsGroup on the session container', () => {
    const spec = build({ nested }).spec.template.spec
    // seccompProfile stays RuntimeDefault (runsc installs its own host
    // seccomp regardless); no fsGroup — the rootful graphroot is root-owned.
    expect(spec.securityContext).toEqual({ seccompProfile: { type: 'RuntimeDefault' } })
    expect(spec.containers[0].securityContext).toEqual({
      capabilities: {
        add: [
          'SYS_ADMIN', 'SYS_CHROOT', 'MKNOD', 'SETFCAP',
          'NET_RAW', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_RESOURCE',
        ],
      },
    })
  })

  it('backs the graphroot with a sized tmpfs emptyDir + gVisor tmpfs annotations', () => {
    const m = build({ nested })
    const spec = m.spec.template.spec
    const cap = 4 * 1024 ** 3
    expect(spec.volumes).toContainEqual({
      name: 'podman-graphroot',
      emptyDir: { medium: 'Memory', sizeLimit: String(cap) },
    })
    expect(spec.containers[0].volumeMounts).toContainEqual({
      name: 'podman-graphroot',
      mountPath: NESTED_GRAPHROOT_PATH,
    })
    // The runsc mount annotations make it a sentry tmpfs (file caps for
    // setcap builds); keyed on the volume name.
    expect(m.spec.template.metadata.annotations).toEqual({
      'dev.gvisor.spec.mount.podman-graphroot.type': 'tmpfs',
      'dev.gvisor.spec.mount.podman-graphroot.share': 'container',
      'dev.gvisor.spec.mount.podman-graphroot.options': `rw,size=${cap}`,
    })
  })

  it('mounts the shared image store rw at both paths with no chown init', () => {
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
    // The rootful engine reads/writes the store as root, so there is no
    // chown init container anymore.
    expect(spec.initContainers).toBeUndefined()
  })

  it('keeps the resources identical to a non-nested pod (memory only)', () => {
    const resources = build({ nested }).spec.template.spec.containers[0].resources
    expect(resources).toEqual({
      requests: { memory: String(1 * 1024 ** 3) },
      limits: { memory: String(8 * 1024 ** 3) },
    })
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
