/**
 * acpd entrypoint: `node /opt/yaac/acpd/main.js --sock <path> -- <agent argv…>`.
 *
 * Started inside a tmux window by session-create's agent launch command (see
 * `acpDriver.launchCmd` in
 * packages/server/src/features/agents/acp-driver.ts), so tmux supervises it
 * exactly as it supervises a TUI agent. Nothing else launches it.
 */

import { createAcpd } from './acpd.js'

function usage(msg) {
  console.error(`[acpd] ${msg}`)
  console.error('[acpd] usage: acpd --sock <path> [--log <path>] -- <agent argv...>')
  process.exit(2)
}

const args = process.argv.slice(2)
const sep = args.indexOf('--')
if (sep < 0) usage('missing `--` separator before the agent argv')

let sockPath
let logPath
for (let i = 0; i < sep; i++) {
  if (args[i] === '--sock') sockPath = args[++i]
  else if (args[i] === '--log') logPath = args[++i]
  else usage(`unknown option ${args[i]}`)
}
const argv = args.slice(sep + 1)
if (!sockPath) usage('--sock is required')
if (argv.length === 0) usage('no agent command given')

const daemon = createAcpd({ sockPath, argv, ...(logPath ? { logPath } : {}) })
daemon.onExit((code, signal) => {
  process.exit(signal ? 1 : code)
})
daemon.listen().then(
  () => { /* the log line is written by the daemon */ },
  (err) => {
    console.error(`[acpd] listen failed: ${err.message}`)
    process.exit(1)
  },
)

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => daemon.close())
}
