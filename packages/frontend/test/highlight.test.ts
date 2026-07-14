import { describe, it, expect } from 'vitest'
import { languageForPath, highlightLine, type HighlightSegment } from '#lib/highlight'

const joined = (segs: HighlightSegment[]): string => segs.map((s) => s.text).join('')

describe('languageForPath', () => {
  it('maps common extensions to languages', () => {
    const cases: Record<string, string> = {
      'src/app.ts': 'ts',
      'src/App.tsx': 'tsx',
      'build.js': 'js',
      'a.mjs': 'js',
      'view.jsx': 'jsx',
      'tsconfig.json': 'json',
      'styles/main.css': 'css',
      'styles/main.scss': 'css',
      'README.md': 'md',
      'ci.yaml': 'yaml',
      'ci.yml': 'yaml',
      'script.py': 'python',
      'run.sh': 'shell',
      'main.go': 'go',
      'lib.rs': 'rust',
      'app.rb': 'ruby',
      'schema.sql': 'sql',
      'Cargo.toml': 'toml',
      'main.c': 'c',
      'main.cpp': 'cpp',
      'App.java': 'java',
      'Program.cs': 'csharp',
      'Main.kt': 'kotlin',
      'view.swift': 'swift',
      'data.xml': 'xml',
      'icon.svg': 'xml',
    }
    for (const [path, lang] of Object.entries(cases)) {
      expect(languageForPath(path), path).toBe(lang)
    }
  })

  it('lowercases the extension', () => {
    expect(languageForPath('README.MD')).toBe('md')
    expect(languageForPath('SRC/App.TSX')).toBe('tsx')
  })

  it('recognizes Dockerfiles by name, suffix, and extension', () => {
    expect(languageForPath('Dockerfile')).toBe('dockerfile')
    expect(languageForPath('dockerfiles/Dockerfile.tools')).toBe('dockerfile')
    expect(languageForPath('base.dockerfile')).toBe('dockerfile')
  })

  it('recognizes shell dotfiles but not unmapped dotfiles', () => {
    expect(languageForPath('.bashrc')).toBe('shell')
    expect(languageForPath('home/.zshrc')).toBe('shell')
    expect(languageForPath('.gitignore')).toBeNull()
  })

  it('keys on the basename, so dotted directories do not confuse detection', () => {
    expect(languageForPath('src/foo.bar/thing.ts')).toBe('ts')
    expect(languageForPath('a.b.c/Makefile')).toBeNull()
  })

  it('returns null for unknown or extension-less paths', () => {
    expect(languageForPath('LICENSE')).toBeNull()
    expect(languageForPath('notes.unknownext')).toBeNull()
    expect(languageForPath('dir.with.dots/binary')).toBeNull()
  })
})

describe('highlightLine', () => {
  it('returns no segments for an empty line', () => {
    expect(highlightLine('', 'ts')).toEqual([])
  })

  it('tags a keyword in a proper Lezer grammar', () => {
    const segs = highlightLine('const x = 1', 'ts')
    const keyword = segs.find((s) => s.text === 'const')
    expect(keyword?.className).toContain('tok-keyword')
    const num = segs.find((s) => s.text === '1')
    expect(num?.className).toContain('tok-number')
  })

  it('highlights via legacy stream modes too', () => {
    const segs = highlightLine('echo hi # note', 'shell')
    const comment = segs.find((s) => s.text.includes('# note'))
    expect(comment?.className).toContain('tok-comment')
  })

  it('segments always concatenate back to the exact input', () => {
    const samples: Array<[string, Parameters<typeof highlightLine>[1]]> = [
      ['const x: number = 42 // hi', 'ts'],
      ['  plain text with   spaces', 'ts'],
      ['func main() { return nil }', 'go'],
      ['SELECT * FROM t WHERE a = 1;', 'sql'],
      ['def f(): pass', 'python'],
    ]
    for (const [text, lang] of samples) {
      expect(joined(highlightLine(text, lang)), text).toBe(text)
    }
  })

  it('covers plain (untokenized) text with an unstyled segment', () => {
    const segs = highlightLine('    ', 'ts')
    expect(joined(segs)).toBe('    ')
    expect(segs.every((s) => s.className === '')).toBe(true)
  })

  it('skips highlighting for pathologically long lines', () => {
    const long = 'a'.repeat(6000)
    expect(highlightLine(long, 'ts')).toEqual([{ text: long, className: '' }])
  })
})
