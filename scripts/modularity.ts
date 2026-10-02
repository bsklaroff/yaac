// Measures how cleanly the codebase is modularized, on the three axes we care
// about: size, interface width, and coupling/acyclicity.
//
//   pnpm modularity                      # every packages/*/src
//   pnpm modularity packages/server/src  # one package
//   pnpm modularity --files              # same metrics at file granularity
//   pnpm modularity --json               # machine-readable, for tracking drift
//
// dependency-cruiser extracts the raw file graph (see .dependency-cruiser.cjs);
// everything below is the part it does not compute. The headline numbers are
// the standard ones:
//
//   CD(m)  Lakos's cumulative component dependency: how many modules you must
//          understand (or link, or stub in a test) to use m -- the size of m's
//          transitive dependency set, counting m itself.
//   CCD    the sum of CD over all modules. A levelized DAG lands near n*log2(n);
//          a cycle of n modules contributes n^2, so cycles are punished
//          quadratically and acyclicity falls out of the metric for free rather
//          than being scored separately.
//   NCCD   CCD normalized by the CCD of a balanced binary dependency tree of the
//          same size. ~1.0 is tree-like. Lakos treats >1.6 as a design smell.
//   PC     MacCormack/Baldwin propagation cost: CCD/n^2, i.e. the fraction of
//          the system an average change can reach. Same quantity as CCD, scaled
//          to [0,1] so it compares across differently-sized scopes.
//
// Interface width is measured at the barrels (a sealed folder's index.ts).
// `exports` counts the names it re-exports, `used` counts how many of them
// anything outside imports, and depth is Ousterhout's ratio: implementation
// lines per exported name.
//
// LOC is reported but not scored: minimizing lines pushes toward shared
// abstractions, which tend to widen interfaces and create cycles.

import fs from 'node:fs'
import path from 'node:path'
import { cruise, type ICruiseResult } from 'dependency-cruiser'
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options'
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
process.chdir(ROOT)

// ---------------------------------------------------------------- manifests

interface Manifest {
  imports?: Record<string, string>
}

interface Pkg {
  dir: string
  manifest: Manifest
}

function readManifest(dir: string): Manifest | undefined {
  const file = path.join(dir, 'package.json')
  if (!fs.existsSync(file)) return undefined
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest
}

const packages: Pkg[] = fs
  .readdirSync(path.join(ROOT, 'packages'))
  .map((d) => path.join(ROOT, 'packages', d))
  .flatMap((dir) => {
    const manifest = readManifest(dir)
    return manifest ? [{ dir, manifest }] : []
  })

function ownerOf(absFile: string): Pkg | undefined {
  return packages.find((p) => absFile.startsWith(p.dir + path.sep))
}

// ------------------------------------------------------------ module naming
// A sealed folder is always its own module, even when its parent directory
// also holds loose files (runtime/ is both). Otherwise a module is the
// shallowest directory under src/ that holds source files directly, so a
// directory holding only subdirectories is not a module.

/**
 * The barrels: each exact imports-map entry, as [specifier, index.ts]. The
 * map targets are output-form `./src/*.js`; the source they stand for is `.ts`.
 */
const barrels = packages.flatMap((pkg) =>
  Object.entries(pkg.manifest.imports ?? {}).flatMap(([spec, target]) => {
    const file = path.join(pkg.dir, target.replace(/\.js$/, '.ts'))
    return !spec.includes('*') && /(^|\/)index\.ts$/.test(file) && fs.existsSync(file)
      ? [[spec, file] as const]
      : []
  }),
)
const sealedDirs = new Set(barrels.map(([, file]) => path.dirname(file)))

const dirHasSourceCache = new Map<string, boolean>()

function dirHasSource(dir: string): boolean {
  const cached = dirHasSourceCache.get(dir)
  if (cached !== undefined) return cached
  const has =
    fs.existsSync(dir) &&
    fs.readdirSync(dir).some((e) => /\.tsx?$/.test(e) && fs.statSync(path.join(dir, e)).isFile())
  dirHasSourceCache.set(dir, has)
  return has
}

