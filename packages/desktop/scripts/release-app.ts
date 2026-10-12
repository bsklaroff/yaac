import { readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Build the `.dmg` the Homebrew cask downloads, holding the signed, notarized
 * app
 * (homebrew/README.md, "Release flow"). Run after `tsup`, with the signing
 * identity in CSC_NAME (e.g. "Jane Doe (TEAMID1234)") and notarytool
 * credentials in the env vars electron-builder reads: APPLE_KEYCHAIN_PROFILE
 * naming a `notarytool store-credentials` profile, or APPLE_ID +
 * APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or APPLE_API_KEY +
 * APPLE_API_KEY_ID + APPLE_API_ISSUER.
 *
 * electron-builder.yml stays an unsigned local build, so this overrides it on
 * the command line. The app is built for arm64, the cask's only arch, and
 * stamped with the root package.json version, which names the `.dmg` the
 * cask's url points at. electron-builder skips notarization with only a
 * warning when credentials are missing, so the stapled ticket is checked here
 * rather than trusted, and a `.dmg` that fails the check is deleted so no
 * releasable-looking file outlives a failed release.
 */
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(pkgRoot, 'dist-app')

const identity = process.env.CSC_NAME
if (!identity) throw new Error('set CSC_NAME to the Developer ID Application identity')

const { version } = JSON.parse(
  readFileSync(path.join(pkgRoot, '../../package.json'), 'utf8'),
) as { version: string }

execFileSync('electron-builder', [
  '--config', 'electron-builder.yml',
  '--arm64',
  `-c.mac.identity=${identity}`,
  '-c.forceCodeSigning=true',
  '-c.mac.target=dmg',
  `-c.extraMetadata.version=${version}`,
], { cwd: pkgRoot, stdio: 'inherit' })

const dmg = path.join(outDir, `yaac-${version}-arm64.dmg`)
try {
  execFileSync('xcrun', ['stapler', 'validate', path.join(outDir, 'mac-arm64', 'yaac.app')], { stdio: 'inherit' })
} catch (err) {
  rmSync(dmg, { force: true })
  throw err
}

const sha256 = createHash('sha256').update(readFileSync(dmg)).digest('hex')
console.log(`[release] ${dmg}\n  version "${version}"\n  sha256 "${sha256}"`)
