import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { startPortForwarders, type RelayFactory } from '#platform/port'
import { k8sNamespace } from './kubectl'
import { serverLog } from '#log'

/**
 * Server-owned loopback tunnel to an in-cluster workload — the control
 * channel the server uses to reach the proxy's HTTP API. A persistent
 * 127.0.0.1 listener on an ephemeral port bridges each accepted
 * connection into the target pod via `kubectl exec -i deploy/<name> --
 * socat`; the per-connection relay wiring is the shared
 * startPortForwarders helper worktree port-forwarding uses, so the two
 * relay paths cannot drift.
 *
 * Deliberately NOT `kubectl port-forward` (which this replaced):
 * containerd implements CRI port-forward by dialing localhost inside the
 * pod's network namespace, and a gVisor pod's listeners live in the
 * sentry's netstack — invisible to the netns kernel stack — so
 * port-forward to the sandboxed proxy dies with "connection refused"
 * even though the pod is Ready (the kubelet probes the pod IP over the
 * veth, which netstack does answer). kubectl exec runs the relay INSIDE
 * the sandbox, where localhost is netstack-local, so it works on both
 * runtimes. Each fresh connection costs an exec round trip through the
 * apiserver (~100ms), amortized by connection reuse (the proxy's
 * Keep-Alive hint); nothing user-facing rides this tunnel. A relay whose pod
 * is gone fails per-connection and self-heals on the next request — no
 * long-lived child to babysit — and relay stderr is logged on failure so
 * RBAC/socat/kubeconfig breakage is diagnosable instead of a bare socket
 * reset. Nothing ever listens on non-loopback host interfaces.
 */
export class ExecTunnel {
  private server: net.Server | null = null
  private port: number | null = null
  private inflight: Promise<number> | null = null
  private stopped = false
  /** startPortForwarders cleanup: closes the listener, kills live relays. */
  private closeForwarders: (() => void) | null = null

  constructor(
    /** Deployment name (`kubectl exec deploy/<name>` resolves a ready pod). */
    private readonly deployment: string,
    /** In-pod TCP port the relay dials on localhost. */
    private readonly targetPort: number,
  ) {}

  /** Local 127.0.0.1 port of the live tunnel, or null when down. */
  get currentPort(): number | null {
    return this.port
  }

  /** Start the listener if it isn't running; resolve with the local port. */
  async ensure(): Promise<number> {
    if (this.port !== null && this.server?.listening) return this.port
    if (this.inflight) return this.inflight
    this.inflight = this.start().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /**
   * Spawn one exec relay. stderr is captured (bounded) and logged when
   * the child fails — every distinct failure mode (pods/exec RBAC denial,
   * socat missing from the proxy image, bad kubeconfig, deployment gone)
   * otherwise collapses into an opaque connection reset at the client.
   */
  private spawnRelay(containerPort: number): ChildProcess {
    const child = spawn('kubectl', [
      'exec', '-n', k8sNamespace(), '-i', `deploy/${this.deployment}`, '--',
      'socat', '-', `TCP:127.0.0.1:${containerPort}`,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096)
    })
    child.on('close', (code) => {
      if (code !== 0 && code !== null && stderrTail.trim() !== '') {
        serverLog(
          `[server] exec tunnel relay to deploy/${this.deployment} `
          + `exited ${code}: ${stderrTail.trim()}`,
        )
      }
    })
    return child
  }

  private start(): Promise<number> {
    this.stopped = false
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', (err) => { reject(err) })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr === null || typeof addr === 'string') {
          server.close()
          reject(new Error('exec tunnel listener reported no port'))
          return
        }
        // stop() raced this callback: it found nothing to close, so close
        // here instead of resurrecting a listener nothing would ever own.
        if (this.stopped) {
          server.close()
          reject(new Error('exec tunnel stopped during start'))
          return
        }
        const relay: RelayFactory = (containerPort) => this.spawnRelay(containerPort)
        this.closeForwarders = startPortForwarders(relay, [
          { containerPort: this.targetPort, hostPort: addr.port, server },
        ])
        // The settle-time reject above is spent once this promise
        // resolves; without a persistent handler a later listener error
        // (e.g. accept() EMFILE) would crash the process as an unhandled
        // 'error' event. Log it and tear down so the next ensure() rebinds.
        server.removeAllListeners('error')
        server.on('error', (err) => {
          serverLog(`[server] exec tunnel listener error — rebinding on next use: ${String(err)}`)
          this.teardown()
        })
        this.server = server
        this.port = addr.port
        resolve(addr.port)
      })
    })
  }

  /** Drop listener + relays and clear state so ensure() starts fresh. */
  private teardown(): void {
    this.port = null
    this.server = null
    if (this.closeForwarders) {
      this.closeForwarders()
      this.closeForwarders = null
    }
  }

  /** Close the listener and kill any in-flight relays. */
  stop(): void {
    this.stopped = true
    this.teardown()
  }
}
