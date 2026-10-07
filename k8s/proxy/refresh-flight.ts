/**
 * Runs at most one OAuth refresh at a time per credential, shared by every
 * workspace that asks. A credential is one owner's bundle for one tool.
 *
 * All workspaces hold the same placeholder refresh token and spend their
 * owner's real credential through the proxy, so only the proxy can
 * serialize refreshes. If two refreshes spend the same real token, one gets
 * invalid_grant, and claude reacts by clearing its stored credential, which
 * lives in the project's shared tool home and so signs out every workspace
 * of the project. A refresh therefore joins one in flight, or reuses a
 * rotation made moments ago.
 *
 * Sharing a reply is safe because an owner holds one credential per tool,
 * so every workspace of that owner would get the same upstream fields back.
 */

/**
 * How long a rotation keeps answering the refreshes that come after it.
 * Long enough to cover a burst of workspaces starting together, and short
 * enough that a refresh forced by a genuinely rejected token soon reaches
 * upstream again.
 */
export const REFRESH_REUSE_MS = 30_000

/**
 * How long one caller waits on a flight before getting the timeout reply.
 * The flight itself keeps running: upstream may already have rotated the
 * token, and a late reply must still be captured or the proxy would spend
 * the old token again. Refreshes arriving meanwhile join the same flight.
 */
export const REFRESH_WAIT_MS = 30_000

export class RefreshFlights<R> {
  private readonly pending = new Map<string, Promise<R>>()
  private readonly last = new Map<string, { result: R; rotatedTo: string; atMs: number }>()

  /**
   * @param rotatedTo the new refresh token a result rotated to, or null if it
   *   did not spend the credential. Only rotations are reused, never failures.
   * @param timedOut the reply a caller gets when it outwaits `REFRESH_WAIT_MS`.
   */
  constructor(
    private readonly rotatedTo: (result: R) => string | null,
    private readonly timedOut: () => R,
  ) {}

  /**
   * Run `start` as the one refresh of `key`'s credential, join the refresh
   * already in flight, or reuse a recent rotation.
   *
   * `held` is the refresh token held now. A rotation is reused only while it
   * is still what is held, so a new sign-in ends the reuse at once.
   */
  run(key: string, held: string, start: () => Promise<R>): Promise<R> {
    const recent = this.last.get(key)
    if (!this.pending.has(key) && recent && recent.rotatedTo === held
        && Date.now() - recent.atMs < REFRESH_REUSE_MS) {
      return Promise.resolve(recent.result)
    }
    let flight = this.pending.get(key)
    if (!flight) {
      flight = start()
        .then((result) => {
          const rotatedTo = this.rotatedTo(result)
          if (rotatedTo !== null) this.last.set(key, { result, rotatedTo, atMs: Date.now() })
          return result
        })
        .finally(() => { this.pending.delete(key) })
      this.pending.set(key, flight)
    }
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<R>((resolve) => {
      timer = setTimeout(() => { resolve(this.timedOut()) }, REFRESH_WAIT_MS)
    })
    return Promise.race([flight, deadline]).finally(() => { clearTimeout(timer) })
  }
}