function moduleOf(absFile: string): string {
  const owner = ownerOf(absFile)
  if (!owner) return path.dirname(path.relative(ROOT, absFile))
  const label = path.basename(owner.dir)
  const src = path.join(owner.dir, 'src')
  if (!absFile.startsWith(src + path.sep)) {
    return `${label}/${path.dirname(path.relative(owner.dir, absFile))}`
  }
  const segs = path.relative(src, path.dirname(absFile)).split(path.sep).filter(Boolean)
  if (segs.length === 0) return `${label}/(root)`
  for (let i = segs.length; i >= 1; i--) {
    if (sealedDirs.has(path.join(src, ...segs.slice(0, i)))) {
      return `${label}/${segs.slice(0, i).join('/')}`
    }
  }
  for (let i = 1; i <= segs.length; i++) {
    if (dirHasSource(path.join(src, ...segs.slice(0, i)))) {
      return `${label}/${segs.slice(0, i).join('/')}`
    }
  }
  return `${label}/${segs.join('/')}`
}

// ------------------------------------------------------------- source counts

function sloc(absFile: string): number {
  let count = 0
  for (const line of fs.readFileSync(absFile, 'utf8').split('\n')) {
    const t = line.trim()
    if (t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    count++
  }
  return count
}

// ---------------------------------------------------------------- TS parsing

const parseCache = new Map<string, ts.SourceFile>()

function parse(absFile: string): ts.SourceFile {
  const hit = parseCache.get(absFile)
  if (hit) return hit
  const sf = ts.createSourceFile(
    absFile,
    fs.readFileSync(absFile, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    absFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  parseCache.set(absFile, sf)
  return sf
}

interface BarrelShape {
  names: Set<string>
  starFrom: string[]
}

function barrelExports(absFile: string): BarrelShape {
  const names = new Set<string>()
  const starFrom: string[] = []
  for (const st of parse(absFile).statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) names.add(el.name.text)
      } else if (!st.exportClause && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        starFrom.push(st.moduleSpecifier.text)
      }
      continue
    }
    const mods = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : []
    if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.add(d.name.text)
      }
    } else if (
      (ts.isFunctionDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEnumDeclaration(st)) &&
      st.name
    ) {
      names.add(st.name.text)
    }
  }
  return { names, starFrom }
}

interface FileImports {
  /** Named bindings this file takes from each specifier. */
  names: Map<string, string[]>
  /** Specifiers this file only ever imports types from -- erased at runtime. */
  typeOnly: Set<string>
}

function fileImports(absFile: string): FileImports {
  const names = new Map<string, string[]>()
  const typeOnly = new Set<string>()
  const value = new Set<string>()
  const add = (spec: string, name: string, isType: boolean) => {
    const list = names.get(spec) ?? []
    list.push(name)
    names.set(spec, list)
    ;(isType ? typeOnly : value).add(spec)
  }
  for (const st of parse(absFile).statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text
      const clause = st.importClause
      if (!clause) {
        value.add(spec) // bare side-effect import
        continue
      }
      if (clause.name) add(spec, 'default', clause.isTypeOnly)
      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            add(spec, (el.propertyName ?? el.name).text, clause.isTypeOnly || el.isTypeOnly)
          }
        } else {
          add(spec, '*', clause.isTypeOnly)
        }
      }
    } else if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier)
    ) {
      const spec = st.moduleSpecifier.text
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          add(spec, (el.propertyName ?? el.name).text, st.isTypeOnly || el.isTypeOnly)
        }
      } else if (!st.exportClause) {
        add(spec, '*', st.isTypeOnly)
      }
    }
  }
  for (const spec of value) typeOnly.delete(spec)
  return { names, typeOnly }
}

// -------------------------------------------------------------- graph maths

/** Reflexive transitive closure: for each node, everything reachable from it, itself included. */
function closure(nodes: string[], edges: Map<string, Set<string>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const start of nodes) {
    const seen = new Set<string>([start])
    const stack = [start]
    while (stack.length) {
      const cur = stack.pop()
      if (cur === undefined) break
      for (const next of edges.get(cur) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
    }
    out.set(start, seen)
  }
  return out
}

