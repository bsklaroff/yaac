/**
 * Syntax highlighting for the Changes diff view. Tokenizes a single line of
 * source into styled segments using CodeMirror/Lezer's standalone highlighting
 * primitives — the same library the config editor already ships. Pure (no DOM),
 * so it's unit-tested directly; the diff renderer wraps each segment in a span.
 *
 * `classHighlighter` emits `tok-*` class names (e.g. `tok-keyword`); the colors
 * live in index.css scoped under `.diff-hl`. Highlighting is per line, so a
 * construct spanning multiple lines (a block comment, a template literal) is
 * only recognized on the line the parser can see — the accepted tradeoff for
 * highlighting a unified diff, which is itself made of partial-file fragments.
 */

import { StreamLanguage, type StreamParser } from '@codemirror/language'
import { classHighlighter, highlightTree } from '@lezer/highlight'

// Proper Lezer grammars — highest fidelity, one dependency each.
import { javascriptLanguage, jsxLanguage, typescriptLanguage, tsxLanguage } from '@codemirror/lang-javascript'
import { jsonLanguage } from '@codemirror/lang-json'
import { cssLanguage } from '@codemirror/lang-css'
import { htmlLanguage } from '@codemirror/lang-html'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { yamlLanguage } from '@codemirror/lang-yaml'
import { pythonLanguage } from '@codemirror/lang-python'

// The long tail rides on the already-installed legacy stream modes (lower
// fidelity, but no extra dependencies).
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { go } from '@codemirror/legacy-modes/mode/go'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { c, cpp, java, csharp, kotlin, scala, objectiveC, dart } from '@codemirror/legacy-modes/mode/clike'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { perl } from '@codemirror/legacy-modes/mode/perl'
import { xml } from '@codemirror/legacy-modes/mode/xml'

export type HighlightLanguage =
  | 'js' | 'jsx' | 'ts' | 'tsx' | 'json' | 'css' | 'html' | 'md' | 'yaml' | 'python'
  | 'shell' | 'dockerfile' | 'go' | 'rust' | 'ruby' | 'sql' | 'toml'
  | 'c' | 'cpp' | 'java' | 'csharp' | 'kotlin' | 'scala' | 'objc' | 'dart'
  | 'lua' | 'swift' | 'perl' | 'xml'

export interface HighlightSegment {
  text: string
  /** Space-separated `tok-*` class names, or '' for unstyled text. */
  className: string
}

/** Don't tokenize pathological lines (minified bundles) — highlight would be
 *  noise and the parse cost isn't worth it. Render them as plain text. */
const MAX_HIGHLIGHT_LEN = 5000

function stream<S>(mode: StreamParser<S>): ReturnType<typeof StreamLanguage.define>['parser'] {
  return StreamLanguage.define(mode).parser
}

function buildParser(language: HighlightLanguage): ReturnType<typeof stream> {
  switch (language) {
    case 'js': return javascriptLanguage.parser
    case 'jsx': return jsxLanguage.parser
    case 'ts': return typescriptLanguage.parser
    case 'tsx': return tsxLanguage.parser
    case 'json': return jsonLanguage.parser
    case 'css': return cssLanguage.parser
    case 'html': return htmlLanguage.parser
    case 'md': return markdownLanguage.parser
    case 'yaml': return yamlLanguage.parser
    case 'python': return pythonLanguage.parser
    case 'shell': return stream(shell)
    case 'dockerfile': return stream(dockerFile)
    case 'go': return stream(go)
    case 'rust': return stream(rust)
    case 'ruby': return stream(ruby)
    case 'sql': return stream(standardSQL)
    case 'toml': return stream(toml)
    case 'c': return stream(c)
    case 'cpp': return stream(cpp)
    case 'java': return stream(java)
    case 'csharp': return stream(csharp)
    case 'kotlin': return stream(kotlin)
    case 'scala': return stream(scala)
    case 'objc': return stream(objectiveC)
    case 'dart': return stream(dart)
    case 'lua': return stream(lua)
    case 'swift': return stream(swift)
    case 'perl': return stream(perl)
    case 'xml': return stream(xml)
  }
}

// Parsers are stateless and reusable; build each at most once.
const parsers = new Map<HighlightLanguage, ReturnType<typeof stream>>()

function parserFor(language: HighlightLanguage): ReturnType<typeof stream> {
  let parser = parsers.get(language)
  if (!parser) {
    parser = buildParser(language)
    parsers.set(language, parser)
  }
  return parser
}

