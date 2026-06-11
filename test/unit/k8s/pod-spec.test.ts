import { describe, it, expect } from 'vitest'
import {
  CA_CERT_PATH,
  CA_CONFIGMAP_KEY,
  CA_CONFIGMAP_NAME,
  CA_MOUNT_DIR,
  assertSessionLabels,
  buildSessionJobManifest,
  parseEnvEntry,
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
        securityContext: { seccompProfile: { type: string } }
        containers: Array<{
          name: string
          image: string
          imagePullPolicy: string
          workingDir: string
          env: Array<{ name: string; value: string }>
          volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>
          resources: { limits: { memory: string } }
        }>
        volumes: Array<{
          name: string
          hostPath?: { path: string; type: string }
          configMap?: { name: string }
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

describe('assertSessionLabels', () => {
  it('passes when the session-id label is present', () => {
    expect(() => assertSessionLabels({ 'yaac.session-id': 'abc' })).not.toThrow()
  })

  it('throws when the session-id label is missing or empty', () => {
    expect(() => assertSessionLabels({})).toThrow(/yaac\.session-id/)
    expect(() => assertSessionLabels({ 'yaac.session-id': '' })).toThrow(/yaac\.session-id/)
  })
})
