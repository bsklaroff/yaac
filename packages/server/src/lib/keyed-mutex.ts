/**
 * In-process keyed mutex: tasks with the same key run one at a time in
 * submission order; different keys run concurrently. Enough for state only
 * this server process mutates. A failed task does not fail the ones queued
 * after it.
 */
export function createKeyedMutex(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const queues = new Map<string, Promise<unknown>>()
  return async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const prev = queues.get(key) ?? Promise.resolve()
    const run = prev.catch(() => { /* predecessor's caller saw its error */ }).then(task)
    queues.set(key, run)
    try {
      return await run
    } finally {
      if (queues.get(key) === run) queues.delete(key)
    }
  }
}
