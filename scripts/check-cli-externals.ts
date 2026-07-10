/**
 * Fail the build when dist/cli.js imports an external package that is not
 * declared in the root package.json `dependencies`.
 *
 * tsup bundles the @yaac/* workspace packages but leaves npm deps external,
 * so the published CLI resolves them from the root manifest — while dev and
 * tests resolve each workspace package's own manifest. Nothing else ties the
 * two together: `pnpm --filter @yaac/<pkg> add -E` updates only the package
 * manifest, and a dep missing from the root would be silently inlined by
 * esbuild on the next build (bloat, broken natives) or ship a drifted
 * version. This check makes the contract explicit, reading the esbuild
 * metafile tsup emits (tsup.config.ts sets `metafile: true`) and removing it
 * afterwards so it neither ships in the npm tarball nor churns the buildId.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const metafilePath = path.join(repoRoot, 'dist', 'metafile-esm.json')

interface Metafile {
  outputs: Record<string, { imports: { path: string; external?: boolean }[] }>
}

function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

async function main(): Promise<void> {
  const metafile = JSON.parse(await fs.readFile(metafilePath, 'utf8')) as Metafile
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const declared = new Set(Object.keys(pkg.dependencies ?? {}))

  const missing = new Set<string>()
  for (const output of Object.values(metafile.outputs)) {
    for (const imp of output.imports) {
      if (!imp.external || imp.path.startsWith('node:')) continue
      const name = packageName(imp.path)
      if (builtinModules.includes(name)) continue
      if (!declared.has(name)) missing.add(name)
    }
  }

  await fs.rm(metafilePath)

  if (missing.size > 0) {
    console.error(
      'dist/cli.js imports external packages missing from the root '
      + `package.json dependencies: ${[...missing].sort().join(', ')}\n`
      + 'The published CLI resolves externals from the root manifest — add '
      + 'them there (pnpm add -E <pkg>) in addition to the workspace package.',
    )
    process.exit(1)
  }
  console.log('check-cli-externals: all bundle externals are declared in root dependencies')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
