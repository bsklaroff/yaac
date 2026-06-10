import fs from 'node:fs/promises'
import path from 'node:path'
import { projectDir } from '@/lib/project/paths'

/**
 * User-assigned session titles, stored per project in
 * `<projectDir>/session-titles.json` ({ sessionId: title }). Titles are
 * display-only: the transcript-derived first message remains the fallback
 * label everywhere. Stored outside the container so they survive delete +
 * restart (session ids are stable across restarts).
 */

export const MAX_TITLE_LENGTH = 120

export function sessionTitlesPath(slug: string): string {
  return path.join(projectDir(slug), 'session-titles.json')
}

/** Normalize a user-supplied title: collapse whitespace, cap the length.
 *  Returns '' for a blank title (which clears the entry). */
export function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
}

export async function getSessionTitles(slug: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(sessionTitlesPath(slug), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Set (or, with a blank title, clear) a session's title. */
export async function setSessionTitle(slug: string, sessionId: string, title: string): Promise<void> {
  const titles = await getSessionTitles(slug)
  const normalized = normalizeTitle(title)
  if (normalized === '') {
    delete titles[sessionId]
  } else {
    titles[sessionId] = normalized
  }
  await fs.mkdir(projectDir(slug), { recursive: true })
  await fs.writeFile(sessionTitlesPath(slug), JSON.stringify(titles, null, 2) + '\n')
}
