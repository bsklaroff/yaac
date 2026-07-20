/**
 * `pnpm release` — second half of the release flow (see homebrew/README.md
 * "Release flow"); finishes the newest draft vX.Y.Z GitHub Release made by
 * `pnpm release:prep`. Must run on a macOS arm64 machine with:
 *
 *   - `gh` authenticated and npm publish rights (`npm whoami`)
 *   - YAAC_MAC_SIGNING_IDENTITY  "Developer ID Application: … (TEAMID)"
 *   - APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID  (notarytool;
 *     the password is an app-specific one from account.apple.com)
 *   - optional YAAC_TAP_DIR: an existing bsklaroff/homebrew-yaac checkout
 *     to update in place (otherwise a fresh clone in a temp dir)
 *
 * Steps: check out the release tag in a throwaway worktree → `pnpm publish`
 * (skipped if that version is already on npm, so a failed later step can be
 * retried) → build + sign + notarize the desktop app and DMG → upload the
 * DMG and publish the release → push the filled formula + cask to the tap
 * in one commit (printing manual instructions if the push fails).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dmgArtifactName, fillTapPlaceholders, latestDraftReleaseTag, npmTarballUrl, stripPendingFooter,
  versionFromTag,
} from '@yaac/shared/release'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function capture(cmd: string, args: string[], cwd: string = repoRoot): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' })
}

function stream(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

function fail(message: string): never {
  console.error(`release: ${message}`)
  process.exit(1)
}

function log(message: string): void {
  console.log(`release: ${message}`)
}

function sha256(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function checkPreconditions(): { identity: string } {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('must run on macOS arm64 (signing, notarization, and the DMG are mac-native)')
  }
  const missing = ['YAAC_MAC_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
    .filter((name) => !process.env[name])
  if (missing.length > 0) {
    fail(`missing env: ${missing.join(', ')}\n`
      + '  YAAC_MAC_SIGNING_IDENTITY  "Developer ID Application: <name> (<team id>)" — see `security find-identity -v -p codesigning`\n'
      + '  APPLE_ID                   the Apple Developer account email\n'
      + '  APPLE_APP_SPECIFIC_PASSWORD  app-specific password from account.apple.com\n'
      + '  APPLE_TEAM_ID              the 10-character team id')
  }
  try {
    capture('gh', ['auth', 'status'])
  } catch {
    fail('`gh auth status` failed — run `gh auth login` first')
  }
  try {
    capture('npm', ['whoami'])
  } catch {
    fail('`npm whoami` failed — run `npm login` first (needed to publish @bsklaroff/yaac)')
  }
  return { identity: process.env.YAAC_MAC_SIGNING_IDENTITY! }
}

function npmVersionPublished(version: string): boolean {
  try {
    return capture('npm', ['view', `@bsklaroff/yaac@${version}`, 'version']).trim() !== ''
  } catch {
    return false
  }
}

/** Formula/cask files for the tap, with yaac.rb and the cask filled in. */
function writeTapFiles(tapDir: string, version: string, npmSha: string, dmgSha: string): void {
  const formulaSrc = path.join(repoRoot, 'homebrew', 'Formula')
  mkdirSync(path.join(tapDir, 'Formula'), { recursive: true })
  for (const name of readdirSync(formulaSrc).filter((f) => f.endsWith('.rb'))) {
    const raw = readFileSync(path.join(formulaSrc, name), 'utf8')
    const filled = name === 'yaac.rb' ? fillTapPlaceholders(raw, version, npmSha) : raw
    writeFileSync(path.join(tapDir, 'Formula', name), filled)
  }
  mkdirSync(path.join(tapDir, 'Casks'), { recursive: true })
  writeFileSync(
    path.join(tapDir, 'Casks', 'yaac-desktop.rb'),
    fillTapPlaceholders(
      readFileSync(path.join(repoRoot, 'homebrew', 'Casks', 'yaac-desktop.rb'), 'utf8'),
      version, dmgSha,
    ),
  )
}

