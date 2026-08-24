/**
 * Write `dist/package.json` — the runtime manifest for the bundled server.
 *
 * `dist/cli.js` leaves npm deps external (see check-cli-externals.ts), so
 * anything that runs the bundle away from this repo has to install them.
 * The desktop app gets that from `pnpm pack` + `npm install`; the server
 * IMAGE cannot, because its build context is `dist/` on whatever machine
 * `yaac cluster install` runs on — which, after an `npm i -g @bsklaroff/yaac`,
 * has no pnpm, no workspace, and no catalog to resolve.
 *
 * So the resolution happens here, once, at build time: the root manifest's
 * dependencies with every `catalog:` pin replaced by the concrete version
 * from pnpm-workspace.yaml. The result ships inside `dist/` (the npm
 * tarball's only directory), so the image build finds an installable
 * manifest whether it is building from this repo or from an npm install.
 *
 * Only what a runtime install needs survives: no devDependencies (they name
 * workspace-only `@yaac/*` packages npm would try to resolve even under
 * `--omit=dev`), no lifecycle scripts, no `bin`/`files`/`publishConfig`
 * (this manifest describes a directory to install INTO, not a package to
 * publish).
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
  ) as { catalog?: Record<string, string> }
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
}

await main()
