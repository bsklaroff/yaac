/**
 * The published `yaac` binary: turns on Node's compile cache, then loads
 * the CLI (`./cli`). The cache keeps the compiled bundle and its npm
 * dependencies across invocations, so a command skips most of their parse
 * and compile, about 60 ms of every run. It must be on before those modules
 * load, which a call in the CLI's own body would be too late for, since a
 * module's static imports are loaded before its body runs.
 */
import { enableCompileCache } from 'node:module'

enableCompileCache()
// eslint-disable-next-line no-restricted-syntax -- the repo bans dynamic import, but the cache must be on before the CLI's modules load
await import('./cli')
