import fs from 'node:fs/promises'
import path from 'node:path'
import { credentialsDir } from '@yaac/shared/project-paths'
import { BUILT_IN_USER_ID, getToolCredential, setToolCredential } from '#db'
import { serverLog } from '#log'
import {
  AGENT_TOOLS,
  claudeCredentialsFileSchema,
  codexCredentialsFileSchema,
  opencodeCredentialsFileSchema,
  piCredentialsFileSchema,
  type AgentTool,
} from '@yaac/shared/types'

const schemas = {
  claude: claudeCredentialsFileSchema,
  codex: codexCredentialsFileSchema,
  opencode: opencodeCredentialsFileSchema,
  pi: piCredentialsFileSchema,
} satisfies Record<AgentTool, unknown>

/**
 * Move the tool sign-ins an install kept in `.credentials/<tool>.json`,
 * before they were stored per user, to the built-in user, which owned
 * everything then. A file is deleted once its row reads back equal, or
 * when the built-in user already has a row for that tool (the database
 * wins). A file that fails its schema was already ignored; it is moved to
 * `.credentials-unreadable/` so a user can still repair it by hand. The
 * directory goes once empty. Run on every start, before anything reads the
 * store (docs/legacy-compat-shims.md "Importing tool sign-ins from
 * `.credentials/`").
 */
export async function importToolCredentialFiles(): Promise<void> {
  const dir = credentialsDir()
  if (await fs.readdir(dir).catch(() => null) === null) return
  for (const tool of AGENT_TOOLS) {
    const file = path.join(dir, `${tool}.json`)
    const raw = await fs.readFile(file, 'utf8').catch(() => null)
    if (raw === null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch { /* fails the schema below */ }
    const result = schemas[tool].safeParse(parsed)
    if (!result.success) {
      const aside = path.join(unreadableDir(), `${tool}.json`)
      await fs.mkdir(unreadableDir(), { recursive: true, mode: 0o700 })
      await fs.rename(file, aside)
      serverLog(`[server] the ${tool} sign-in in ${dir} is unreadable; moved to ${aside}. Sign in to ${tool} again`)
      continue
    }
    if (!await getToolCredential(BUILT_IN_USER_ID, tool)) {
      // `schemas[tool]` matches `tool`, which TS can't pair through the index.
      await setToolCredential(BUILT_IN_USER_ID, tool, result.data as never)
      if (JSON.stringify(await getToolCredential(BUILT_IN_USER_ID, tool)) !== JSON.stringify(result.data)) {
        serverLog(`[server] importing the ${tool} sign-in from ${dir} did not read back; keeping the file`)
        continue
      }
      serverLog(`[server] imported the ${tool} sign-in from ${dir}`)
    }
    await fs.rm(file)
  }
  // Only if empty: anything else in it is not ours to delete.
  await fs.rmdir(dir).catch(() => { /* not empty */ })
}

/** Where a pre-database sign-in that fails its schema is kept. */
function unreadableDir(): string {
  return path.join(path.dirname(credentialsDir()), '.credentials-unreadable')
}
