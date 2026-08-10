import { closeDb, getDb } from './client'

/**
 * Open the database, running any pending migrations. The composition root
 * calls this once the single-writer lock is held; every records read and
 * write after it shares the connection it opened.
 */
export async function openRecords(): Promise<void> {
  await getDb()
}

/** Checkpoint and close, so PGlite reopens clean across restarts. */
export async function closeRecords(): Promise<void> {
  await closeDb()
}