async function main(): Promise<void> {
  const { identity } = checkPreconditions()

  const releases = JSON.parse(
    capture('gh', ['release', 'list', '--limit', '100', '--json', 'tagName,isDraft']),
  ) as { tagName: string, isDraft: boolean }[]
  const tag = latestDraftReleaseTag(releases)
  if (tag === null) fail('no draft release found — run `pnpm release:prep` first')
  const version = versionFromTag(tag)!
  log(`finishing draft release ${tag}`)

  capture('git', ['fetch', 'origin', '--tags'])
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yaac-release-'))
  const worktree = path.join(tmpDir, 'repo')
  capture('git', ['worktree', 'add', '--detach', worktree, tag])
  let keepTmp = false
  try {
    log(`building in throwaway worktree ${worktree}`)
    stream('pnpm', ['install', '--frozen-lockfile'], worktree)

    if (npmVersionPublished(version)) {
      log(`@bsklaroff/yaac@${version} is already on npm — skipping publish`)
    } else {
      log('publishing to npm (prepublishOnly runs the full build)')
      stream('pnpm', ['publish', '--no-git-checks'], worktree)
    }
    if (!existsSync(path.join(worktree, 'dist', 'cli.js'))) {
      log('building dist/ (publish was skipped)')
      stream('pnpm', ['build'], worktree)
    }

    log('building, signing, and notarizing the desktop app')
    const desktopDir = path.join(worktree, 'packages', 'desktop')
    stream('pnpm', ['exec', 'tsup'], desktopDir)
    stream('pnpm', ['exec', 'tsx', 'scripts/stage-server.ts'], desktopDir)
    stream('pnpm', [
      'exec', 'electron-builder', '--config', 'electron-builder.yml', '--mac', 'dmg',
      `-c.mac.identity=${identity}`,
      '-c.mac.notarize=true',
      `-c.extraMetadata.version=${version}`,
    ], desktopDir)

    const appPath = path.join(desktopDir, 'dist-app', 'mac-arm64', 'yaac.app')
    const dmgPath = path.join(desktopDir, 'dist-app', dmgArtifactName(version))
    for (const p of [appPath, dmgPath]) {
      if (!existsSync(p)) fail(`expected build output missing: ${p}`)
    }
    log('verifying signature, notarization staple, and Gatekeeper assessment')
    capture('codesign', ['--verify', '--deep', '--strict', appPath])
    capture('xcrun', ['stapler', 'validate', appPath])
    capture('spctl', ['--assess', '--type', 'execute', appPath])

    log(`uploading ${path.basename(dmgPath)} and publishing ${tag}`)
    capture('gh', ['release', 'upload', tag, dmgPath, '--clobber'])
    const { body } = JSON.parse(capture('gh', ['release', 'view', tag, '--json', 'body'])) as { body: string }
    capture('gh', ['release', 'edit', tag, '--draft=false', '--latest', '--notes', stripPendingFooter(body)])

    log('updating the homebrew tap (formula + cask)')
    const npmSha = sha256(new Uint8Array(await (await fetch(npmTarballUrl(version))).arrayBuffer()))
    const dmgSha = sha256(readFileSync(dmgPath))
    let tapDir = process.env.YAAC_TAP_DIR
    if (tapDir) {
      capture('git', ['-C', tapDir, 'pull', '--ff-only'])
    } else {
      tapDir = path.join(tmpDir, 'tap')
      capture('git', ['clone', '--depth', '1', 'https://github.com/bsklaroff/homebrew-yaac.git', tapDir])
    }
    writeTapFiles(tapDir, version, npmSha, dmgSha)
    capture('git', ['-C', tapDir, 'add', '-A'])
    if (capture('git', ['-C', tapDir, 'status', '--porcelain']).trim() === '') {
      log('tap already up to date')
    } else {
      capture('git', ['-C', tapDir, 'commit', '-m', `yaac ${version}`])
      try {
        capture('git', ['-C', tapDir, 'push'])
        log('tap pushed')
      } catch {
        log(`tap push FAILED — the filled files are committed in ${tapDir}; push them by hand:\n`
          + `  git -C ${tapDir} push\n`
          + `(or copy Formula/ and Casks/ from ${tapDir} into your bsklaroff/homebrew-yaac checkout)`)
        if (!process.env.YAAC_TAP_DIR) {
          keepTmp = true
          log(`keeping ${tapDir} for the manual push`)
          return
        }
      }
    }

    log(`released yaac v${version}: npm + ${dmgArtifactName(version)} on ${tag} + tap`)
    log('install: brew install bsklaroff/yaac/yaac  |  brew install --cask bsklaroff/yaac/yaac-desktop')
  } finally {
    try {
      capture('git', ['worktree', 'remove', '--force', worktree])
    } catch {
      // a half-created worktree shouldn't mask the real failure
    }
    if (!keepTmp && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
