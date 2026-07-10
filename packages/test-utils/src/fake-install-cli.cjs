#!/usr/bin/env node
// Stub for the vendor CLI installers, wired in via testEnv.toolInstallCliHook
// (YAAC_E2E_{CLAUDE,CODEX}_INSTALL_CLI). Prints installer-ish output and
// exits 0. FAKE_INSTALL_MODE=fail exits 1 with an error on stderr;
// FAKE_INSTALL_DELAY_MS stretches the run (default 50ms).
const mode = process.env.FAKE_INSTALL_MODE || 'ok'
const delayMs = Number(process.env.FAKE_INSTALL_DELAY_MS || 50)

process.stdout.write('Downloading installer…\n')

if (mode === 'fail') {
  process.stderr.write('install failed: no network\n')
  process.exit(1)
}

setTimeout(() => {
  process.stdout.write('Installed.\n')
  process.exit(0)
}, delayMs)
