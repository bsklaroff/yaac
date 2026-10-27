/**
 * Write `dist/package.json` and `dist/npm-shrinkwrap.json` — the runtime
 * manifest and lockfile for the bundled server.
 *
 * `dist/cli.js` leaves npm deps external (see check-cli-externals.ts), so
 * whatever runs the bundle must install them: the server image, built from
 * `dist/` on the machine running `yaac cluster install`, and the Homebrew
 * formula. Neither has the pnpm workspace, so both `npm ci` from these two
 * files.
 *
 * The manifest is the root dependencies with each `catalog:` pin replaced by
 * its version from pnpm-workspace.yaml. Only runtime dependencies are kept:
 * devDependencies name workspace-only `@yaac/*` packages that npm would try
 * to resolve even with `--omit=dev`.
 *
 * The lockfile is pnpm-lock.yaml's resolution of those dependencies, every
 * package at the version and integrity hash pnpm chose under the repo's
 * release-age gate, laid out as an npm `node_modules` tree. So `npm ci`
 * resolves nothing itself. It is named `npm-shrinkwrap.json` because
 * `npm pack` never ships a `package-lock.json`. It records no `bin` maps or
 * install scripts: pnpm-lock.yaml has neither, nothing runs a dependency's
 * bin, and both installs pass `--ignore-scripts`, as pnpm builds none of
 * these packages either (`allowBuilds`).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments, parse as parseYaml } from 'yaml'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface RootManifest {
  name: string
  version: string
  type?: string
  dependencies?: Record<string, string>
}

interface PnpmLock {
  importers?: Record<string, { dependencies?: Record<string, { version: string }> }>
  packages?: Record<string, {
    resolution: { integrity?: string }
    os?: string[]
    cpu?: string[]
    libc?: string[]
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
  }>
  snapshots?: Record<string, {
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }>
}

/** One package in the tree, by its lockfile ids. `id` is `name@version`
 *  (a `packages` key); `snapshot` adds pnpm's peer suffix. */
interface Dep { name: string, id: string, snapshot: string, optional: boolean }

/** A dependency as a snapshot names it: `version(peers…)`, or
 *  `real-name@version(peers…)` for an alias. */
