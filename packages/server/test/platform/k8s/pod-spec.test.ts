import { describe, it, expect } from 'vitest'
import {
  CA_CONFIGMAP_NAME,
  NESTED_GRAPHROOT_PATH,
  SSH_AGENT_MOUNT,
  SSH_AGENT_SOCKET_PATH,
  buildSessionJobManifest,
  graphrootMountAnnotations,
} from '#platform/k8s'
// Internals, for fixtures and bounds only: the in-container cert dir, the
// sentry tmpfs cap, and the params the builder takes.
import {
  CA_MOUNT_DIR,
  NESTED_GRAPHROOT_SIZELIMIT_BYTES,
  NESTED_GRAPHROOT_TMPFS_BYTES,
  type SessionJobParams,
} from '#platform/k8s/pod-spec'

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
    cpuRequestMillis: 250,
    ephemeralStorageRequestBytes: 2 * 1024 ** 3,
    ephemeralStorageLimitBytes: 16 * 1024 ** 3,
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
        priorityClassName?: string
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
          lifecycle?: { postStart?: { exec?: { command: string[] } } }
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

  it('configures the session container: image, pull policy, workdir, requests/limits', () => {
    const c = build().spec.template.spec.containers[0]
    expect(c.name).toBe('session')
    expect(c.image).toBe('localhost:5000/yaac-tools:abc')
    expect(c.imagePullPolicy).toBe('IfNotPresent')
    expect(c.workingDir).toBe('/workspace')
    // Every dimension the scheduler bin-packs on is requested — a pod with
    // no cpu request is free capacity as far as the scheduler is concerned.
    expect(c.resources.requests).toEqual({
      cpu: '250m',
      memory: String(1 * 1024 ** 3),
      'ephemeral-storage': String(2 * 1024 ** 3),
    })
    // Memory and disk are capped, cpu deliberately is not: a CFS quota
    // throttles an interactive session even on an idle node.
    expect(c.resources.limits).toEqual({
      memory: String(8 * 1024 ** 3),
      'ephemeral-storage': String(16 * 1024 ** 3),
    })
    expect(c.resources.limits).not.toHaveProperty('cpu')
  })

  it('puts host session pods on the low-priority tier and inner ones on none', () => {
    // Infra (proxy, registries, builders) outranks this, so a full node
    // sheds a session rather than the network every session depends on.
    expect(build().spec.template.spec.priorityClassName).toBe('yaac-session')
    // Inner (vcluster) pods stamp nothing, like runtimeClassName: the
    // syncer drops the class name host-side but copies preemptionPolicy,
    // and the host's priority admission plugin rejects that combination —
    // a pod that never syncs is a session that never starts.
    expect(build({ innerYaac: true }).spec.template.spec.priorityClassName).toBeUndefined()
  })

  it('parses env entries, preserving equals signs inside values', () => {
    // NAME=VALUE splits at the FIRST `=` (proxy URLs carry more), a bare
    // name is an empty value, and so is a trailing `=`.
    const c = build({ env: ['YAAC_SESSION_ID=abcd', 'X=a=b', 'BARE', 'EMPTY='] })
      .spec.template.spec.containers[0]
    expect(c.env).toEqual([
      { name: 'YAAC_SESSION_ID', value: 'abcd' },
      { name: 'X', value: 'a=b' },
      { name: 'BARE', value: '' },
      { name: 'EMPTY', value: '' },
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

  it('wires postStartExec as the session container postStart hook', () => {
    const c = build({ postStartExec: ['/usr/local/bin/yaac-session-init'] })
      .spec.template.spec.containers[0]
    expect(c.lifecycle).toEqual({
      postStart: { exec: { command: ['/usr/local/bin/yaac-session-init'] } },
    })
  })

  it('emits no lifecycle block without postStartExec', () => {
    expect(build().spec.template.spec.containers[0].lifecycle).toBeUndefined()
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

  it('always mounts a pod-local emptyDir for the forwarded ssh-agent socket', () => {
    // The socket is written in-pod by the agent forwarder and read by the
    // session's own ssh client — never shared with another pod, which is
    // what lets the proxy sit on a different node.
    const m = build()
    const { volumes, containers } = m.spec.template.spec
    expect(volumes).toContainEqual({ name: 'ssh-agent', emptyDir: {} })
    expect(containers[0].volumeMounts).toContainEqual({
      name: 'ssh-agent',
      mountPath: SSH_AGENT_MOUNT,
    })
    expect(SSH_AGENT_SOCKET_PATH.startsWith(`${SSH_AGENT_MOUNT}/`)).toBe(true)
    // Nothing hostPath-shaped: a hostPath socket only meets on one node.
    expect(volumes.filter((v) => v.name === 'ssh-agent')
      .every((v) => !('hostPath' in v))).toBe(true)
  })

  describe('nestedContainers', () => {
    const nested = true

    it('leaves the non-nested manifest byte-identical when nested is absent', () => {
      const withoutField = buildSessionJobManifest(params())
      const withUndefined = buildSessionJobManifest({ ...params(), nested: undefined })
      expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(withoutField))

      const spec = build().spec.template.spec
      expect(spec.securityContext).toEqual({ seccompProfile: { type: 'RuntimeDefault' } })
      expect(spec.initContainers).toBeUndefined()
      expect(spec.volumes.some((v) => v.name === 'podman-graphroot')).toBe(false)
      // No graphroot-tmpfs annotations on a non-nested pod.
      expect(build().spec.template.metadata.annotations).toBeUndefined()
      expect(spec.containers[0].resources).toEqual({
        requests: {
          cpu: '250m',
          memory: String(1 * 1024 ** 3),
          'ephemeral-storage': String(2 * 1024 ** 3),
        },
        limits: {
          memory: String(8 * 1024 ** 3),
          'ephemeral-storage': String(16 * 1024 ** 3),
        },
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

    it('allows a graphroot cap at or above the pod memory limit (disk-backed)', () => {
      // The graphroot is disk-backed page cache, not pod memory — its size is
      // deliberately decoupled from memoryLimitBytes.
      expect(() => buildSessionJobManifest({
        ...params(), nested, memoryLimitBytes: NESTED_GRAPHROOT_TMPFS_BYTES,
      })).not.toThrow()
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

    it('backs the graphroot with a disk emptyDir + gVisor disk-tmpfs annotations', () => {
      const m = build({ nested })
      const spec = m.spec.template.spec
      const cap = 8 * 1024 ** 3
      // Disk medium (no `medium: Memory`): runsc pages the sentry tmpfs
      // against a filestore file inside this emptyDir on the node's disk.
      // sizeLimit carries slack above the sentry's size= cap so kubelet
      // eviction can't race the sentry's ENOSPC.
      expect(spec.volumes).toContainEqual({
        name: 'podman-graphroot',
        emptyDir: { sizeLimit: String(cap + 1024 ** 3) },
      })
      expect(spec.containers[0].volumeMounts).toContainEqual({
        name: 'podman-graphroot',
        mountPath: NESTED_GRAPHROOT_PATH,
      })
      // The runsc mount annotations make it a sentry tmpfs (file caps for
      // setcap builds); keyed on the volume name. `type: bind` (not tmpfs) is
      // what selects the DISK-backed variant — see
      // NESTED_GRAPHROOT_ANNOTATIONS.
      expect(m.spec.template.metadata.annotations).toEqual({
        'dev.gvisor.spec.mount.podman-graphroot.type': 'bind',
        'dev.gvisor.spec.mount.podman-graphroot.share': 'container',
        'dev.gvisor.spec.mount.podman-graphroot.options': `rw,size=${cap}`,
      })
    })

    it('mounts nothing for the image cache — it rides the project registry', () => {
      const plain = build().spec.template.spec
      const spec = build({ nested }).spec.template.spec
      // The cross-session cache is a push/pull against the project's
      // in-cluster registry, so nesting adds exactly ONE volume (the
      // graphroot) and nothing that ties the pod to a node. Asserted as a
      // delta against the non-nested spec rather than an exact list, which
      // any unrelated volume would break. No chown init either — the
      // rootful engine owns its graphroot.
      expect(spec.volumes.map((v) => v.name))
        .toEqual([...plain.volumes.map((v) => v.name), 'podman-graphroot'])
      expect(JSON.stringify(spec)).not.toContain('shared-images')
      expect(spec.initContainers).toBeUndefined()
    })

    it('adds the graphroot volume to the ephemeral-storage limit, nothing else', () => {
      const resources = build({ nested }).spec.template.spec.containers[0].resources
      // kubelet charges emptyDir volumes to the pod's ephemeral-storage
      // limit, so the nested limit has to clear the graphroot's own
      // sizeLimit — otherwise the first real `docker build` evicts the
      // session, which a backoffLimit-0 Job never comes back from. Requests
      // stay put: the graphroot is a ceiling, not a steady state.
      expect(resources).toEqual({
        requests: {
          cpu: '250m',
          memory: String(1 * 1024 ** 3),
          'ephemeral-storage': String(2 * 1024 ** 3),
        },
        limits: {
          memory: String(8 * 1024 ** 3),
          'ephemeral-storage': String(16 * 1024 ** 3 + NESTED_GRAPHROOT_SIZELIMIT_BYTES),
        },
      })
      const graphroot = build({ nested }).spec.template.spec.volumes
        .find((v) => v.name === 'podman-graphroot')
      expect(Number(resources.limits['ephemeral-storage']))
        .toBeGreaterThan(Number(graphroot?.emptyDir?.sizeLimit))
    })
  })
})

describe('graphrootMountAnnotations', () => {
  it('parameterizes the sentry graphroot mount on size (builder pods use 16Gi)', () => {
    expect(graphrootMountAnnotations(16 * 1024 ** 3)).toEqual({
      'dev.gvisor.spec.mount.podman-graphroot.type': 'bind',
      'dev.gvisor.spec.mount.podman-graphroot.share': 'container',
      'dev.gvisor.spec.mount.podman-graphroot.options': `rw,size=${16 * 1024 ** 3}`,
    })
  })
})
