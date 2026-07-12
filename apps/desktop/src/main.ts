/** Entry: wire the real Tauri-backed deps to the launcher. Untested glue. */
import { realDeps } from '#deps'
import { runLauncher } from '#launcher'
import { renderStatus } from '#status'

const statusEl = document.getElementById('status')
if (!(statusEl instanceof HTMLElement)) throw new Error('missing #status element')

void runLauncher(realDeps((status) => renderStatus(statusEl, status)))
