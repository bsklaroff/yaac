import { spawn, type ChildProcess } from 'node:child_process'
import { k8sNamespace } from '@/lib/k8s/kubectl'
import { serverLog } from '@/server/log'

/**
 * Server-owned loopback tunnel to an in-cluster Service — the control
 * channel the server uses to reach the proxy's HTTP API. Spawns a
 * long-lived `kubectl port-forward svc/<name> :<port>` child bound to
 * 127.0.0.1 with an ephemeral local port, and respawns it on the next
 * `ensure()` after the child dies (apiserver restart, proxy pod
 * replacement). Nothing ever listens on non-loopback host interfaces.
 */
export class ServicePortForward {
  private child: ChildProcess | null = null
  private port: number | null = null
  private inflight: Promise<number> | null = null
  private stopped = false

  constructor(
    private readonly service: string,
    private readonly targetPort: number,
  ) {}

  /** Local 127.0.0.1 port of the live tunnel, or null when down. */
  get currentPort(): number | null {
    return this.port
  }

  /** Start the tunnel if it isn't running; resolve with the local port. */
  async ensure(): Promise<number> {
    if (this.port !== null && this.child && this.child.exitCode === null) {
      return this.port
    }
    if (this.inflight) return this.inflight
    this.inflight = this.start().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private start(): Promise<number> {
    this.stopped = false
    return new Promise<number>((resolve, reject) => {
      const child = spawn('kubectl', [
        'port-forward',
        '-n', k8sNamespace(),
        `svc/${this.service}`,
        `:${this.targetPort}`,
        '--address', '127.0.0.1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child

      let settled = false
      let stderrBuf = ''
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill()
          reject(new Error(`port-forward to svc/${this.service} timed out\n${stderrBuf}`))
        }
      }, 15_000)

      child.stdout?.on('data', (chunk: Buffer) => {
        // "Forwarding from 127.0.0.1:38217 -> 10255"
        const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(chunk.toString())
        if (m && !settled) {
          settled = true
          clearTimeout(timer)
          this.port = Number(m[1])
          resolve(this.port)
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString()
      })
      child.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      })
      child.on('exit', (code) => {
        this.port = null
        this.child = null
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(
            `port-forward to svc/${this.service} exited with code ${code}\n${stderrBuf}`,
          ))
        } else if (!this.stopped) {
          serverLog(
            `[server] port-forward svc/${this.service} died (code ${code}) — `
            + 'will respawn on next use',
          )
        }
      })
    })
  }

  stop(): void {
    this.stopped = true
    this.port = null
    if (this.child) {
      this.child.kill()
      this.child = null
    }
  }
}
