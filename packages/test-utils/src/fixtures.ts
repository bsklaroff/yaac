import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Absolute paths to the fake vendor CLIs used to drive tool login/install
 * flows in tests, resolved relative to this package so callers don't hardcode
 * `__dirname` walks that break when a test file moves.
 */
export const CLAUDE_STUB = path.join(dir, 'fake-claude-login.cjs')
export const CODEX_STUB = path.join(dir, 'fake-codex-login.cjs')
export const INSTALL_STUB = path.join(dir, 'fake-install-cli.cjs')
