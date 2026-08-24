import {
  startForward,
  type ForwardEvents,
  type ForwardHandle,
  type ForwardSpec,
  type TunnelTarget,
} from '#port-tunnel'

/**
 * A live set of port forwards, reconciled against a desired list.
 *
 * The resident forwarder's core, and shared by both of them: `yaac
 * forward` polls the worktree list while the desktop app watches
 * `/events`, but what each does with the answer is identical — bind what
 * the server now offers, let go of what it no longer does. Keeping that
 * here is what stops the tray and the CLI drifting into two different
 * ideas of what a forward is.
 *
 * Reconciling by IDENTITY rather than by count is the substance: a session
 * that gains a port must not cost the others their open connections, so an
 * unchanged spec is never restarted.
 */

/** A forward's identity: which workspace's port, offered where. Two specs
 *  differing in any of these are different forwards. */
function specKey(spec: ForwardSpec): string {
  return `${spec.session} ${spec.containerPort} ${spec.hostPort}`
}

export interface ForwardSetEvents extends ForwardEvents {
  /** A forward came up or went away — a tray item, or a CLI line. */
  onChange?: (spec: ForwardSpec, state: 'up' | 'down') => void
  /**
   * A forward could not bind its host port.
   *
   * The one failure the server could never have reported: what else on
   * this machine holds a port is unknowable from inside a pod, and the
   * machine that binds may not even be the one the server runs on.
   * Reported rather than raised — the rest of the set still comes up, and
   * the next reconcile retries this one.
   */
  onBindError?: (spec: ForwardSpec, message: string) => void
}

export interface ForwardSet {
  /** Make the live set match `specs`: start what is new, drop what is
   *  gone, leave the rest untouched. */
  reconcile(specs: ForwardSpec[]): Promise<void>
  /** What is bound right now. */
  live(): ForwardSpec[]
  close(): void
}

export function createForwardSet(
  target: TunnelTarget,
  opts: { bindHost?: string } & ForwardSetEvents = {},
): ForwardSet {
  const { onChange, onBindError, ...forwardOpts } = opts
  const live = new Map<string, { spec: ForwardSpec; handle: ForwardHandle }>()
  let closed = false

  return {
    live: () => [...live.values()].map((e) => e.spec),
    async reconcile(specs) {
      if (closed) return
      const wanted = new Map(specs.map((s) => [specKey(s), s]))
      for (const [key, entry] of [...live]) {
        if (wanted.has(key)) continue
        live.delete(key)
        entry.handle.close()
        onChange?.(entry.spec, 'down')
      }
      for (const [key, spec] of wanted) {
        if (live.has(key)) continue
        try {
          const handle = await startForward(target, spec, forwardOpts)
          // Re-check after the await: a close() that raced the bind would
          // otherwise leave this holding a port nothing will release.
          if (closed) {
            handle.close()
            return
          }
          live.set(key, { spec, handle })
          onChange?.(spec, 'up')
        } catch (err) {
          onBindError?.(spec, err instanceof Error ? err.message : String(err))
        }
      }
    },
    close() {
      closed = true
      for (const { handle } of live.values()) handle.close()
      live.clear()
    },
  }
}
