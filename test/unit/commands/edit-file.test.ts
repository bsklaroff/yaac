import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveEditor, editFile } from '@/commands/edit-file'

describe('resolveEditor', () => {
  it('prefers $EDITOR over $VISUAL and the vi fallback', () => {
    expect(resolveEditor({ EDITOR: 'nano', VISUAL: 'emacs' })).toEqual({ cmd: 'nano', args: [] })
  })

  it('falls back to $VISUAL when $EDITOR is unset', () => {
    expect(resolveEditor({ VISUAL: 'emacs' })).toEqual({ cmd: 'emacs', args: [] })
  })

  it('falls back to vi when neither variable is set', () => {
    expect(resolveEditor({})).toEqual({ cmd: 'vi', args: [] })
  })

  it('splits multi-word editor commands so `EDITOR="code -w"` works', () => {
    expect(resolveEditor({ EDITOR: 'code -w' })).toEqual({ cmd: 'code', args: ['-w'] })
  })
})

describe('editFile', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-edit-file-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // Stand-in editor: a tiny shell script that writes a marker into
  // whatever file path it's invoked with. Stored on disk so the
  // whitespace-split in resolveEditor doesn't mangle the script body.
  async function writeFakeEditor(name: string, body: string): Promise<string> {
    const editorPath = path.join(tmpDir, name)
    await fs.writeFile(editorPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return editorPath
  }

  it('creates the parent directory and invokes the editor on the file path', async () => {
    const editor = await writeFakeEditor('marker-editor', 'echo -n hello > "$1"')
    const target = path.join(tmpDir, 'nested', 'deep', 'config.json')
    await editFile(target, { EDITOR: editor })
    expect(await fs.readFile(target, 'utf8')).toBe('hello')
  })

  it('rejects when the editor exits non-zero', async () => {
    const editor = await writeFakeEditor('failing-editor', 'exit 7')
    const target = path.join(tmpDir, 'oops.txt')
    await expect(editFile(target, { EDITOR: editor })).rejects.toThrow(/exited with code 7/)
  })

  it('rejects when the editor binary cannot be spawned', async () => {
    const target = path.join(tmpDir, 'irrelevant.txt')
    await expect(
      editFile(target, { EDITOR: '/no/such/editor/binary' }),
    ).rejects.toThrow()
  })

  it('passes extra editor args before the file path', async () => {
    // Verifies the `code -w <file>` style: stand-in editor expects a
    // first arg of "--write" and writes the marker on the second arg.
    const editor = await writeFakeEditor(
      'flagged-editor',
      'test "$1" = "--write" && echo -n flagged > "$2"',
    )
    const target = path.join(tmpDir, 'flagged.txt')
    await editFile(target, { EDITOR: `${editor} --write` })
    expect(await fs.readFile(target, 'utf8')).toBe('flagged')
  })
})
