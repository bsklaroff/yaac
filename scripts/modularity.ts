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
// Interface width is measured against the barrels, since a sealed folder's
// index.ts *is* its interface (see CLAUDE.md). `exports` counts the names it
// re-exports, `used` counts how many of them anything outside actually imports,
// and depth is Ousterhout's ratio -- implementation lines per exported name.
// A deep module hides a lot behind a little; a shallow one is mostly surface.
//
// LOC is reported but deliberately not folded into a score: minimizing lines
// pushes toward extracting shared abstractions, which is a leading cause of
// wide interfaces and cycles. It is a tiebreaker, not a co-equal objective.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------- manifests

interface Manifest {
  name?: string
  imports?: Record<string, string>
  exports?: Record<string, string>
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

// ------------------------------------------------------- subpath resolution
// dependency-cruiser cannot follow `#…` specifiers (see .dependency-cruiser.cjs),
// so we redo that resolution against the owning package's imports map. The map
// targets are output-form `./src/*.js`; the source they stand for is `.ts`.

function existingSource(target: string): string | undefined {
  const candidates = [
    target.replace(/\.js$/, '.ts'),
    target.replace(/\.js$/, '.tsx'),
    target,
    `${target}.ts`,
    `${target}.tsx`,
    path.join(target, 'index.ts'),
    path.join(target, 'index.tsx'),
  ]
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile())
}

function applyMap(map: Record<string, string>, spec: string): string | undefined {
  const exact = map[spec]
  if (exact) return exact
  for (const [key, target] of Object.entries(map)) {
    const star = key.indexOf('*')
    if (star === -1) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue
    if (spec.length < prefix.length + suffix.length) continue
    const filled = spec.slice(prefix.length, spec.length - suffix.length)
    return target.replace('*', filled)
  }
  return undefined
}

function resolveSpec(fromFile: string, spec: string): string | undefined {
  if (spec.startsWith('#')) {
    const owner = ownerOf(fromFile)
    if (!owner?.manifest.imports) return undefined
    const target = applyMap(owner.manifest.imports, spec)
    return target ? existingSource(path.join(owner.dir, target)) : undefined
  }
  if (spec.startsWith('@yaac/')) {
    const [, , ...rest] = spec.split('/')
    const pkgName = spec.split('/').slice(0, 2).join('/')
    const target = packages.find((p) => p.manifest.name === pkgName)
    if (!target?.manifest.exports) return undefined
    const sub = rest.length ? `./${rest.join('/')}` : '.'
    const mapped = applyMap(target.manifest.exports, sub)
    return mapped ? existingSource(path.join(target.dir, mapped)) : undefined
  }
  return undefined
}

// ------------------------------------------------------------ module naming
// A sealed folder is always its own module: its barrel is the interface the
// repo has already committed to, so it is the boundary whether or not the
// parent directory also holds loose files (runtime/ is both). Everything else
// falls back to the shallowest directory under src/ that holds source files
// directly, which makes pure namespace directories transparent -- features/ is
// not a module, features/worktrees is.

/** Directories whose index.ts is published through a package's imports map. */
const sealedDirs = new Set<string>()
for (const pkg of packages) {
  for (const [spec, target] of Object.entries(pkg.manifest.imports ?? {})) {
    if (spec.includes('*')) continue
    const file = existingSource(path.join(pkg.dir, target))
    if (file && /(^|\/)index\.tsx?$/.test(file)) sealedDirs.add(path.dirname(file))
  }
}

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

// ----------------------------------------------------------------- the graph

interface CruiseDep {
  resolved: string
  module: string
  couldNotResolve?: boolean
  coreModule?: boolean
}
interface CruiseModule {
  source: string
  dependencies: CruiseDep[]
}
interface CruiseResult {
  modules: CruiseModule[]
}

function cruise(roots: string[]): CruiseResult {
  const args = [...roots, '--config', '.dependency-cruiser.cjs', '--output-type', 'json']
  let raw: string
  try {
    raw = execFileSync(path.join(ROOT, 'node_modules/.bin/depcruise'), args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    })
  } catch (err) {
    // Rule violations make depcruise exit non-zero; the report is still on stdout.
    const stdout = (err as { stdout?: string }).stdout
    if (!stdout) throw err
    raw = stdout
  }
  return JSON.parse(raw) as CruiseResult
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

/**
 * We decide type-only-ness ourselves rather than trusting dependency-cruiser's
 * `type-only` dependencyType, because the `#…` edges we re-resolve come back
 * from it tagged only as "unknown" -- there would be no flag to read.
 */
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

