/**
 * What every patch in this folder shares: anchored string edits to one
 * file of a pinned adapter release, and the command line the image build
 * and the containerless install run them by (`node <patch>.js <file>`).
 *
 * An anchor that is missing or not unique fails the patch, so a release
 * bump cannot silently drop an edit. A marker comment after the first line
 * (below any shebang) makes a second run a no-op.
 */

import fs from 'node:fs'
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
  const nl = out.indexOf('\n') + 1
  return `${out.slice(0, nl)}${marker}\n${out.slice(nl)}`
}

/** Patch the file named on the command line in place when `moduleUrl` is
 *  the script node was run with. */
export function patchFileFromArgv(moduleUrl, patch) {
  if (process.argv[1] !== fileURLToPath(moduleUrl)) return
  const file = process.argv[2]
  if (file === undefined) {
    console.error(`usage: node ${process.argv[1]} <file to patch>`)
    process.exit(2)
  }
  try {
    fs.writeFileSync(file, patch(fs.readFileSync(file, 'utf8')))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
