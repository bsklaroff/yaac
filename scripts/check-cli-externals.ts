/**
 * Fail the build when dist/cli.js imports an external package that is not
 * declared in the root package.json `dependencies`, or when its static
 * import graph reaches a package every command would pay to load.
 *
 * tsup bundles the @yaac/* packages but leaves npm deps external, so the
 * published CLI resolves them from the root manifest, while dev and tests
 * use each package's own manifest. `pnpm --filter @yaac/<pkg> add -E`
 * updates only the package manifest, so without this check a dep could be
 * missing from the root. Reads the esbuild metafile tsup emits
 * (`metafile: true` in tsup.config.ts), then deletes it so it neither ships
 * nor changes the buildId.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const metafilePath = path.join(repoRoot, 'dist', 'metafile-esm.json')

/**
 * Packages only some commands need, which load on every invocation once a
 * static import reaches them (`@kubernetes/client-node` adds over a second
 * to `yaac --version`). Commands that need them import lazily.
 */
const LAZY_ONLY = ['@kubernetes/client-node']

interface Metafile {
  outputs: Record<string, { imports: { path: string; kind?: string; external?: boolean }[] }>
}

/** The external packages `entry` loads before running anything: its static
 *  imports, followed through the chunks they name. */
function staticExternals(metafile: Metafile, entry: string): Set<string> {
  const found = new Set<string>()
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const output = metafile.outputs[queue.pop()!]
    for (const imp of output?.imports ?? []) {
      if (imp.kind === 'dynamic-import') continue
      if (imp.external) found.add(packageName(imp.path))
      else if (!seen.has(imp.path)) {
        seen.add(imp.path)
        queue.push(imp.path)
      }
    }
  }
  return found
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

  const eager = [...staticExternals(metafile, 'dist/cli.js')].filter((name) => LAZY_ONLY.includes(name))

  await fs.rm(metafilePath)

  if (eager.length > 0) {
    console.error(
      `dist/cli.js statically imports ${eager.join(', ')}, so every command loads it. `
      + 'Import the module that needs it with `await import()` inside the command.',
    )
    process.exit(1)
  }

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
