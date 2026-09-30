/**
 * Syntax highlighting languages. A file path or markdown fence picks a
 * language; `editorLanguage` gives it to the CodeMirror editors, and
 * `highlightLine` uses it to split one line of source into styled segments
 * for the diff view.
 *
 * Segments carry `tok-*` class names whose colors are in index.css.
 * Highlighting is per line, so a multi-line construct (a block comment, a
 * template literal) is only partly recognized. That is acceptable for diffs,
 * which are partial fragments anyway.
 */

import { StreamLanguage, type Language, type StreamParser } from '@codemirror/language'
import { classHighlighter, highlightTree } from '@lezer/highlight'

// Full Lezer grammars, one dependency each.
import { javascriptLanguage, jsxLanguage, typescriptLanguage, tsxLanguage } from '@codemirror/lang-javascript'
import { jsonLanguage } from '@codemirror/lang-json'
import { cssLanguage } from '@codemirror/lang-css'
import { htmlLanguage } from '@codemirror/lang-html'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { yamlLanguage } from '@codemirror/lang-yaml'
import { pythonLanguage } from '@codemirror/lang-python'

// Other languages use the legacy stream modes: less accurate, but no extra
// dependencies.
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

/** Longer lines (e.g. minified bundles) are rendered as plain text. */
const MAX_HIGHLIGHT_LEN = 5000

function stream<S>(mode: StreamParser<S>): Language {
  return StreamLanguage.define(mode)
}

function buildLanguage(language: HighlightLanguage): Language {
  switch (language) {
    case 'js': return javascriptLanguage
    case 'jsx': return jsxLanguage
    case 'ts': return typescriptLanguage
    case 'tsx': return tsxLanguage
    case 'json': return jsonLanguage
    case 'css': return cssLanguage
    case 'html': return htmlLanguage
    case 'md': return markdownLanguage
    case 'yaml': return yamlLanguage
    case 'python': return pythonLanguage
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

// Languages are stateless and reusable; build each at most once.
const languages = new Map<HighlightLanguage, Language>()

/** The CodeMirror language used by both the editors and the diff view. */
export function editorLanguage(language: HighlightLanguage): Language {
  let built = languages.get(language)
  if (!built) {
    built = buildLanguage(language)
    languages.set(language, built)
  }
  return built
}

/**
 * A lookup table with no prototype. Keys come from untrusted input (diff
 * paths, agent-written fences), and on a plain object `constructor` or
 * `__proto__` would return something that isn't a language.
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

/** Read a table, returning null for keys it doesn't define. */
function lookup(table: LangTable, key: string): HighlightLanguage | null {
  return Object.hasOwn(table, key) ? table[key] : null
}

/**
 * Pick a highlight language from a file path's basename, or null when
 * unrecognized (the caller renders plain text).
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
 * Fence names that aren't file extensions (```python, ```bash). Extensions
 * fall through to `EXT_TO_LANG`.
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
 * ```ts), or null for a bare fence or an unknown name such as ```text.
 */
export function languageForFence(info: string): HighlightLanguage | null {
  const name = info.trim().toLowerCase().split(/[\s,{]/)[0]
  if (name === '') return null
  return lookup(FENCE_TO_LANG, name) ?? lookup(EXT_TO_LANG, name)
}

/**
 * Tokenize one line of source into styled segments that concatenate back to
 * the exact input. An empty line yields no segments.
 */
export function highlightLine(text: string, language: HighlightLanguage): HighlightSegment[] {
  if (text === '') return []
  if (text.length > MAX_HIGHLIGHT_LEN) return [{ text, className: '' }]
  const tree = editorLanguage(language).parser.parse(text)
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
