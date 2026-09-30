/**
 * One OAuth refresh at a time per credential, shared by every workspace that
 * asks for one.
 *
 * Every workspace holds the same placeholder refresh token, and each spends
 * the one real credential through the proxy, so the proxy is the only place
 * refreshes CAN be serialized: claude's own refresh lock covers one config
 * dir, and workspaces of different projects — or a yaac-in-yaac agent inside
 * a workspace — hold different ones. Two refreshes that each present the same
 * real token leave one of them with invalid_grant, and claude answers
 * invalid_grant by clearing every stored credential holding the refresh
 * token it spent. That token is the placeholder, and the file is a project's
 * shared tool home, so one lost race signs out every workspace of the
 * project. So a refresh joins one in flight, or reuses a rotation made
 * moments ago, instead of spending the credential a second time.
 *
 * Sharing a reply is safe because the credential is install-wide: an
 * install holds one credential per tool, so every workspace refreshing it
 * would get the same upstream fields back (scope, account, codex's
 * `id_token`) — only the tokens themselves are placeholders.
 *
 * A pure, dependency-free helper (like secure-compare.ts) so it is
 * unit-testable by import — proxy.ts starts listeners at module load.
 */

/**
 * How long a rotation keeps answering the refreshes that come after it.
 * Long enough to cover a burst of workspaces starting together, and short
 * enough that a refresh forced by a genuinely rejected token soon reaches
 * upstream again.
 */
export const REFRESH_REUSE_MS = 30_000

/**
 * How long one caller waits on a flight before it is answered with the
 * timeout reply. The flight itself is NOT abandoned: upstream may already
 * have committed the rotation and merely be slow to say so, and a reply that
 * lands late must still be captured — dropping it would leave the proxy
 * holding the spent token, and the next refresh would be the invalid_grant
 * this exists to prevent. So the key stays in flight until upstream
 * settles, and a refresh arriving meanwhile joins it (and times out too)
 * rather than spending the old token again.
 */
export const REFRESH_WAIT_MS = 30_000

export class RefreshFlights<R> {
  private readonly pending = new Map<string, Promise<R>>()
  private readonly last = new Map<string, { result: R; rotatedTo: string; atMs: number }>()

  /**
   * @param rotatedTo the credential a result rotated to (its new refresh
   *   token), or null when it did not spend the credential — only rotations
   *   are reused; a failure is not an answer anyone else should get after the
   *   fact.
   * @param timedOut the reply a caller gets when it outwaits `REFRESH_WAIT_MS`.
   */
  constructor(
    private readonly rotatedTo: (result: R) => string | null,
    private readonly timedOut: () => R,
  ) {}

  /**
   * Run `start` as the one refresh of `key`'s credential, or join the one
   * that already is, or reuse the rotation it made moments ago.
   *
   * `held` is the refresh token of the credential held now. A rotation is
   * reused only while it still is what is held, so a sign-in to a different
   * account — or any bundle pushed from elsewhere — ends the reuse at once.
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
