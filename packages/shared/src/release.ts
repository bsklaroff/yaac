/**
 * Pure helpers for the coupled release flow (scripts/release-prep.ts and
 * scripts/release.ts, run as `pnpm release:prep` / `pnpm release`). One
 * root-package version drives everything: the npm package, the vX.Y.Z git
 * tag and GitHub Release, the desktop app's bundle version, and the
 * Homebrew formula + cask in the bsklaroff/homebrew-yaac tap.
 */

interface SemVer {
  major: number
  minor: number
  patch: number
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/

function parseSemver(raw: string): SemVer | null {
  const m = SEMVER_RE.exec(raw)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

function compareSemver(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/**
 * The next release version: `patch` / `minor` / `major` bump the current
 * version; anything else must be an explicit `X.Y.Z` strictly greater than
 * current. Throws on an unparsable current version, an unparsable explicit
 * version, or an explicit version that doesn't move forward.
 */
export function bumpVersion(current: string, bump: string): string {
  const cur = parseSemver(current)
  if (!cur) throw new Error(`current version ${JSON.stringify(current)} is not X.Y.Z`)
  if (bump === 'patch') return `${cur.major}.${cur.minor}.${cur.patch + 1}`
  if (bump === 'minor') return `${cur.major}.${cur.minor + 1}.0`
  if (bump === 'major') return `${cur.major + 1}.0.0`
  const next = parseSemver(bump)
  if (!next) throw new Error(`version argument ${JSON.stringify(bump)} is not patch/minor/major or X.Y.Z`)
  if (compareSemver(next, cur) <= 0) {
    throw new Error(`explicit version ${bump} must be greater than current ${current}`)
  }
  return bump
}

/** `v1.2.3` → `1.2.3`; null for anything that isn't a release tag. */
export function versionFromTag(tag: string): string | null {
  return tag.startsWith('v') && parseSemver(tag.slice(1)) ? tag.slice(1) : null
}

/** The highest-versioned release tag (`v` + semver) in the list, or null. */
export function latestReleaseTag(tags: string[]): string | null {
  let best: { tag: string, ver: SemVer } | null = null
  for (const tag of tags) {
    const version = versionFromTag(tag)
    if (version === null) continue
    const ver = parseSemver(version)!
    if (!best || compareSemver(ver, best.ver) > 0) best = { tag, ver }
  }
  return best?.tag ?? null
}

/**
 * Among GitHub releases, the highest-versioned draft with a release tag —
 * the one `pnpm release` should finish. Null when none is pending.
 */
export function latestDraftReleaseTag(releases: { tagName: string, isDraft: boolean }[]): string | null {
  return latestReleaseTag(releases.filter((r) => r.isDraft).map((r) => r.tagName))
}

/** Marks notes of a draft release awaiting `pnpm release`; stripped on publish. */
export const PENDING_NOTES_MARKER = '<!-- yaac-release-pending -->'

const MAX_NOTE_SUBJECTS = 50

/**
 * Draft-release notes from commit subjects (newest first, capped at
 * 50), ending with a marked "awaiting `pnpm release`" footer that
 * stripPendingFooter removes when the release is published.
 */
export function renderReleaseNotes(subjects: string[]): string {
  const shown = subjects.slice(0, MAX_NOTE_SUBJECTS)
  const lines = shown.map((s) => `- ${s}`)
  if (subjects.length > shown.length) lines.push(`- …and ${subjects.length - shown.length} more`)
  if (lines.length === 0) lines.push('- (no commits since the previous release)')
  return [
    '## Changes',
    '',
    ...lines,
    '',
    PENDING_NOTES_MARKER,
    '**Draft** — awaiting the signed macOS build: run `pnpm release` on a Mac',
    'to upload the DMG and publish this release.',
    '',
  ].join('\n')
}

/** Notes without the awaiting-`pnpm release` footer (no-op if unmarked). */
export function stripPendingFooter(notes: string): string {
  const at = notes.indexOf(PENDING_NOTES_MARKER)
  return at === -1 ? notes : notes.slice(0, at).replace(/\s+$/, '') + '\n'
}

const SHA256_RE = /^[0-9a-f]{64}$/

/**
 * Fill a tap file's `<VERSION>` and `<SHA256>` placeholders (the in-repo
 * homebrew/ sources keep placeholders; real values only ever land in the
 * tap repo). Throws if either placeholder is missing — a template that
 * stopped matching should fail the release, not ship stale pins.
 */
export function fillTapPlaceholders(template: string, version: string, sha256: string): string {
  if (!parseSemver(version)) throw new Error(`version ${JSON.stringify(version)} is not X.Y.Z`)
  if (!SHA256_RE.test(sha256)) throw new Error(`${JSON.stringify(sha256)} is not a sha256 hex digest`)
  for (const placeholder of ['<VERSION>', '<SHA256>']) {
    if (!template.includes(placeholder)) throw new Error(`template has no ${placeholder} placeholder`)
  }
  return template.replaceAll('<VERSION>', version).replaceAll('<SHA256>', sha256)
}

/** The DMG asset name for a release (matches electron-builder's artifactName). */
export function dmgArtifactName(version: string): string {
  return `yaac-${version}-arm64.dmg`
}

/** The published npm tarball URL for a version (formula url + sha source). */
export function npmTarballUrl(version: string): string {
  return `https://registry.npmjs.org/@bsklaroff/yaac/-/yaac-${version}.tgz`
}