/**
 * A lookup table with no prototype behind it.
 *
 * Every key that reaches one of these comes from outside — a path in a diff,
 * a fence an agent wrote — and on an ordinary object literal `constructor`,
 * `__proto__` and `toString` all answer with something that is not a language.
 * Putting that in the data structure rather than in a guard at each call site
 * means the next table someone adds here is born safe.
 */
type LangTable = Record<string, HighlightLanguage>
function langTable(entries: LangTable): LangTable {
  return Object.assign(Object.create(null) as LangTable, entries)
}

/** File extensions (lowercased, no dot) → language. */
const EXT_TO_LANG: LangTable = langTable({
  js: 'js', mjs: 'js', cjs: 'js',
  jsx: 'jsx',
  ts: 'ts', mts: 'ts', cts: 'ts',
  tsx: 'tsx',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  html: 'html', htm: 'html', xhtml: 'html',
  md: 'md', markdown: 'md', mdx: 'md',
  yaml: 'yaml', yml: 'yaml',
  py: 'python', pyi: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  sql: 'sql',
  toml: 'toml',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  java: 'java',
  cs: 'csharp',
  kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', sc: 'scala',
  m: 'objc', mm: 'objc',
  dart: 'dart',
  lua: 'lua',
  swift: 'swift',
  pl: 'perl', pm: 'perl',
  xml: 'xml', svg: 'xml',
})

/** Whole-filename matches for extension-less or dot-prefixed files. */
const FILENAME_TO_LANG: LangTable = langTable({
  '.bashrc': 'shell', '.bash_profile': 'shell', '.profile': 'shell',
  '.zshrc': 'shell', '.zprofile': 'shell',
})

/** Read a table, answering null for anything it does not define. The `hasOwn`
 *  is belt to `langTable`'s braces: it also keeps the return type honest. */
function lookup(table: LangTable, key: string): HighlightLanguage | null {
  return Object.hasOwn(table, key) ? table[key] : null
}

/**
 * Pick a highlight language from a file path, or null when unrecognized (the
 * caller then renders plain text). Keys on the basename so directories with
 * dots don't confuse extension detection.
 */
export function languageForPath(path: string): HighlightLanguage | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  // `Dockerfile`, `Dockerfile.tools`, `foo.dockerfile` all mean dockerfile.
  if (base === 'dockerfile' || base.startsWith('dockerfile.') || base.endsWith('.dockerfile')) return 'dockerfile'
  const byName = lookup(FILENAME_TO_LANG, base)
  if (byName) return byName
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null // no extension, or a dotfile like `.gitignore`
  return lookup(EXT_TO_LANG, base.slice(dot + 1))
}

/**
 * Names a markdown fence uses that aren't file extensions (```python, ```bash).
 * Extensions themselves need no entry — they fall through to `EXT_TO_LANG`.
 */
const FENCE_TO_LANG: LangTable = langTable({
  javascript: 'js', typescript: 'ts', node: 'js',
  python: 'python', python3: 'python',
  bash: 'shell', shell: 'shell', console: 'shell', sh: 'shell', zsh: 'shell', terminal: 'shell',
  golang: 'go',
  rust: 'rust',
  ruby: 'ruby',
  csharp: 'csharp', 'c#': 'csharp',
  kotlin: 'kotlin',
  perl: 'perl',
  dockerfile: 'dockerfile', docker: 'dockerfile',
  'c++': 'cpp',
  'objective-c': 'objc',
  markdown: 'md',
})

/**
 * Pick a highlight language from a markdown fence's info string (the `ts` in
 * ```ts), or null when it names nothing we tokenize — including the fences
 * that are deliberately not code (```text) and the bare fence, which says
 * nothing at all.
 */
export function languageForFence(info: string): HighlightLanguage | null {
  const name = info.trim().toLowerCase().split(/[\s,{]/)[0]
  if (name === '') return null
  return lookup(FENCE_TO_LANG, name) ?? lookup(EXT_TO_LANG, name)
}

/**
 * Tokenize one line of source into styled segments. Segments always concatenate
 * back to the exact input, so the renderer never drops or reorders a character.
 * An empty line yields no segments.
 */
export function highlightLine(text: string, language: HighlightLanguage): HighlightSegment[] {
  if (text === '') return []
  if (text.length > MAX_HIGHLIGHT_LEN) return [{ text, className: '' }]
  const tree = parserFor(language).parse(text)
  const segments: HighlightSegment[] = []
  let pos = 0
  highlightTree(tree, classHighlighter, (from, to, className) => {
    if (from > pos) segments.push({ text: text.slice(pos, from), className: '' })
    segments.push({ text: text.slice(from, to), className })
    pos = to
  })
  if (pos < text.length) segments.push({ text: text.slice(pos), className: '' })
  return segments
}