function parseDep(name: string, ref: string, optional: boolean): Dep {
  const version = ref.replace(/\(.*$/, '')
  const aliased = version.lastIndexOf('@') > 0
  return {
    name,
    id: aliased ? version : `${name}@${version}`,
    snapshot: aliased ? ref : `${name}@${ref}`,
    optional,
  }
}

const idName = (id: string): string => id.slice(0, id.lastIndexOf('@'))
const idVersion = (id: string): string => id.slice(id.lastIndexOf('@') + 1)

/** Lock a dependency the way npm records it: an alias as `npm:name@version`. */
const depSpec = (dep: Dep): string =>
  idName(dep.id) === dep.name ? idVersion(dep.id) : `npm:${dep.id}`

/**
 * Lay pnpm's resolution of `roots` out as npm lockfile v3 `packages`. Each
 * package goes at the top of `node_modules` unless a different version of
 * it is already visible from the dependent, and then nests under the
 * dependent. Optional peers are left out, as npm installs none of them; a
 * package reachable only through optional edges is marked `optional`, so
 * npm skips it on a platform its `os`/`cpu`/`libc` rule out.
 */
function npmPackages(lock: PnpmLock, roots: Dep[]): Record<string, Record<string, unknown>> {
  const deps = (from: Dep): Dep[] => {
    const snap = lock.snapshots?.[from.snapshot]
    if (!snap) throw new Error(`pnpm-lock.yaml has no snapshot ${from.snapshot}`)
    const peers = lock.packages?.[from.id]?.peerDependenciesMeta ?? {}
    return [
      ...Object.entries(snap.dependencies ?? {}).map(([n, ref]) => parseDep(n, ref, false)),
      ...Object.entries(snap.optionalDependencies ?? {})
        .filter(([n]) => !peers[n]?.optional)
        .map(([n, ref]) => parseDep(n, ref, true)),
    ]
  }

  const required = new Set<string>()
  const walk = (dep: Dep): void => {
    if (dep.optional || required.has(dep.snapshot)) return
    required.add(dep.snapshot)
    deps(dep).forEach(walk)
  }
  roots.forEach(walk)

  /** Where a dependent at `loc` (`''` for the root) finds `name`, nearest first. */
  const lookups = (loc: string, name: string): string[] => {
    const out: string[] = []
    for (let at = loc; ; at = at.replace(/\/?node_modules\/(@[^/]+\/)?[^/]+$/, '')) {
      out.push(`${at ? `${at}/` : ''}node_modules/${name}`)
      if (!at) return out
    }
  }

  const tree = new Map<string, Dep>()
  const placed = new Map<string, Dep[]>()
  const queue: Array<[string, Dep[]]> = [['', roots]]
  const seen = new Set<string>()
  for (let item = queue.shift(); item; item = queue.shift()) {
    const [loc, children] = item
    placed.set(loc, [...(placed.get(loc) ?? []), ...children])
    for (const dep of children) {
      const found = lookups(loc, dep.name).find((at) => tree.has(at))
      let at = found
      if (!found || tree.get(found)?.snapshot !== dep.snapshot) {
        at = found ? `${loc}/node_modules/${dep.name}` : `node_modules/${dep.name}`
        if (tree.has(at)) throw new Error(`two versions of ${dep.name} at ${at}`)
        tree.set(at, dep)
      }
      if (at && !seen.has(at)) {
        seen.add(at)
        queue.push([at, deps(dep)])
      }
    }
  }
  // A later nested placement must not have shadowed an earlier lookup.
  for (const [loc, children] of placed) {
    for (const dep of children) {
      const at = lookups(loc, dep.name).find((l) => tree.has(l))
      if (!at || tree.get(at)?.snapshot !== dep.snapshot) throw new Error(`${loc || 'root'} does not see ${dep.id}`)
    }
  }

  const out: Record<string, Record<string, unknown>> = {}
  for (const [at, dep] of [...tree].sort(([a], [b]) => a.localeCompare(b))) {
    const meta = lock.packages?.[dep.id]
    const integrity = meta?.resolution.integrity
    if (!integrity) throw new Error(`pnpm-lock.yaml has no registry integrity for ${dep.id}`)
    const name = idName(dep.id)
    const own = deps(dep)
    const specs = (optional: boolean): Record<string, string> | undefined => {
      const list = own.filter((d) => d.optional === optional)
      return list.length ? Object.fromEntries(list.map((d) => [d.name, depSpec(d)])) : undefined
    }
    out[at] = {
      ...(name === dep.name ? {} : { name }),
      version: idVersion(dep.id),
      resolved: `https://registry.npmjs.org/${name}/-/${name.replace(/^@[^/]+\//, '')}-${idVersion(dep.id)}.tgz`,
      integrity,
      ...(required.has(dep.snapshot) ? {} : { optional: true }),
      dependencies: specs(false),
      optionalDependencies: specs(true),
      os: meta.os,
      cpu: meta.cpu,
      libc: meta.libc,
    }
  }
  return out
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
  const distDir = path.join(repoRoot, 'dist')
  await fs.mkdir(distDir, { recursive: true })
  await fs.writeFile(path.join(distDir, 'package.json'), `${JSON.stringify(out, null, 2)}\n`)

  const lock = parseAllDocuments(await fs.readFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'))
    .map((doc) => doc.toJS() as PnpmLock)
    .find((doc) => doc.importers?.['.']?.dependencies)
  const resolved = lock?.importers?.['.']?.dependencies ?? {}
  const roots = Object.keys(dependencies).map((name) => {
    if (!resolved[name]) throw new Error(`pnpm-lock.yaml does not resolve ${name}; run pnpm install`)
    return parseDep(name, resolved[name].version, false)
  })
  const shrinkwrap = {
    name: out.name,
    version: out.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: out.name, version: out.version, dependencies },
      ...npmPackages(lock ?? {}, roots),
    },
  }
  await fs.writeFile(path.join(distDir, 'npm-shrinkwrap.json'), `${JSON.stringify(shrinkwrap, null, 2)}\n`)
}

await main()
