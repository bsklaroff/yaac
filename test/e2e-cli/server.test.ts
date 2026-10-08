import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  TEST_CLI_ENTRY,
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { TEST_NAMESPACE } from '@yaac/test-utils/setup'
import { resolveTestBaseImageRef } from '@yaac/test-utils/test-pods'
import { readLock } from '@yaac/shared/lock'
import {
  RUNTIME_CLASS_GVISOR,
  SERVER_POD_PORT,
  runPodToCompletion,
  workspaceIdLabels,
} from '@yaac/server/drivers/k8s/substrate'

const execFileAsync = promisify(execFile)

/**
 * `yaac server start|stop|restart|logs` against a server that runs as a
 * Deployment (docs/server-in-cluster.md). Assertions read the Deployment's
 * replica count and pods; the host-process form is covered by
 * test/e2e-containerless/server-lifecycle.test.ts.
 *
 * One server for the file: every case leaves it running or restores it.
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
    // The server is a pod, not a local process, so the lock's `host`
    // identifies it and `pid` means nothing here.
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

  it('walls the API off from a workspace-labelled pod, while the kubelet still reaches it', async () => {
    // The server pod's ingress policy admits only the node addresses and
    // whatever fronts the Service; it is what keeps workspace code off the
    // control plane (docs/server-in-cluster.md). A workspace-like pod
    // dialing the pod IP must be dropped. The allowed side is shown by the
    // fixture's rollout: the node's readiness probe got through.
    const { stdout: podIp } = await execFileAsync('kubectl', [
      'get', 'pods', '-n', TEST_NAMESPACE, '-l', 'app=yaac-server',
      '-o', 'jsonpath={.items[0].status.podIP}',
    ], { timeout: 30_000 })
    expect(podIp.trim()).toMatch(/^\d+\.\d+\.\d+\.\d+$/)

    const { phase, logs } = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'yaac-e2e-server-wall-probe',
        namespace: TEST_NAMESPACE,
        labels: workspaceIdLabels('e2e-server-wall-probe'),
      },
      spec: {
        restartPolicy: 'Never',
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        containers: [{
          name: 'probe',
          image: await resolveTestBaseImageRef(),
          command: ['sh', '-c',
            `curl -s -m 4 http://${podIp.trim()}:${String(SERVER_POD_PORT)}/api/health >/dev/null `
            + '&& echo NP_SERVER_OPEN || echo NP_SERVER_LOCKED'],
        }],
      },
    }, { timeoutMs: 120_000 })
    expect(phase).toBe('Succeeded')
    expect(logs).toContain('NP_SERVER_LOCKED')
    expect(logs).not.toContain('NP_SERVER_OPEN')
  })

  it('`server start` against a rolled-out Deployment is idempotent', async () => {
    const before = await serverPods()
    const res = await runYaac(testEnv.env, 'server', 'start')
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stderr).toMatch(/server started at http:\/\/127\.0\.0\.1:/)
    // Already at one replica, so nothing is replaced.
    expect(await serverPods()).toEqual(before)
    expect(await replicas()).toBe(1)
  })

  it('`server start|restart --tailnet/--owner` defer to `cluster install`, leaving the pod alone', async () => {
    const before = await serverPods()
    for (const args of [['start', '--tailnet', 'srv.tailnet.ts.net'], ['restart', '--tailnet', 'srv.tailnet.ts.net', '--owner', 'a@b.c']]) {
      const res = await runYaac(testEnv.env, 'server', ...args)
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toMatch(/access mode `yaac cluster install` sets: use `yaac cluster install --tailnet \[<host>\] \[--owner <login>\]`/)
    }
    expect(await serverPods()).toEqual(before)
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
    // A new pod: the instance id is per boot and the host is the pod name.
    expect(afterLock!.instance).not.toBe(beforeLock!.instance)
    expect(afterLock!.host).toBe(after)

    const health = await fetch(`http://127.0.0.1:${server.lock.port}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true, ready: true })
  })

  it('`server stop` scales to zero, and `server start` brings it back', async () => {
    const stop = await runYaac(testEnv.env, 'server', 'stop')
    expect(stop.exitCode, stop.stderr).toBe(0)
    expect(stop.stderr).toMatch(/Deployment scaled to 0/)
    expect(await replicas()).toBe(0)

    // Stop scales to zero; the workload, RBAC and ingress policy remain.
    const start = await runYaac(testEnv.env, 'server', 'start')
    expect(start.exitCode, start.stderr).toBe(0)
    expect(await replicas()).toBe(1)
    expect(await serverPods()).toHaveLength(1)

    const list = await runYaac(testEnv.env, 'project', 'list')
    expect(list.exitCode, list.stderr).toBe(0)
  })

  it('the server pod mounts the two claims and the node tree, and nothing under the data dir by hostPath', async () => {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'deployment', 'yaac-server', '-n', TEST_NAMESPACE, '-o', 'json',
    ])
    const pod = (JSON.parse(stdout) as {
      spec: { template: { spec: {
        volumes: Array<{ name: string; hostPath?: { path: string }; persistentVolumeClaim?: { claimName: string } }>
        containers: Array<{ volumeMounts: Array<{ name: string; mountPath: string }> }>
      } } }
    }).spec.template.spec
    const claims = pod.volumes.filter((v) => v.persistentVolumeClaim).map((v) => v.persistentVolumeClaim?.claimName)
    expect(claims.sort()).toEqual(['yaac-global', 'yaac-server-local'])
    expect(pod.volumes.find((v) => v.name === 'node-local')?.hostPath?.path).toMatch(/^\/var\/lib\/yaac\/node\//)
    // The harness mounts its scratch base too, but the data dir itself is
    // reached only through the claims.
    for (const v of pod.volumes) {
      expect(v.hostPath?.path.startsWith(testEnv.dataDir)).not.toBe(true)
    }
    const mounts = Object.fromEntries(pod.containers[0].volumeMounts.map((m) => [m.name, m.mountPath]))
    expect(mounts).toMatchObject({
      global: '/yaac/global', 'server-local': '/yaac/server-local', 'node-local': '/yaac/node-local',
    })
    const { stdout: pvcs } = await execFileAsync('kubectl', [
      'get', 'pvc', '-n', TEST_NAMESPACE, '-o', 'jsonpath={range .items[*]}{.metadata.name}={.status.phase}{"\\n"}{end}',
    ])
    expect(pvcs.trim().split('\n').sort()).toEqual(['yaac-global=Bound', 'yaac-server-local=Bound'])
  })

  it('`server logs` prints the log the pod wrote into the server-local claim', async () => {
    // Read through the pod: on a byo install this host cannot see the
    // server-local volume.
    const logs = await runYaac(testEnv.env, 'server', 'logs')
    expect(logs.exitCode, logs.stderr).toBe(0)
    // The Deployment sets YAAC_BIND_ADDR=0.0.0.0 so the Service can reach it.
    expect(logs.stdout).toMatch(/\[server\] listening on 0\.0\.0\.0:/)
  })

  it('`server logs -n` and `--lines` take the tail of that same file', async () => {
    // Assert line counts, not contents: health probes append lines while
    // the test runs.
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

  it('`server logs -f` keeps printing what the pod appends, until interrupted', async () => {
    const child = spawn(process.execPath, [TEST_CLI_ENTRY, 'server', 'logs', '-f'], {
      env: testEnv.env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      await vi.waitFor(() => expect(stdout).toMatch(/\[server\] listening on 0\.0\.0\.0:/), { timeout: 30_000, interval: 100 })
      // A new line the follow must pick up.
      const before = stdout.length
      await fetch(`http://127.0.0.1:${String(server.lock.port)}/api/health`)
      await vi.waitFor(() => expect(stdout.slice(before)).toContain('GET /api/health 200'), { timeout: 20_000, interval: 100 })
    } finally {
      child.kill('SIGINT')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  })
})
