import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '@yaac/shared/env'

/**
 * Edit a JSON value in the user's editor, as `kubectl edit` does: the value
 * pretty-printed under a `//` comment header, `$VISUAL`, else `$EDITOR`,
 * else `vi`, and on save the header stripped and the rest parsed. A file
 * that does not parse reopens with its errors added to the header until it
 * does. Emptying it, or saving a value equal to `baseline` (what is already
 * stored, which may differ from what was shown), cancels (undefined).
 */
export function editJsonInEditor<T>(
  initial: unknown,
  header: string[],
  parse: (value: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
  baseline: unknown,
): T | undefined {
  const editor = env.editor
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaac-edit-'))
  const file = path.join(dir, 'models.json')
  let errors: string[] = []
  try {
    let text = JSON.stringify(initial, null, 2) + '\n'
    for (;;) {
      const lines = [...header, ...errors.length > 0 ? ['', 'The last save did not parse:', ...errors] : []]
      fs.writeFileSync(file, lines.map((l) => (l === '' ? '//' : `// ${l}`)).join('\n') + '\n' + text)
      const run = spawnSync('sh', ['-c', `${editor} "$1"`, 'sh', file], { stdio: 'inherit' })
      if (run.status !== 0) throw new Error(`${editor} exited with ${run.status ?? run.signal ?? 'an error'}`)
      text = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.startsWith('//')).join('\n')
      if (text.trim() === '') return undefined
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch (err) {
        errors = [err instanceof Error ? err.message : String(err)]
        continue
      }
      const result = parse(value)
      if (result.ok) return JSON.stringify(result.value) === JSON.stringify(baseline) ? undefined : result.value
      errors = result.errors
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
