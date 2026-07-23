/**
 * streamd entrypoint: `node /opt/yaac/streamd/main.js`, started by
 * session-create's setup exec (setsid + background so the exec stream
 * closes while the daemon keeps running under the pod's init).
 *
 * Env: YAAC_STREAM_TOKEN (required), YAAC_STREAM_PORT (default 10300).
 */

import { createStreamd, DEFAULT_STREAM_PORT } from './streamd.js'

const token = process.env.YAAC_STREAM_TOKEN
if (!token) {
  console.error('[streamd] YAAC_STREAM_TOKEN is required')
  process.exit(1)
}
const port = Number(process.env.YAAC_STREAM_PORT) || DEFAULT_STREAM_PORT

const daemon = createStreamd({ token, port })
daemon.listen().then(
  () => console.log(`[streamd] listening on :${port}`),
  (err) => {
    // EADDRINUSE — an earlier streamd is already serving this pod (e.g. a
    // session-create retry re-ran the boot exec). That daemon is fine.
    if (err.code === 'EADDRINUSE') {
      console.log(`[streamd] :${port} already served — exiting`)
      process.exit(0)
    }
    console.error(`[streamd] listen failed: ${err.message}`)
    process.exit(1)
  },
)
