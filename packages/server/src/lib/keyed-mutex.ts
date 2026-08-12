/**
 * In-process keyed mutual exclusion via per-key promise chaining: tasks
 * sharing a key run one at a time in submission order; distinct keys run
 * concurrently. The server is a single process, so this is sufficient
 * mutual exclusion for anything only it mutates (per-project git config
 * writes, per-project registry ensures). A failed predecessor does not
 * poison the chain — each task gets its own verdict.
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
