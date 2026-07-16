import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { k8sNamespace } from '#lib/k8s/kubectl'

/**
 * Server-owned loopback tunnel to an in-cluster workload — the control
 * channel the server uses to reach the proxy's HTTP API. A persistent
 * 127.0.0.1 listener on an ephemeral port bridges each accepted
 * connection into the target pod via `kubectl exec -i deploy/<name> --
 * socat` (the same exec+stdio relay pattern session port-forwarding
 * uses — see #lib/container/port's kubectlRelay).
 *
 * Deliberately NOT `kubectl port-forward` (which this replaced):
 * containerd implements CRI port-forward by dialing localhost inside the
 * pod's network namespace, and a gVisor pod's listeners live in the
 * sentry's netstack — invisible to the netns kernel stack — so
 * port-forward to the sandboxed proxy dies with "connection refused"
 * even though the pod is Ready (the kubelet probes the pod IP over the
 * veth, which netstack does answer). kubectl exec runs the relay INSIDE
 * the sandbox, where localhost is netstack-local, so it works on both
 * runtimes. Each connection costs an exec round trip through the
 * apiserver (~100ms) — fine for a control API (and undici's keep-alive
 * pooling amortizes it); nothing user-facing rides this tunnel. A relay
 * whose pod is gone fails per-connection and self-heals on the next
 * request — no long-lived child to babysit. Nothing ever listens on
 * non-loopback host interfaces.
 */
export class ExecTunnel {
  private server: net.Server | null = null
  private port: number | null = null
  private inflight: Promise<number> | null = null
  private readonly relays = new Set<ChildProcess>()

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

  private start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer((client) => { this.bridge(client) })
      server.once('error', (err) => { reject(err) })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr === null || typeof addr === 'string') {
          server.close()
          reject(new Error('exec tunnel listener reported no port'))
          return
        }
        this.server = server
        this.port = addr.port
        resolve(addr.port)
      })
    })
  }

  /** Pipe one local connection through an exec'd in-pod socat. */
  private bridge(client: net.Socket): void {
    const child = spawn('kubectl', [
      'exec', '-n', k8sNamespace(), '-i', `deploy/${this.deployment}`, '--',
      'socat', '-', `TCP:127.0.0.1:${this.targetPort}`,
    ], { stdio: ['pipe', 'pipe', 'ignore'] })

    if (!child.stdin || !child.stdout) {
      client.destroy()
      child.kill()
      return
    }
    this.relays.add(child)
    child.on('close', () => this.relays.delete(child))

    child.stdout.pipe(client)
    client.pipe(child.stdin)
    child.stdin.on('error', () => { client.destroy() })
    child.on('error', () => { client.destroy() })
    child.on('close', () => { client.destroy() })
    client.on('error', () => { child.stdin?.destroy(); child.kill() })
    client.on('close', () => { child.stdin?.destroy(); child.kill() })
  }

  /** Close the listener and kill any in-flight relays. */
  stop(): void {
    this.port = null
    this.server?.close()
    this.server = null
    for (const child of this.relays) child.kill()
    this.relays.clear()
  }
}
