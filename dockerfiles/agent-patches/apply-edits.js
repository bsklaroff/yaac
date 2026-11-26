/**
 * What every patch in this folder shares: anchored string edits to files
 * of a pinned adapter release, and the command line the image build and the
 * containerless install run them by (`node <patch>.js <file>`, or
 * `<folder>` for a patch that edits several files).
 *
 * An anchor that is missing or not unique fails the patch, so a release
 * bump cannot silently drop an edit. A marker comment on the first line
 * (below a shebang) makes a second run a no-op.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `source` with `edits` applied in order. Each edit replaces its `anchor`,
 * or inserts `text` `before` or `after` it. Throws naming the first edit
 * whose anchor is missing or appears more than once.
 */
export function applyEdits(source, patch, edits) {
  const marker = `/* yaac: ${patch} patch */`
  if (source.includes(marker)) return source
  let out = source
  for (const { name, anchor, insert, text } of edits) {
    const at = out.indexOf(anchor)
    if (at === -1 || out.indexOf(anchor, at + 1) !== -1) {
      throw new Error(`${patch} patch: the anchor for "${name}" is ${at === -1 ? 'missing' : 'not unique'}`)
    }
    const replacement = insert === 'after' ? anchor + text : insert === 'before' ? text + anchor : text
    out = out.slice(0, at) + replacement + out.slice(at + anchor.length)
  }
  const top = out.startsWith('#!') ? out.indexOf('\n') + 1 : 0
  return `${out.slice(0, top)}${marker}\n${out.slice(top)}`
}

/**
 * Patch what the command line names, in place, when `moduleUrl` is the
 * script node was run with: one file with `patch(source)`, or with `files`
 * each of those files of the folder named, with `patch(source, file)`.
 */
export function patchFileFromArgv(moduleUrl, patch, files) {
  if (process.argv[1] !== fileURLToPath(moduleUrl)) return
  const target = process.argv[2]
  if (target === undefined) {
    console.error(`usage: node ${process.argv[1]} <${files === undefined ? 'file' : 'folder'} to patch>`)
    process.exit(2)
  }
  try {
    for (const name of files ?? ['']) {
      const file = path.join(target, name)
      fs.writeFileSync(file, patch(fs.readFileSync(file, 'utf8'), name))
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
