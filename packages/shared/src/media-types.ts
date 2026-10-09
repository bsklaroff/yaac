/**
 * The file types the webapp's file pane shows as media instead of text
 * (docs/file-editor.md, "Media files"), by extension. The server serves a
 * workspace file's bytes only under one of these types, so the route never
 * hands a browser HTML or SVG that could run script on the app's origin.
 */
const MEDIA_TYPES: ReadonlyMap<string, string> = new Map(Object.entries({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  pdf: 'application/pdf',
}))

/** The media type a file is shown as, or null when it is not media. */
export function mediaType(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return MEDIA_TYPES.get(name.slice(dot + 1).toLowerCase()) ?? null
}
