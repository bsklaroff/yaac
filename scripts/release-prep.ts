/**
 * `pnpm release:prep [patch|minor|major|X.Y.Z]` — first half of the release
 * flow (default bump: patch; see homebrew/README.md "Release flow"). Bumps
 * the root package.json version, commits and tags vX.Y.Z, pushes the commit
 * to origin main and the tag, and opens a draft GitHub Release whose notes
 * list the commits since the previous release tag. Runs anywhere with push
 * rights and an authenticated `gh` (a yaac session qualifies). The second
 * half — npm publish plus the signed desktop DMG — is `pnpm release`
 * (scripts/release.ts) on a Mac.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bumpVersion, latestDraftReleaseTag, latestReleaseTag, renderReleaseNotes,
} from '@yaac/shared/release'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' })
}

function fail(message: string): never {
  console.error(`release:prep: ${message}`)
  process.exit(1)
}

function main(): void {
  if (run('git', ['status', '--porcelain']).trim() !== '') {
    fail('working tree is dirty — commit or stash first')
  }
  run('git', ['fetch', 'origin', 'main', '--tags'])
  try {
    run('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])
  } catch {
    fail('HEAD is behind origin/main — rebase onto it first')
  }

  const releases = JSON.parse(
    run('gh', ['release', 'list', '--limit', '100', '--json', 'tagName,isDraft']),
  ) as { tagName: string, isDraft: boolean }[]
  const pending = latestDraftReleaseTag(releases)
  if (pending !== null) {
    fail(`draft release ${pending} is already awaiting \`pnpm release\` — `
      + `publish it (or \`gh release delete ${pending}\` and delete the tag) first`)
  }

  const manifestPath = path.join(repoRoot, 'package.json')
  const manifestRaw = readFileSync(manifestPath, 'utf8')
  const current = (JSON.parse(manifestRaw) as { version: string }).version
  let next: string
  try {
    next = bumpVersion(current, process.argv[2] ?? 'patch')
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
  const tag = `v${next}`
  if (run('git', ['tag', '--list', tag]).trim() !== '') fail(`tag ${tag} already exists`)

  const needle = `"version": "${current}"`
  if (manifestRaw.split(needle).length !== 2) {
    fail(`expected exactly one ${needle} in package.json`)
  }
  writeFileSync(manifestPath, manifestRaw.replace(needle, `"version": "${next}"`))

  run('git', ['add', 'package.json'])
  run('git', ['commit', '-m', `Bump version to ${next}`])
  run('git', ['tag', tag])
  console.log(`release:prep: committed and tagged ${tag}; pushing`)
  run('git', ['push', 'origin', 'HEAD:main'])
  run('git', ['push', 'origin', tag])

  // Notes cover everything since the previous release tag (the whole
  // history for the first release — renderReleaseNotes caps the list).
  const prevTag = latestReleaseTag(
    run('git', ['tag', '--list']).split('\n').filter((t) => t !== tag),
  )
  const range = prevTag === null ? [] : [`${prevTag}..HEAD`]
  const subjects = run('git', ['log', '--pretty=%s', ...range])
    .split('\n')
    .filter((s) => s !== '' && s !== `Bump version to ${next}`)
  run('gh', [
    'release', 'create', tag, '--draft',
    '--title', `yaac v${next}`,
    '--notes', renderReleaseNotes(subjects),
  ])
  console.log(`release:prep: draft release ${tag} created — run \`pnpm release\` on a Mac to publish`)
}

main()
