import { existsSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Build the desktop app's release artifacts, stamped with the root
 * package.json version (homebrew/README.md, "Release flow"), and print each
 * one's sha256. Run after `tsup`, on a Mac, with the platforms to build as
 * arguments (`mac`, `linux`, `win`; all three when none is given). The app
 * has no native modules, so every platform builds from one machine.
 *
 * - mac: the `.dmg` the Homebrew cask downloads, holding the signed,
 *   notarized app, built for arm64, the cask's only arch. Needs the signing
 *   identity in CSC_NAME (e.g. "Jane Doe (TEAMID1234)") and notarytool
 *   credentials in the env vars electron-builder reads:
 *   APPLE_KEYCHAIN_PROFILE naming a `notarytool store-credentials` profile,
 *   or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or
 *   APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER. electron-builder
 *   skips notarization with only a warning when credentials are missing, so
 *   the stapled ticket is checked here rather than trusted, and a `.dmg`
 *   that fails the check is deleted so no releasable-looking file outlives
 *   a failed release.
 * - linux: a `.deb` for x64 and for arm64, unsigned. electron-builder
 *   brings its own fpm and archive tools for macOS.
 * - win: a per-user NSIS installer for x64 and for arm64, unsigned. On
 *   macOS electron-builder reads the uninstaller out of the built installer
 *   itself; on Linux it would run the installer under Wine.
 *
 * electron-builder.yml stays a local `dir` build, so the target and arch
 * are set on the command line, one build per arch so NSIS never makes a
 * combined installer. Each run removes only the outputs its own builds
 * write (an artifact, its .blockmap, its unpacked app), so running one
 * platform after another keeps the first's artifacts.
 */
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(pkgRoot, 'dist-app')

type Platform = 'mac' | 'linux' | 'win'
const PLATFORMS: Platform[] = ['mac', 'linux', 'win']

const requested = process.argv.slice(2)
const bad = requested.filter((p) => !PLATFORMS.includes(p as Platform))
if (bad.length > 0) throw new Error(`unknown platform ${bad.join(', ')}; expected ${PLATFORMS.join(', ')}`)
const platforms = requested.length > 0 ? requested as Platform[] : PLATFORMS

const { version } = JSON.parse(readFileSync(path.join(pkgRoot, '../../package.json'), 'utf8')) as { version: string }

/** One build: its electron-builder flags, artifact, and unpacked app dir. */
interface Build {
  platform: Platform
  flags: string[]
  artifact: string
  appDir: string
}

function builds(platform: Platform): Build[] {
  if (platform === 'mac') {
    const identity = process.env.CSC_NAME
    if (!identity) throw new Error('set CSC_NAME to the Developer ID Application identity')
    return [{
      platform,
      flags: ['--mac', 'dmg', '--arm64', `-c.mac.identity=${identity}`, '-c.forceCodeSigning=true'],
      artifact: `yaac-${version}-arm64.dmg`,
      appDir: 'mac-arm64',
    }]
  }
  return (['x64', 'arm64'] as const).map((arch) => {
    const appDir = `${platform}${arch === 'x64' ? '' : `-${arch}`}-unpacked`
    return platform === 'linux'
      ? { platform, flags: ['--linux', 'deb', `--${arch}`], artifact: `yaac-desktop_${version}_${arch === 'x64' ? 'amd64' : 'arm64'}.deb`, appDir }
      : { platform, flags: ['--win', 'nsis', `--${arch}`], artifact: `yaac-${version}-${arch}-setup.exe`, appDir }
  })
}

const planned = platforms.flatMap(builds)
for (const build of planned) {
  for (const output of [build.artifact, `${build.artifact}.blockmap`, build.appDir]) {
    rmSync(path.join(outDir, output), { recursive: true, force: true })
  }
}

for (const build of planned) {
  execFileSync('electron-builder', [
    '--config', 'electron-builder.yml', `-c.extraMetadata.version=${version}`, ...build.flags,
  ], { cwd: pkgRoot, stdio: 'inherit' })
  const artifact = path.join(outDir, build.artifact)
  if (!existsSync(artifact)) throw new Error(`electron-builder made no ${artifact}`)
  if (build.platform === 'mac') {
    try {
      execFileSync('xcrun', ['stapler', 'validate', path.join(outDir, build.appDir, 'yaac.app')], { stdio: 'inherit' })
    } catch {
      for (const f of [artifact, `${artifact}.blockmap`]) rmSync(f, { force: true })
      throw new Error(`the app has no stapled notarization ticket; deleted ${artifact}`)
    }
  }
}

for (const build of planned) {
  const file = path.join(outDir, build.artifact)
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
  console.log(`[release] ${file}\n  version "${version}"\n  sha256 "${sha256}"`)
}
