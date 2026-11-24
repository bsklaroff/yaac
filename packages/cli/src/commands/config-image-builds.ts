import { DEFAULT_IMAGE_CACHE_DAYS } from '@yaac/shared/types'
import { api, resolveProject } from '#commands/api'

/*
 * The image build settings (docs/image-builds.md): `yaac config
 * build-concurrency [n]`, how many builds the install runs at once, and
 * `yaac config image-cache-days <project> [days]`, how old a build cache
 * entry a project's builds still reuse. Each prints given no value, sets
 * one, or with `--none` returns to the default.
 */

/** The value a setting is set to: a whole number of at least 1, or null
 *  for `--none`; undefined to print it. */
function wanted(value: string | undefined, opts: { none?: boolean }, unit: string): number | null | undefined {
  if (value !== undefined && opts.none === true) throw new Error(`Pass a number of ${unit} or --none, not both.`)
  if (opts.none === true) return null
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${value} is not a whole number of ${unit}; pass --none for the default.`)
  return Number(value)
}

export async function configBuildConcurrency(value: string | undefined, opts: { none?: boolean }): Promise<void> {
  const n = wanted(value, opts, 'builds')
  if (n === undefined) {
    console.log(`The server runs up to ${(await api.image.settings.$get()).buildConcurrency} image builds at once.`)
    return
  }
  const { buildConcurrency } = await api.image.settings.$put({ json: { buildConcurrency: n } })
  console.log(`The server now runs up to ${buildConcurrency} image builds at once.`)
}

export async function configImageCacheDays(project: string, value: string | undefined, opts: { none?: boolean }): Promise<void> {
  const summary = await resolveProject(project)
  const days = wanted(value, opts, 'days')
  const say = (verb: string, d: number | undefined): void => console.log(`${summary.name}'s image builds ${verb} cached `
    + `steps up to ${d ?? DEFAULT_IMAGE_CACHE_DAYS} days old${d === undefined ? ' (the default)' : ''}.`)
  if (days === undefined) {
    say('reuse', summary.imageCacheDays)
    return
  }
  await api.image.project[':projectId']['cache-days'].$put({ param: { projectId: summary.id }, json: { days } })
  say('now reuse', days ?? undefined)
}
