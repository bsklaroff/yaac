import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { TEST_NAMESPACE } from '@yaac/test-utils/setup'
import { readLock } from '@yaac/shared/lock'

const execFileAsync = promisify(execFile)

/**
 * `yaac server start|stop|restart|logs` against a server that is a
 * Deployment (docs/server-in-cluster.md).
 *
 * There is no host process to signal here, so none of the host-lifecycle
 * claims apply — a pid is per-namespace, the bound port is on the pod's own
 * loopback, and "spawn a second one" is precisely what these verbs exist to
 * prevent. What replaces them is the Deployment's replica count and its
 * pods, so that is what this file reads. The host-process form of the same
 * commands is asserted in test/e2e-containerless/server-lifecycle.test.ts.
 *
 * ONE server for the file, per the fixture discipline: every case here
 * leaves it running (or puts it back), so the expensive part — applying the
 * workload and rolling it out — is paid once.
 */
describe('yaac server lifecycle against the in-cluster Deployment', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer

  beforeAll(async () => {
    testEnv = await createYaacTestEnv()
    server = await spawnYaacServer(testEnv.env)
  })

  afterAll(async () => {
    await server.stop()
    await testEnv.cleanup()
  })

  /** `.spec.replicas` of this file's server Deployment. */
  async function replicas(): Promise<number> {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'deployment', 'yaac-server', '-n', TEST_NAMESPACE,
      '-o', 'jsonpath={.spec.replicas}',
    ], { timeout: 30_000 })
    return Number.parseInt(stdout.trim(), 10)
  }

  /** Names of this file's server pods that are not already terminating. */
  async function serverPods(): Promise<string[]> {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'pods', '-n', TEST_NAMESPACE, '-l', 'app=yaac-server', '-o', 'json',
    ], { timeout: 30_000 })
    const list = JSON.parse(stdout) as {
      items: Array<{ metadata: { name: string; deletionTimestamp?: string } }>
    }
    return list.items
      .filter((pod) => pod.metadata.deletionTimestamp === undefined)
      .map((pod) => pod.metadata.name)
  }

  it('the server that answers the CLI is a pod, and the lock says so', async () => {
    // The install identity the CLI is talking to is a Deployment's pod, not
    // a process of this machine — which is exactly what the lock's `host`
    // field records, and why nothing here may judge it by `pid`.
    const pods = await serverPods()
    expect(pods).toHaveLength(1)
    const lock = await readLock()
    expect(lock).not.toBeNull()
    expect(lock!.host).toBe(pods[0])
    expect(lock!.instance).toBeTypeOf('string')
    expect(lock!.heartbeatAt).toBeTypeOf('number')

    const list = await runYaac(testEnv.env, 'project', 'list')
    expect(list.exitCode, list.stderr).toBe(0)
    expect(list.stdout).toContain('No projects found')
  })

  it('`server start` against a rolled-out Deployment is idempotent', async () => {
    const before = await serverPods()
    const res = await runYaac(testEnv.env, 'server', 'start')
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stderr).toMatch(/server started at http:\/\/127\.0\.0\.1:/)
    // Scaling a Deployment that is already at one replica replaces nothing.
    expect(await serverPods()).toEqual(before)
    expect(await replicas()).toBe(1)
  })

  it('`server restart` rolls the pod, and the new one takes the lease', async () => {
    const [before] = await serverPods()
    const beforeLock = await readLock()

    const res = await runYaac(testEnv.env, 'server', 'restart')
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stderr).toMatch(/server restarted at/)

    const [after] = await serverPods()
    expect(after).not.toBe(before)
    const afterLock = await readLock()
    // A new pod is a new lease holder: the instance is minted per boot, and
    // the host is the pod's own name.
    expect(afterLock!.instance).not.toBe(beforeLock!.instance)
    expect(afterLock!.host).toBe(after)

    // Still reachable at the same published origin the fixture holds.
    const health = await fetch(`http://127.0.0.1:${server.lock.port}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true, ready: true })
  })

  it('`server stop` scales to zero, and `server start` brings it back', async () => {
    const stop = await runYaac(testEnv.env, 'server', 'stop')
    expect(stop.exitCode, stop.stderr).toBe(0)
    expect(stop.stderr).toMatch(/Deployment scaled to 0/)
    expect(await replicas()).toBe(0)

    // Stop is a scale, not a delete: the workload — and with it the RBAC and
    // the ingress policy — is still there for a `start` to undo.
    const start = await runYaac(testEnv.env, 'server', 'start')
    expect(start.exitCode, start.stderr).toBe(0)
    expect(await replicas()).toBe(1)
    expect(await serverPods()).toHaveLength(1)

    const list = await runYaac(testEnv.env, 'project', 'list')
    expect(list.exitCode, list.stderr).toBe(0)
  })

  it('`server logs` prints the log the pod wrote into the shared data dir', async () => {
    // The one verb that needs no cluster awareness at all: the server writes
    // `server.log` under the data dir, which the pod hostPath-mounts from
    // this host — so the same command reads the same file either side of the
    // move.
    const logs = await runYaac(testEnv.env, 'server', 'logs')
    expect(logs.exitCode, logs.stderr).toBe(0)
    // Bound on the pod interface, not a loopback: a pod's loopback has no
    // reachable backend, so the Deployment sets YAAC_BIND_ADDR=0.0.0.0.
    expect(logs.stdout).toMatch(/\[server\] listening on 0\.0\.0\.0:/)
  })

  it('`server logs -n` and `--lines` take the tail of that same file', async () => {
    // Line COUNTS, not line contents: a live server appends to this file
    // while the assertion runs (the kubelet probes /health every 2s), so
    // "the last line is the one I just wrote" is a race. What the options
    // promise is how many lines come back, and that is stable.
    const whole = await runYaac(testEnv.env, 'server', 'logs')
    expect(whole.exitCode, whole.stderr).toBe(0)
    expect(whole.stdout.split('\n').filter(Boolean).length).toBeGreaterThan(2)

    const one = await runYaac(testEnv.env, 'server', 'logs', '-n', '1')
    expect(one.exitCode).toBe(0)
    expect(one.stdout.split('\n').filter(Boolean)).toHaveLength(1)

    const two = await runYaac(testEnv.env, 'server', 'logs', '--lines', '2')
    expect(two.exitCode).toBe(0)
    expect(two.stdout.split('\n').filter(Boolean)).toHaveLength(2)
  })
})
