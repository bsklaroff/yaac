import { api } from './api'

/**
 * Client for the build-files routes — the support files living next to a
 * Dockerfile in its build dir (the image's whole build context). One
 * interface, two scopes: per-project (`/project/:slug/build-files`) and
 * global user (`/config/user-build-files`), so the settings panel renders
 * both with a single component.
 */

export interface BuildFileEntry {
  /** Context-relative path, `/`-separated. */
  path: string
  size: number
  binary: boolean
}

export interface BuildFileContent extends BuildFileEntry {
  /** UTF-8 text for editable files; null when binary or too large. */
  content: string | null
}

export interface BuildFilesApi {
  list(): Promise<BuildFileEntry[]>
  read(path: string): Promise<BuildFileContent>
  saveText(path: string, content: string): Promise<BuildFileEntry>
  /** Upload raw bytes (base64 over the same JSON route as text saves). */
  upload(path: string, data: ArrayBuffer): Promise<BuildFileEntry>
  remove(path: string): Promise<void>
}

/** ArrayBuffer → base64, chunked so large files don't blow the arg limit. */
export function encodeBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  const chunks: string[] = []
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return btoa(chunks.join(''))
}

/** Build-files client for a project's Dockerfile.yaac context. */
export function projectBuildFilesApi(slug: string): BuildFilesApi {
  const bf = api.project[':slug']['build-files']
  return {
    list: async () => (await bf.$get({ param: { slug } })).files,
    read: (path) => bf.file.$get({ param: { slug }, query: { path } }),
    saveText: (path, content) => bf.file.$put({ param: { slug }, json: { path, content } }),
    upload: (path, data) =>
      bf.file.$put({ param: { slug }, json: { path, contentBase64: encodeBase64(data) } }),
    remove: async (path) => {
      await bf.file.$delete({ param: { slug }, query: { path } })
    },
  }
}

/** Build-files client for the global Dockerfile.user context. */
export function userBuildFilesApi(): BuildFilesApi {
  const bf = api.config['user-build-files']
  return {
    list: async () => (await bf.$get()).files,
    read: (path) => bf.file.$get({ query: { path } }),
    saveText: (path, content) => bf.file.$put({ json: { path, content } }),
    upload: (path, data) =>
      bf.file.$put({ json: { path, contentBase64: encodeBase64(data) } }),
    remove: async (path) => {
      await bf.file.$delete({ query: { path } })
    },
  }
}