/** CCD of a balanced binary tree of n nodes -- the denominator for NCCD. */
function balancedTreeCcd(n: number): number {
  if (n <= 0) return 1
  const size = new Array<number>(n + 1).fill(1)
  for (let i = n; i >= 1; i--) {
    if (2 * i <= n) size[i] += size[2 * i]
    if (2 * i + 1 <= n) size[i] += size[2 * i + 1]
  }
  let total = 0
  for (let i = 1; i <= n; i++) total += size[i]
  return total || 1
}

/**
 * Groups of 2+ nodes that all reach each other: the cycles. Mutual
 * reachability is read straight off the transitive closure.
 */
function cyclesOf(nodes: string[], closed: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>()
  const out: string[][] = []
  for (const n of nodes) {
    if (seen.has(n)) continue
    const group = [...(closed.get(n) ?? [])].filter((m) => closed.get(m)?.has(n)).sort()
    for (const m of group) seen.add(m)
    if (group.length > 1) out.push(group)
  }
  return out.sort((a, b) => b.length - a.length)
}

interface Scored {
  nodes: string[]
  ccd: number
  acd: number
  nccd: number
  propagationCost: number
  cd: Map<string, number>
  cycles: string[][]
  cyclePenalty: number
}

function score(nodes: string[], edges: Map<string, Set<string>>): Scored {
  const closed = closure(nodes, edges)
  const cd = new Map<string, number>()
  let ccd = 0
  for (const n of nodes) {
    const size = closed.get(n)?.size ?? 1
    cd.set(n, size)
    ccd += size
  }
  const cycles = cyclesOf(nodes, closed)
  const cyclePenalty = cycles.reduce((sum, g) => sum + g.length * g.length - g.length, 0)
  return {
    nodes,
    ccd,
    acd: ccd / (nodes.length || 1),
    nccd: ccd / balancedTreeCcd(nodes.length),
    propagationCost: ccd / (nodes.length * nodes.length || 1),
    cd,
    cycles,
    cyclePenalty,
  }
}

// ---------------------------------------------------------------------- main

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')
const wantFiles = argv.includes('--files')
const wantNames = argv.includes('--names')
// Type-only imports are erased at compile time but are still interface
// coupling, so they count by default. --runtime-only drops them.
const runtimeOnly = argv.includes('--runtime-only')
const rootArgs = argv.filter((a) => !a.startsWith('--'))
const roots = rootArgs.length
  ? rootArgs
  : packages
      .map((p) => path.relative(ROOT, path.join(p.dir, 'src')))
      .filter((r) => fs.existsSync(path.join(ROOT, r)))

