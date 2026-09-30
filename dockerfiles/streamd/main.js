/**
 * streamd entrypoint: `node /opt/yaac/streamd/main.js`, started in the
 * background by the pod's setup hook or `bootStreamd`.
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
    // An earlier streamd already serves this pod (e.g. a repeated boot).
    if (err.code === 'EADDRINUSE') {
      console.log(`[streamd] :${port} already served — exiting`)
      process.exit(0)
    }
    console.error(`[streamd] listen failed: ${err.message}`)
    process.exit(1)
  },
)