/** Tarjan's strongly connected components; only groups of 2+ are cycles. */
function stronglyConnected(nodes: string[], edges: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []
  let counter = 0

  const strongConnect = (v: string) => {
    // Iterative, so a deep graph cannot blow the JS stack.
    const work: { node: string; iter: Iterator<string> }[] = []
    index.set(v, counter)
    low.set(v, counter)
    counter++
    stack.push(v)
    onStack.add(v)
    work.push({ node: v, iter: (edges.get(v) ?? new Set<string>())[Symbol.iterator]() })
    while (work.length) {
      const frame = work[work.length - 1]
      const step = frame.iter.next()
      if (!step.done) {
        const w = step.value
        if (!index.has(w)) {
          index.set(w, counter)
          low.set(w, counter)
          counter++
          stack.push(w)
          onStack.add(w)
          work.push({ node: w, iter: (edges.get(w) ?? new Set<string>())[Symbol.iterator]() })
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(w) ?? 0))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const group: string[] = []
        for (;;) {
          const w = stack.pop()
          if (w === undefined) break
          onStack.delete(w)
          group.push(w)
          if (w === frame.node) break
        }
        out.push(group)
      }
    }
  }

  for (const n of nodes) if (!index.has(n)) strongConnect(n)
  return out
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
  const cycles = stronglyConnected(nodes, edges)
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length)
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
// Type-only imports are erased at compile time, so they cost nothing at link or
// startup -- but they are still interface coupling, and a type that crosses a
// barrel still has to be understood to use it. They count by default; pass
// --runtime-only to see the graph the linker sees.
const runtimeOnly = argv.includes('--runtime-only')
const rootArgs = argv.filter((a) => !a.startsWith('--'))
const roots = rootArgs.length
  ? rootArgs
  : packages
      .map((p) => path.relative(ROOT, path.join(p.dir, 'src')))
      .filter((r) => fs.existsSync(path.join(ROOT, r)))

const result = cruise(roots)
const inScope = (abs: string) =>
  roots.some((r) => abs.startsWith(path.join(ROOT, r) + path.sep)) && /\.tsx?$/.test(abs)

// File graph, with the `#…` edges dependency-cruiser dropped resolved back in.
const files: string[] = []
const fileEdges = new Map<string, Set<string>>()
/** "from\0to" file pairs joined by at least one runtime (non-type-only) import. */
const valueEdges = new Set<string>()
let unresolved = 0

for (const mod of result.modules) {
  const from = path.resolve(ROOT, mod.source)
  if (!inScope(from)) continue
  files.push(from)
  const targets = fileEdges.get(from) ?? new Set<string>()
  fileEdges.set(from, targets)
  const { typeOnly } = fileImports(from)
  for (const dep of mod.dependencies) {
    if (dep.coreModule) continue
    if (runtimeOnly && typeOnly.has(dep.module)) continue
    let to: string | undefined
    if (dep.couldNotResolve) {
      to = resolveSpec(from, dep.module)
      if (!to) {
        if (dep.module.startsWith('#') || dep.module.startsWith('@yaac/')) unresolved++
        continue
      }
    } else {
      to = path.resolve(ROOT, dep.resolved)
    }
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
// Consumers are counted across the WHOLE repo, not just the graph scope: these
// folders are published through each package's `exports` too, so the CLI, the
// root e2e trees and other packages' tests are real consumers. Scoping this to
// the modules under analysis reports names as dead when they are merely used
// from somewhere else, which is the one way this report could cause damage.
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
   * For each exported name, the in-graph modules that import it. Deliberately
   * NOT repo-wide like `used`: this drives the design signal (is this name part
   * of a shared abstraction, or a bespoke pairing?), and a test importing its
   * own subject would make every name look shared.
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
for (const pkg of packages) {
  for (const [spec, target] of Object.entries(pkg.manifest.imports ?? {})) {
    if (spec.includes('*')) continue
    const barrel = existingSource(path.join(pkg.dir, target))
    if (!barrel || !moduleFiles.has(moduleOf(barrel))) continue
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
}

const byDir = new Map<string, Iface>([...ifaces.values()].map((i) => [i.dir, i]))
for (const f of allSourceFiles()) {
  for (const [spec, names] of fileImports(f).names) {
    const target = spec.startsWith('.')
      ? existingSource(path.resolve(path.dirname(f), spec))
      : resolveSpec(f, spec)
    if (!target) continue
    // Which sealed folder does this import land in, barrel or not?
    const iface = [...byDir].find(([dir]) => target.startsWith(dir + path.sep))?.[1]
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
            [...tos].map((to) => [
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
    // Every edge inside the group is load-bearing for the cycle; the thin ones
    // (fewest importing files) are the cheapest places to break it.
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