// dependency-cruiser's config file cannot set `importsFields` or
// `extensionAlias`, so they are passed here: they follow the `#…` subpath
// imports and map the output-form `./src/*.js` map targets to their sources.
const { output } = await cruise(
  roots,
  await extractDepcruiseOptions('./.dependency-cruiser.cjs'),
  { importsFields: ['imports'], extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
  { tsConfig: extractTSConfig('tsconfig.json') },
)
const inScope = (abs: string) =>
  roots.some((r) => abs.startsWith(path.join(ROOT, r) + path.sep)) && /\.tsx?$/.test(abs)

const files: string[] = []
const fileEdges = new Map<string, Set<string>>()
/** "from\0to" file pairs joined by at least one runtime (non-type-only) import. */
const valueEdges = new Set<string>()
let unresolved = 0

for (const mod of (output as ICruiseResult).modules) {
  const from = path.resolve(ROOT, mod.source)
  if (!inScope(from)) continue
  files.push(from)
  const targets = fileEdges.get(from) ?? new Set<string>()
  fileEdges.set(from, targets)
  const { typeOnly } = fileImports(from)
  for (const dep of mod.dependencies) {
    if (dep.coreModule) continue
    if (runtimeOnly && typeOnly.has(dep.module)) continue
    if (dep.couldNotResolve) {
      if (dep.module.startsWith('#') || dep.module.startsWith('@yaac/')) unresolved++
      continue
    }
    const to = path.resolve(ROOT, dep.resolved)
    if (!inScope(to) || to === from) continue
    targets.add(to)
    if (!typeOnly.has(dep.module)) valueEdges.add(`${from}\0${to}`)
  }
}

// Collapse to the module graph.
const fileModule = new Map<string, string>(files.map((f) => [f, moduleOf(f)]))
const moduleFiles = new Map<string, string[]>()
for (const f of files) {
  const m = fileModule.get(f)
  if (m === undefined) continue
  moduleFiles.set(m, [...(moduleFiles.get(m) ?? []), f])
}
const modules = [...moduleFiles.keys()].sort()
const moduleEdges = new Map<string, Set<string>>(modules.map((m) => [m, new Set<string>()]))
for (const [from, tos] of fileEdges) {
  const a = fileModule.get(from)
  if (a === undefined) continue
  for (const to of tos) {
    const b = fileModule.get(to)
    if (b === undefined || a === b) continue
    moduleEdges.get(a)?.add(b)
  }
}

const scored = score(modules, moduleEdges)

// Fan-in / fan-out (Martin's afferent and efferent coupling).
const ce = new Map<string, number>(modules.map((m) => [m, moduleEdges.get(m)?.size ?? 0]))
const ca = new Map<string, number>(modules.map((m) => [m, 0]))
for (const [from, tos] of moduleEdges) {
  for (const to of tos) ca.set(to, (ca.get(to) ?? 0) + (from === to ? 0 : 1))
}

// Interface width, measured at the barrels.
//
// Consumers are counted across the whole repo, not just the graph scope:
// these folders are also published through each package's `exports`, so a
// name used only by the CLI or a test must not be reported as dead.
interface Iface {
  module: string
  dir: string
  barrel: string
  exported: string[]
  /** Imported by anything outside the folder, through the barrel or past it. */
  used: Set<string>
  /** Imported through the barrel specifically -- the rest bypass it. */
  viaBarrel: Set<string>
  /**
   * For each exported name, the in-graph modules that import it. Unlike
   * `used` this is not repo-wide, since a test importing its own subject
   * would make every name look shared.
   */
  consumers: Map<string, Set<string>>
  starFrom: string[]
}

/** Every .ts/.tsx in the repo: any of them may consume a barrel. */
function allSourceFiles(): string[] {
  const out: string[] = []
  const skip = new Set(['node_modules', 'dist', '.git', 'dist-app', 'staging'])
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
    }
  }
  walk(ROOT)
  return out
}
const ifaces = new Map<string, Iface>()
for (const [spec, barrel] of barrels) {
  if (!moduleFiles.has(moduleOf(barrel))) continue
  const shape = barrelExports(barrel)
  ifaces.set(spec, {
    module: moduleOf(barrel),
    dir: path.dirname(barrel),
    barrel,
    exported: [...shape.names].sort(),
    used: new Set<string>(),
    viaBarrel: new Set<string>(),
    consumers: new Map<string, Set<string>>(),
    starFrom: shape.starFrom,
  })
}

