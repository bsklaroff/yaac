import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  PENDING_NOTES_MARKER, bumpVersion, dmgArtifactName, fillTapPlaceholders, latestDraftReleaseTag,
  latestReleaseTag, npmTarballUrl, renderReleaseNotes, stripPendingFooter, versionFromTag,
} from '#release'

const SHA = 'a'.repeat(64)

describe('bumpVersion', () => {
  it('bumps patch, minor, and major', () => {
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4')
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0')
  })

  it('accepts an explicit greater version', () => {
    expect(bumpVersion('1.2.3', '1.10.0')).toBe('1.10.0')
  })

  it('rejects an explicit version that does not move forward', () => {
    expect(() => bumpVersion('1.2.3', '1.2.3')).toThrow(/greater/)
    expect(() => bumpVersion('1.2.3', '0.9.9')).toThrow(/greater/)
  })

  it('rejects malformed current and bump arguments', () => {
    expect(() => bumpVersion('1.2', 'patch')).toThrow(/not X\.Y\.Z/)
    expect(() => bumpVersion('1.2.3', 'v1.2.4')).toThrow(/patch\/minor\/major/)
    expect(() => bumpVersion('1.2.3', 'newest')).toThrow(/patch\/minor\/major/)
  })
})

describe('versionFromTag', () => {
  it('extracts the version from a release tag', () => {
    expect(versionFromTag('v1.2.3')).toBe('1.2.3')
  })

  it('returns null for non-release tags', () => {
    expect(versionFromTag('1.2.3')).toBeNull()
    expect(versionFromTag('v1.2')).toBeNull()
    expect(versionFromTag('desktop-v1.2.3')).toBeNull()
    expect(versionFromTag('')).toBeNull()
  })
})

describe('latestReleaseTag', () => {
  it('picks the highest version numerically, ignoring non-release tags', () => {
    expect(latestReleaseTag(['v0.0.9', 'v0.0.10', 'v0.0.2', 'nightly', ''])).toBe('v0.0.10')
  })

  it('returns null when no release tags exist', () => {
    expect(latestReleaseTag(['nightly', 'foo'])).toBeNull()
    expect(latestReleaseTag([])).toBeNull()
  })
})

describe('latestDraftReleaseTag', () => {
  it('considers only drafts and picks the highest', () => {
    expect(latestDraftReleaseTag([
      { tagName: 'v0.0.7', isDraft: false },
      { tagName: 'v0.0.5', isDraft: true },
      { tagName: 'v0.0.6', isDraft: true },
    ])).toBe('v0.0.6')
  })

  it('returns null when no draft release is pending', () => {
    expect(latestDraftReleaseTag([{ tagName: 'v0.0.5', isDraft: false }])).toBeNull()
    expect(latestDraftReleaseTag([])).toBeNull()
  })
})

describe('renderReleaseNotes', () => {
  it('lists subjects as bullets and ends with the marked pending footer', () => {
    const notes = renderReleaseNotes(['Fix a bug', 'Add a feature'])
    expect(notes).toContain('- Fix a bug\n- Add a feature')
    expect(notes).toContain(PENDING_NOTES_MARKER)
    expect(notes).toContain('pnpm release')
  })

  it('caps long histories with an overflow line', () => {
    const notes = renderReleaseNotes(Array.from({ length: 53 }, (_, i) => `commit ${i}`))
    expect(notes).toContain('- commit 49')
    expect(notes).not.toContain('- commit 50\n')
    expect(notes).toContain('- …and 3 more')
  })

  it('handles an empty history', () => {
    expect(renderReleaseNotes([])).toContain('- (no commits since the previous release)')
  })
})

describe('stripPendingFooter', () => {
  it('round-trips rendered notes down to just the changes', () => {
    const stripped = stripPendingFooter(renderReleaseNotes(['Fix a bug']))
    expect(stripped).toBe('## Changes\n\n- Fix a bug\n')
  })

  it('leaves unmarked notes alone', () => {
    expect(stripPendingFooter('hand-written notes')).toBe('hand-written notes')
  })
})

describe('fillTapPlaceholders', () => {
  it('replaces every occurrence of both placeholders', () => {
    expect(fillTapPlaceholders('v <VERSION> u <VERSION> s <SHA256>', '1.2.3', SHA))
      .toBe(`v 1.2.3 u 1.2.3 s ${SHA}`)
  })

  it('rejects a template missing a placeholder', () => {
    expect(() => fillTapPlaceholders('sha <SHA256>', '1.2.3', SHA)).toThrow(/<VERSION>/)
    expect(() => fillTapPlaceholders('v <VERSION>', '1.2.3', SHA)).toThrow(/<SHA256>/)
  })

  it('rejects malformed versions and digests', () => {
    expect(() => fillTapPlaceholders('<VERSION> <SHA256>', 'v1.2.3', SHA)).toThrow(/X\.Y\.Z/)
    expect(() => fillTapPlaceholders('<VERSION> <SHA256>', '1.2.3', 'beef')).toThrow(/sha256/)
  })

  it('fills the real in-repo formula and cask templates', () => {
    // Guards the placeholder contract with the actual homebrew/ sources the
    // release script reads — a reworded placeholder there must fail here,
    // not at release time.
    const homebrew = path.resolve(import.meta.dirname, '..', '..', '..', 'homebrew')
    for (const file of ['Formula/yaac.rb', 'Casks/yaac-desktop.rb']) {
      const raw = fs.readFileSync(path.join(homebrew, file), 'utf8')
      const filled = fillTapPlaceholders(raw, '1.2.3', SHA)
      expect(filled).toContain('1.2.3')
      expect(filled).toContain(SHA)
      expect(filled).not.toContain('<VERSION>')
      expect(filled).not.toContain('<SHA256>')
    }
  })
})

describe('dmgArtifactName', () => {
  it('matches electron-builder artifactName for the mac arm64 dmg', () => {
    expect(dmgArtifactName('0.0.6')).toBe('yaac-0.0.6-arm64.dmg')
  })
})

describe('npmTarballUrl', () => {
  it('points at the published registry tarball', () => {
    expect(npmTarballUrl('0.0.6'))
      .toBe('https://registry.npmjs.org/@bsklaroff/yaac/-/yaac-0.0.6.tgz')
  })
})
