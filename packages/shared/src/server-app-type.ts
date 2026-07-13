/**
 * The server's Hono `AppType`, re-exported so pure clients can build a typed
 * `hc<AppType>` RPC client without importing `@yaac/server` directly.
 *
 * `@yaac/shared` is the one workspace layer allowed to type-import server code
 * (see eslint's shared zone). The frontend — which may only depend on
 * `@yaac/shared` — reaches the type through here. This is a type-only
 * re-export: nothing from `@yaac/server` survives into a consumer's bundle.
 */
export type { AppType } from '@yaac/server/server'