const byDir = new Map<string, Iface>([...ifaces.values()].map((i) => [i.dir, i]))
// Cruising the whole repo would take minutes, so imports resolve here through
// TypeScript, under the repo's tsconfig. Only a relative, `#…` or `@yaac/…`
// specifier can land in a barrel.
const tsOptions = ts.parseJsonConfigFileContent(
  ts.readConfigFile('tsconfig.json', (f) => ts.sys.readFile(f)).config,
  ts.sys,
  ROOT,
).options
const tsCache = ts.createModuleResolutionCache(ROOT, (f) => f, tsOptions)
for (const f of allSourceFiles()) {
  for (const [spec, names] of fileImports(f).names) {
    if (!/^(\.|#|@yaac\/)/.test(spec)) continue
    const target = ts.resolveModuleName(spec, f, tsOptions, ts.sys, tsCache).resolvedModule
      ?.resolvedFileName
    if (!target) continue
    // Which sealed folder does this import land in, barrel or not? The
    // deepest one: drivers/k8s/substrate is sealed inside drivers/k8s.
    const iface = [...byDir]
      .filter(([dir]) => target.startsWith(dir + path.sep))
      .sort(([a], [b]) => b.length - a.length)[0]?.[1]
    if (!iface || f.startsWith(iface.dir + path.sep)) continue
    const consumer = fileModule.get(f)
    for (const n of names) {
      iface.used.add(n)
      if (target === iface.barrel) iface.viaBarrel.add(n)
      if (consumer === undefined) continue
      const set = iface.consumers.get(n) ?? new Set<string>()
      set.add(consumer)
      iface.consumers.set(n, set)
    }
  }
}

const locOf = new Map<string, number>(
  modules.map((m) => [m, (moduleFiles.get(m) ?? []).reduce((sum, f) => sum + sloc(f), 0)]),
)
const totalSloc = [...locOf.values()].reduce((a, b) => a + b, 0)

if (wantJson) {
  console.log(
    JSON.stringify(
      {
        scope: roots,
        totals: {
          modules: modules.length,
          files: files.length,
          sloc: totalSloc,
          ccd: scored.ccd,
          acd: Number(scored.acd.toFixed(2)),
          nccd: Number(scored.nccd.toFixed(2)),
          propagationCost: Number(scored.propagationCost.toFixed(4)),
          cyclePenalty: scored.cyclePenalty,
        },
        modules: modules.map((m) => {
          const iface = [...ifaces.values()].find((i) => i.module === m)
          return {
            module: m,
            files: moduleFiles.get(m)?.length ?? 0,
            sloc: locOf.get(m) ?? 0,
            cd: scored.cd.get(m) ?? 0,
            ca: ca.get(m) ?? 0,
            ce: ce.get(m) ?? 0,
            exports: iface?.exported.length ?? null,
            used: iface ? iface.used.size : null,
          }
        }),
        cycles: scored.cycles,
        edges: Object.fromEntries([...moduleEdges].map(([from, tos]) => [from, [...tos].sort()])),
        // How many files carry each module edge -- the cost of cutting it.
        edgeWeights: Object.fromEntries(
          [...moduleEdges].flatMap(([from, tos]) =>
            [...tos].sort().map((to) => [
              `${from} -> ${to}`,
              files.filter(
                (f) =>
                  fileModule.get(f) === from &&
                  [...(fileEdges.get(f) ?? [])].some((t) => fileModule.get(t) === to),
              ).length,
            ]),
          ),
        ),
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

// --------------------------------------------------------------- text report

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const num = (v: number | string, n: number) => String(v).padStart(n)

console.log(`\nscope: ${roots.join(' ')}`)
console.log(`${modules.length} modules, ${files.length} files, ${totalSloc} sloc`)
if (unresolved) console.log(`warning: ${unresolved} internal specifiers went unresolved`)

console.log(`\n${pad('MODULE', 34)}${num('sloc', 6)}${num('files', 6)}${num('exp', 5)}${num('used', 5)}${num('depth', 6)}${num('Ca', 4)}${num('Ce', 4)}${num('CD', 5)}`)
console.log('-'.repeat(75))
const byCd = [...modules].sort(
  (a, b) => (scored.cd.get(b) ?? 0) - (scored.cd.get(a) ?? 0) || a.localeCompare(b),
)
for (const m of byCd) {
  const iface = [...ifaces.values()].find((i) => i.module === m)
  const loc = locOf.get(m) ?? 0
  const exp = iface?.exported.length
  console.log(
    pad(m, 34) +
      num(loc, 6) +
      num(moduleFiles.get(m)?.length ?? 0, 6) +
      num(exp ?? '-', 5) +
      num(iface ? iface.used.size : '-', 5) +
      num(exp ? Math.round(loc / exp) : '-', 6) +
      num(ca.get(m) ?? 0, 4) +
      num(ce.get(m) ?? 0, 4) +
      num(scored.cd.get(m) ?? 0, 5),
  )
}

console.log(`\nCCD  ${scored.ccd}      (sum of CD; balanced tree of ${modules.length} would be ${balancedTreeCcd(modules.length)})`)
console.log(`ACD  ${scored.acd.toFixed(2)}      average modules reachable from one module`)
console.log(`NCCD ${scored.nccd.toFixed(2)}      1.0 = tree-like, >1.6 = tangled (Lakos)`)
console.log(`PC   ${(scored.propagationCost * 100).toFixed(1)}%     propagation cost: reach of an average change`)

if (scored.cycles.length) {
  console.log(`\ncycles: ${scored.cycles.length} (costing ${scored.cyclePenalty} of the ${scored.ccd} CCD)`)
  for (const g of scored.cycles) {
    const members = new Set(g)
    console.log(`  [${g.length}] ${[...g].sort().join(', ')}`)
    // The edges with the fewest importing files are the cheapest places to
    // break the cycle.
    const inner: { edge: string; weight: number; via: string[]; typeOnly: boolean }[] = []
    for (const from of g) {
      for (const to of moduleEdges.get(from) ?? []) {
        if (!members.has(to)) continue
        const via = files.filter(
          (f) =>
            fileModule.get(f) === from &&
            [...(fileEdges.get(f) ?? [])].some((t) => fileModule.get(t) === to),
        )
        const typeOnly = via.every((f) =>
          [...(fileEdges.get(f) ?? [])]
            .filter((t) => fileModule.get(t) === to)
            .every((t) => !valueEdges.has(`${f}\0${t}`)),
        )
        inner.push({
          edge: `${from} -> ${to}`,
          weight: via.length,
          via: via.map((f) => path.relative(ROOT, f)),
          typeOnly,
        })
      }
    }
    inner.sort((a, b) => a.weight - b.weight)
    console.log('       thinnest edges inside it:')
    for (const e of inner.slice(0, 6)) {
      const tag = e.typeOnly ? ' [type-only]' : ''
      console.log(
        `         ${pad(e.edge, 50)} ${e.weight} file${e.weight === 1 ? '' : 's'}${tag}: ${e.via.slice(0, 3).join(', ')}`,
      )
    }
  }
} else {
  console.log('\ncycles: none -- the module graph is a DAG')
}

const wide = [...ifaces.values()]
  .filter((i) => i.exported.length)
  .sort((a, b) => b.exported.length - a.exported.length)
if (wide.length) {
  console.log('\ninterfaces (barrel width, and how much of it is load-bearing):')
  console.log('  consumers counted repo-wide, including tests and other packages\n')
  for (const i of wide) {
    const dead = i.exported.filter((n) => !i.used.has(n))
    const bypassed = i.exported.filter((n) => i.used.has(n) && !i.viaBarrel.has(n))
    const testOnly = i.exported.filter((n) => i.used.has(n) && !i.consumers.has(n))
    const solo = i.exported.filter((n) => i.consumers.get(n)?.size === 1)
    const star = i.starFrom.length ? `  [+${i.starFrom.length} export *]` : ''
    console.log(
      `  ${pad(i.module, 30)}${num(i.exported.length, 4)} exported, ${num(dead.length, 3)} unused, ${num(testOnly.length, 3)} used only outside src, ${num(bypassed.length, 3)} bypass the barrel, ${num(solo.length, 3)} single-consumer${star}`,
    )
    if (dead.length) console.log(`      unused: ${dead.join(', ')}`)
    if (testOnly.length) console.log(`      outside src only: ${testOnly.join(', ')}`)
    if (bypassed.length && wantNames) console.log(`      bypassed: ${bypassed.join(', ')}`)
    if (solo.length && wantNames) console.log(`      single-consumer: ${solo.join(', ')}`)
  }
}

if (wantFiles) {
  const fileScore = score(files, fileEdges)
  console.log(`\nfile granularity: CCD ${fileScore.ccd}, NCCD ${fileScore.nccd.toFixed(2)}, PC ${(fileScore.propagationCost * 100).toFixed(1)}%`)
  console.log(`file cycles: ${fileScore.cycles.length}`)
  for (const g of fileScore.cycles.slice(0, 10)) {
    console.log(`  [${g.length}] ${g.map((f) => path.relative(ROOT, f)).sort().join(' <-> ')}`)
  }
  const deepest = [...files].sort(
    (a, b) => (fileScore.cd.get(b) ?? 0) - (fileScore.cd.get(a) ?? 0),
  )
  console.log('\nfiles pulling in the most of the codebase:')
  for (const f of deepest.slice(0, 15)) {
    console.log(`  ${num(fileScore.cd.get(f) ?? 0, 5)}  ${path.relative(ROOT, f)}`)
  }
}
console.log()
