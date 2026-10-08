/**
 * Write `dist/package.json` — the runtime manifest for the bundled server.
 *
 * `dist/cli.js` leaves npm deps external (see check-cli-externals.ts), so
 * whatever runs the bundle must install them. The server image builds from
 * `dist/` on the machine running `yaac cluster install`, which after an
 * `npm i -g @bsklaroff/yaac` has no pnpm workspace to resolve `catalog:`
 * pins. This writes the root dependencies with each `catalog:` pin replaced
 * by its version from pnpm-workspace.yaml.
 *
 * Only runtime dependencies are kept. devDependencies name workspace-only
 * `@yaac/*` packages that npm would try to resolve even with `--omit=dev`.
 *
 * It also writes `dist/release-age.npmrc`, which the image's `npm install`
 * reads with `--userconfig`, so the packages npm resolves below those pins
 * wait out the same release-age window as the repo's pnpm installs
 * (`minimumReleaseAge` and its excludes). It is not named `.npmrc` because
 * `npm pack` never ships a file by that name.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface RootManifest {
  name: string
  version: string
  type?: string
  dependencies?: Record<string, string>
}

async function main(): Promise<void> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as RootManifest
  const workspace = parseYaml(
    await fs.readFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
  ) as {
    catalog?: Record<string, string>
    minimumReleaseAge?: number
    minimumReleaseAgeExclude?: string[]
  }
  const catalog = workspace.catalog ?? {}

  const dependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (spec !== 'catalog:') {
      dependencies[name] = spec
      continue
    }
    const pinned = catalog[name]
    if (!pinned) {
      throw new Error(
        `${name} is pinned "catalog:" in package.json but absent from the `
        + 'pnpm-workspace.yaml catalog — nothing can resolve it outside pnpm',
      )
    }
    dependencies[name] = pinned
  }

  const out = {
    name: `${manifest.name}-dist`,
    version: manifest.version,
    private: true,
    type: manifest.type ?? 'module',
    main: 'cli.js',
    dependencies,
  }
  const target = path.join(repoRoot, 'dist', 'package.json')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `${JSON.stringify(out, null, 2)}\n`)

  if (!workspace.minimumReleaseAge) {
    throw new Error('pnpm-workspace.yaml sets no minimumReleaseAge for the server image to follow')
  }
  // pnpm counts minutes and excludes `name@version`; npm counts days and
  // can exclude only by name, which exempts every version of that package.
  const npmrc = [
    '# Written by scripts/write-dist-manifest.ts from pnpm-workspace.yaml.',
    `min-release-age=${String(workspace.minimumReleaseAge / 1440)}`,
    ...(workspace.minimumReleaseAgeExclude ?? [])
      .map((spec) => `min-release-age-exclude[]=${spec.replace(/(.)@.*$/, '$1')}`),
  ]
  await fs.writeFile(path.join(repoRoot, 'dist', 'release-age.npmrc'), `${npmrc.join('\n')}\n`)
}

await main()
