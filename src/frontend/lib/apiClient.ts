/**
 * Thin fetch wrapper for the daemon HTTP API. Same-origin (dev: the Vite
 * proxy; prod: the daemon serves the SPA), so the browser sends the
 * `yaac_session` cookie automatically — no token handling here.
 *
 * Responsibilities: JSON encode/decode, throw on non-2xx, and surface a
 * 401 as a typed error so the app can drop back to the bootstrap splash.
 */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (res.status === 401) throw new ApiError(401, 'unauthenticated')
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res))
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/** Pull the daemon's `{ error: { message } }` out of a failed response. */
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return `request failed: ${res.status}`
  try {
    const body = JSON.parse(text) as { error?: { message?: string } }
    return body.error?.message ?? text
  } catch {
    return text
  }
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),
}
