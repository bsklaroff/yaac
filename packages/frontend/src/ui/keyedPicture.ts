import { useEffect, useState } from 'react'

/*
 * A project picture with its own solid background keyed out, so the lanes
 * on a working tile show through it. The background is the colour of the
 * picture's corners; pixels near it turn transparent, with a soft edge
 * whose colour is un-mixed from that background. Only a solid background
 * is keyed: a picture whose corners are transparent or disagree (a photo,
 * a gradient, a split background) gives null, as does one that would key
 * out almost entirely or fails to load, and the tile then shows it as it
 * is. `dark` says whether the keyed background was dark, so the lanes can
 * take the shades the picture was drawn against.
 */

export interface KeyedPicture { src: string; dark: boolean }

const SIZE = 128
/** How far, per channel, a pixel may be from the background and still key
 *  out fully; the edge fades over the next KEY_EDGE. The corners must agree
 *  this closely to count as one background. */
const KEY_FLOOR = 12
const KEY_EDGE = 48
/** Past this share of pixels keyed out fully, the picture is nearly all
 *  background and is left as it is. */
const MAX_CLEARED = 0.95
const cache = new Map<string, Promise<KeyedPicture | null>>()

/**
 * Keys the background out of `px`, a square of `size`² RGBA pixels, in
 * place. Returns whether that background was dark, or null, leaving `px`
 * as it was, when there is no solid background to key.
 */
export function keyBackground(px: Uint8ClampedArray, size: number): { dark: boolean } | null {
  const corners = [1, size - 2].flatMap((y) => [1, size - 2].map((x) => (y * size + x) * 4))
  if (corners.some((i) => px[i + 3] < 250)) return null
  const spread = Math.max(...[0, 1, 2].map((c) => {
    const values = corners.map((i) => px[i + c])
    return Math.max(...values) - Math.min(...values)
  }))
  if (spread > KEY_FLOOR) return null
  const bg = [0, 1, 2].map((c) => corners.reduce((sum, i) => sum + px[i + c], 0) / corners.length)
  const keyed = new Uint8ClampedArray(px)
  let cleared = 0
  for (let i = 0; i < keyed.length; i += 4) {
    const d = Math.max(...bg.map((v, c) => Math.abs(keyed[i + c] - v)))
    const a = Math.min(1, Math.max(0, (d - KEY_FLOOR) / KEY_EDGE))
    if (a === 1) continue
    if (a === 0) cleared++
    for (let c = 0; c < 3; c++) keyed[i + c] = a === 0 ? 0 : (keyed[i + c] - (1 - a) * bg[c]) / a
    keyed[i + 3] *= a
  }
  if (cleared > MAX_CLEARED * size * size) return null
  px.set(keyed)
  return { dark: 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2] < 128 }
}

async function key(url: string): Promise<KeyedPicture | null> {
  const img = new Image()
  img.src = url
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  // The same square crop as the tile's object-cover. An SVG with only a
  // viewBox may have no natural size and is drawn to the square.
  const w = img.naturalWidth || SIZE
  const h = img.naturalHeight || SIZE
  const scale = SIZE / Math.min(w, h)
  ctx.drawImage(img, (SIZE - w * scale) / 2, (SIZE - h * scale) / 2, w * scale, h * scale)
  const image = ctx.getImageData(0, 0, SIZE, SIZE)
  const keyed = keyBackground(image.data, SIZE)
  if (!keyed) return null
  ctx.putImageData(image, 0, 0)
  return { src: canvas.toDataURL(), dark: keyed.dark }
}

/** `url`'s keyed picture, once worked out; undefined while it is or when
 *  `url` is undefined. */
export function useKeyedPicture(url: string | undefined): KeyedPicture | null | undefined {
  const [done, setDone] = useState<{ url: string; keyed: KeyedPicture | null }>()
  useEffect(() => {
    if (url === undefined) return
    let live = true
    let job = cache.get(url)
    if (!job) {
      job = key(url).catch(() => null)
      cache.set(url, job)
    }
    void job.then((keyed) => { if (live) setDone({ url, keyed }) })
    return () => { live = false }
  }, [url])
  return url !== undefined && done?.url === url ? done.keyed : undefined
}
