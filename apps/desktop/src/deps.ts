/**
 * The launcher's one impure module: every Tauri plugin call sits behind
 * `LauncherDeps` so the logic in #launcher unit-tests with fakes and never
 * needs the Tauri runtime.
 *
 * Known v1 limitations (accepted, revisit if they bite):
 * - `YAAC_DATA_DIR` is not honored — the webview has no process env, so the
 *   data dir is always `~/.yaac` (matching the fs scope in
 *   src-tauri/capabilities/default.json).
 * - Unlike `yaac open`, the launcher does not spawn the auth-daemon
 *   (`ensureAuthDaemonSpawned` is in-process CLI code with no command-line
 *   entry point). The SPA's sign-in cards say what to run instead.
 */
import { readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { Command } from '@tauri-apps/plugin-shell'
import type { LauncherStatus } from '#status'

export interface LauncherDeps {
  /** Read `~/.yaac/<name>`; null when absent or unreadable. */
  readYaacFile(name: string): Promise<string | null>
  /**
   * @tauri-apps/plugin-http fetch: runs through Rust reqwest, so the
   * webview's CORS model (and the server's denyBrowserCors) never applies,
   * and the Authorization header is settable.
   */
  fetch: typeof globalThis.fetch
  /**
   * Spawn `yaac server start` and wait for it to exit. Rejects when the
   * binary cannot be spawned at all (yaac not installed / not on PATH).
   */
  startLocalServer(): Promise<{ code: number | null, stderr: string }>
  /** Top-level navigation of this webview to the server origin. */
  navigate(url: string): void
  sleep(ms: number): Promise<void>
  onStatus(status: LauncherStatus): void
}

export function realDeps(onStatus: (status: LauncherStatus) => void): LauncherDeps {
  return {
    async readYaacFile(name) {
      try {
        return await readTextFile(`.yaac/${name}`, { baseDir: BaseDirectory.Home })
      } catch {
        return null
      }
    },
    fetch: tauriFetch,
    async startLocalServer() {
      // 'yaac-server-start' names the pinned-argv entry in
      // src-tauri/capabilities/default.json.
      const out = await Command.create('yaac-server-start', ['server', 'start']).execute()
      return { code: out.code, stderr: out.stderr }
    },
    navigate(url) {
      window.location.replace(url)
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onStatus,
  }
}
