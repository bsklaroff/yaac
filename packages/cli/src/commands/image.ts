import fs from 'node:fs/promises'
import path from 'node:path'
import { text } from 'node:stream/consumers'
import { api, resolveProject, resolveProjectId } from '#commands/api'
import { printTable } from '#commands/table'
import { formatInZone } from '@yaac/shared/schedule'
import { STOCK_IMAGE_ID, type ImageBuild, type ImageFileManifest, type ImageRevision, type ImageSummary } from '@yaac/shared/types'

/*
 * `yaac image …`: a project's named images and your own Dockerfile.user
 * image, their revisions and builds (docs/image-builds.md). Images are named
 * within their project; `yaac` is the stock image, which may be the default
 * but has no Dockerfile of its own. Cluster servers only; a containerless
 * one refuses every route with `NOT_SUPPORTED`.
 *
 * A save sends the Dockerfile and a manifest of support files, each
 * uploaded first by content. A save without `--context` keeps the current
 * revision's files, so editing only the Dockerfile never drops them.
 */

/** The image a command acts on: one of a project's, or the caller's own. */
export interface ImageTarget {
  image: ImageSummary
  /** How messages name it. */
  label: string
}

const USER_LABEL = 'your Dockerfile.user'

/** How often a followed build's log is read. */
const LOG_POLL_MS = 1_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function imagesOf(projectId: string): Promise<ImageSummary[]> {
  return api.image.project[':projectId'].$get({ param: { projectId } })
}

function findImage(images: ImageSummary[], name: string, projectName: string): ImageSummary {
  const found = images.find((i) => i.name === name)
  if (found === undefined) throw new Error(`${projectName} has no image "${name}"; its images are ${images.map((i) => i.name).join(', ')}.`)
  return found
}

/** The id of the image `name` names in a project (`yaac` for the stock
 *  image), as a create or a site sends it. */
export async function resolveImageId(projectId: string, projectRef: string, name: string): Promise<string> {
  return findImage(await imagesOf(projectId), name, projectRef).id
}

/** A project's image by name, for a command about its content or builds,
 *  which the stock image does not have. */
export async function projectImage(project: string, name: string): Promise<ImageTarget> {
  const p = await resolveProject(project)
  const image = findImage(await imagesOf(p.id), name, p.name)
  if (image.id === STOCK_IMAGE_ID) throw new Error('yaac is the stock image yaac ships; it has no Dockerfile, revisions or builds of its own.')
  return { image, label: image.name }
}

/** The caller's own Dockerfile.user image. */
export async function userImage(): Promise<ImageTarget> {
  const { image } = await api.image.user.$get()
  if (image === null) throw new Error('You have no Dockerfile.user; save one with `yaac image user edit --file <path>`.')
  return { image, label: USER_LABEL }
}

export async function imageList(project: string): Promise<void> {
  const p = await resolveProject(project)
  const images = await imagesOf(p.id)
  console.log(`Images of ${p.name}; a create takes an image's last built revision:`)
  printTable(
    [{ header: 'IMAGE' }, { header: 'DEFAULT' }, { header: 'STATE' }, { header: 'REVISION' }, { header: 'BUILT' }],
    images.map((i) => [
      i.name, i.isDefault ? 'yes' : '', i.state,
      i.currentRevision !== undefined ? String(i.currentRevision.number) : '-',
      i.lastBuiltRevision !== undefined ? String(i.lastBuiltRevision.number) : '-',
    ]),
  )
}

/**
 * Print a revision's Dockerfile to stdout as stored, so `> file`
 * round-trips, and what else it holds to stderr.
 */
export async function imageShow(target: ImageTarget, opts: { revision?: string }): Promise<void> {
  const imageId = target.image.id
  const revision = opts.revision === undefined
    ? (await api.image[':imageId'].$get({ param: { imageId } })).revision
    : revisionNumbered(await revisionsOf(imageId), opts.revision, target.label)
  if (revision === null) throw new Error(`${target.label} has no revisions.`)
  const [names, zone] = await Promise.all([userNames(), timeZone()])
  const current = revision.id === target.image.currentRevision?.id ? ', the current one' : ''
  console.error(`${target.label} revision ${revision.number}${current}, saved by ${names(revision.author)} `
    + `${formatInZone(new Date(revision.createdAt), zone)} ${zone}${revision.note !== undefined ? `: ${revision.note}` : ''}`)
  const files = Object.entries(revision.files)
  console.error(`Support files: ${files.length === 0 ? 'none' : files.map(([rel, f]) => `${rel} (${f.size} B)`).join(', ')}`)
  if (revision.missingFiles.length > 0) console.error(`No longer kept: ${revision.missingFiles.join(', ')}`)
  process.stdout.write(revision.dockerfile)
}

/** What a save's options name: a Dockerfile, a context dir of support
 *  files, and a note. */
export interface ImageContentOptions {
  file: string
  context?: string
  note?: string
}

export async function imageCreate(project: string, name: string, opts: ImageContentOptions): Promise<void> {
  const { id: projectId, name: projectName } = await resolveProject(project)
  const content = await contentOf(opts,
    (contentBase64) => api.image.project[':projectId'].files.$post({ param: { projectId }, json: { contentBase64 } }),
    () => Promise.resolve({}))
  const { builds, currentRevision } = await api.image.project[':projectId'].$post({ param: { projectId }, json: { name, ...content } })
  console.log(`Created image ${name} in ${projectName}.`)
  reportSave(name, { revision: currentRevision!, changed: true, builds })
}

export async function imageEdit(target: ImageTarget, opts: ImageContentOptions): Promise<void> {
  const imageId = target.image.id
  const content = await contentOf(opts,
    (contentBase64) => api.image[':imageId'].files.$post({ param: { imageId }, json: { contentBase64 } }),
    () => currentFiles(imageId))
  reportSave(target.label, await api.image[':imageId'].$put({ param: { imageId }, json: content }))
}

/** Save the caller's Dockerfile.user, which its first save creates. */
export async function imageUserEdit(opts: ImageContentOptions): Promise<void> {
  const { image } = await api.image.user.$get()
  const content = await contentOf(opts,
    (contentBase64) => api.image.user.files.$post({ json: { contentBase64 } }),
    () => (image !== null ? currentFiles(image.id) : Promise.resolve({})))
  reportSave(USER_LABEL, await api.image.user.$put({ json: content }))
}

export async function imageRm(target: ImageTarget): Promise<void> {
  await api.image[':imageId'].$delete({ param: { imageId: target.image.id } })
  console.log(`Deleted image ${target.label}, with its revisions and builds.`)
}

export async function imageDefault(project: string, name: string | undefined): Promise<void> {
  const p = await resolveProject(project)
  const images = await imagesOf(p.id)
  if (name === undefined) {
    console.log(`${p.name}'s default image is ${images.find((i) => i.isDefault)?.name ?? 'yaac'}: a create naming no image launches it.`)
    return
  }
  const image = findImage(images, name, p.name)
  await api.image.project[':projectId'].default.$put({ param: { projectId: p.id }, json: { imageId: image.id } })
  console.log(`${p.name}'s default image is now ${image.name}.`)
}

export async function imageRevisions(target: ImageTarget): Promise<void> {
  const [revisions, names, zone] = await Promise.all([revisionsOf(target.image.id), userNames(), timeZone()])
  printTable(
    [{ header: 'REV' }, { header: 'BUILD' }, { header: 'AUTHOR' }, { header: `SAVED (${zone})` }, { header: 'NOTE' }],
    revisions.map((r) => [
      r.id === target.image.currentRevision?.id ? `${r.number} (current)` : String(r.number),
      r.buildStatus ?? '-',
      names(r.author),
      formatInZone(new Date(r.createdAt), zone),
      [r.note, r.missingFiles.length > 0 ? `files no longer kept: ${r.missingFiles.join(', ')}` : undefined]
        .filter((s) => s !== undefined).join('; '),
    ]),
  )
}

/** Save an old revision's content as a new one; files whose bytes are
 *  gone are left out, and named. */
export async function imageRestore(target: ImageTarget, number: string): Promise<void> {
  const imageId = target.image.id
  const revisions = await revisionsOf(imageId)
  const old = revisionNumbered(revisions, number, target.label)
  const restored = await api.image[':imageId'].revisions[':revisionId'].restore.$post({ param: { imageId, revisionId: old.id } })
  if (restored.droppedFiles.length > 0) {
    console.log(`Revision ${old.number}'s support files ${restored.droppedFiles.join(', ')} are no longer kept, so the restore leaves them out.`)
  }
  reportSave(target.label, restored)
}

/**
 * Build an image now: its current revision or another (`revision`), on top
 * of `project`'s default image for a user image. With `wait`, follow each
 * build of the chain it queued, exiting non-zero on the first that fails.
 */
export async function imageBuild(
  target: ImageTarget,
  opts: { cache?: boolean; revision?: string; wait?: boolean; project?: string },
): Promise<void> {
  const imageId = target.image.id
  const revisionId = opts.revision !== undefined ? revisionNumbered(await revisionsOf(imageId), opts.revision, target.label).id : undefined
  const projectId = opts.project !== undefined ? await resolveProjectId(opts.project) : undefined
  const builds = await api.image[':imageId'].builds.$post({ param: { imageId }, json: {
    revisionId, projectId, ...(opts.cache === false ? { noCache: true } : {}),
  } })
  if (builds.length === 0) {
    console.log(`${target.label} is already built; --no-cache builds it again.`)
    return
  }
  if (opts.wait !== true) {
    reportBuilds(builds)
    return
  }
  for (const b of builds) {
    if (!await printLog(b.id, true)) return
  }
}

/** A project's builds, or one of its images', newest first. */
export async function imageBuilds(project: string, name: string | undefined): Promise<void> {
  await printBuilds(name !== undefined ? { imageId: (await projectImage(project, name)).image.id } : { projectId: (await resolveProject(project)).id })
}

/** The builds of the caller's Dockerfile.user, or only those on one project. */
export async function imageUserBuilds(project: string | undefined): Promise<void> {
  const { image } = await userImage()
  await printBuilds({ imageId: image.id, ...(project !== undefined ? { projectId: await resolveProjectId(project) } : {}) })
}

async function printBuilds(filter: { projectId?: string; imageId?: string }): Promise<void> {
  const [builds, zone] = await Promise.all([api.image.builds.$get({ query: filter }), timeZone()])
  if (builds.length === 0) {
    console.log('No builds yet.')
    return
  }
  printTable(
    [{ header: 'BUILD' }, { header: 'IMAGE' }, { header: 'REV' }, { header: 'LAYER' }, { header: 'REASON' },
      { header: 'STATUS' }, { header: `QUEUED (${zone})` }, { header: 'TOOK' }, { header: 'ERROR' }],
    builds.map((b) => [
      b.id, b.imageName, String(b.revisionNumber), b.layer, b.reason + (b.noCache ? ' (no cache)' : ''),
      b.stepCurrent !== undefined ? `${b.status} ${b.stepCurrent}/${b.totalSteps}` : b.status,
      formatInZone(new Date(b.queuedAt), zone), took(b), b.error ?? '',
    ]),
  )
}

export async function imageLogs(buildId: string, opts: { follow?: boolean }): Promise<void> {
  await printLog(buildId, opts.follow === true)
}

/**
 * Print a build's log from the start; with `follow`, until it ends, then
 * its outcome. Returns false, with a non-zero exit code, for a followed
 * build that did not succeed.
 */
async function printLog(buildId: string, follow: boolean): Promise<boolean> {
  for (let offset = 0; ;) {
    const chunk = await api.image.builds[':buildId'].log.$get({ param: { buildId }, query: { offset: String(offset) } })
    process.stdout.write(chunk.text)
    offset = chunk.offset
    if (chunk.done || !follow) break
    await sleep(LOG_POLL_MS)
  }
  if (!follow) return true
  const build = await api.image.builds[':buildId'].$get({ param: { buildId } })
  if (build.status === 'succeeded') {
    console.log(`Build ${buildId} succeeded.`)
    return true
  }
  console.error(`Build ${buildId} ${build.status}${build.error !== undefined ? `: ${build.error}` : ''}.`)
  if (build.blockedHosts.length > 0) {
    console.error(`The project's egress allowlist refused ${build.blockedHosts.join(', ')}; allow them with \`yaac config egress-allowlist\`.`)
  }
  process.exitCode = 1
  return false
}

/** Say whether a save made a revision, and the builds it started. */
function reportSave(label: string, { revision, changed, builds }: { revision: { number: number }; changed: boolean; builds: ImageBuild[] }): void {
  if (!changed) {
    console.log(`${label} already has that content, at revision ${revision.number}; nothing was saved.`)
    return
  }
  console.log(`Saved ${label} as revision ${revision.number}${builds.length === 0 ? ', which is already built.' : '.'}`)
  if (builds.length > 0) reportBuilds(builds)
}

/** Name each queued build, and how to follow the last, the image's own. */
function reportBuilds(builds: ImageBuild[]): void {
  for (const b of builds) console.log(`Build ${b.id}: the ${b.layer} layer at revision ${b.revisionNumber}, ${b.status}.`)
  console.log(`Follow it with \`yaac image logs ${builds[builds.length - 1].id} --follow\`.`)
}

async function revisionsOf(imageId: string): Promise<ImageRevision[]> {
  return api.image[':imageId'].revisions.$get({ param: { imageId } })
}

function revisionNumbered(revisions: ImageRevision[], number: string, label: string): ImageRevision {
  const found = /^\d+$/.test(number) ? revisions.find((r) => r.number === Number(number)) : undefined
  if (found === undefined) throw new Error(`${label} has no revision ${number}; its revisions are 1 to ${revisions[0]?.number ?? 0}.`)
  return found
}

async function currentFiles(imageId: string): Promise<ImageFileManifest> {
  return (await api.image[':imageId'].$get({ param: { imageId } })).revision?.files ?? {}
}

/** A save's content: the Dockerfile, and the `--context` dir's files, each
 *  stored with `upload`, else the `kept` ones. */
async function contentOf(
  opts: ImageContentOptions,
  upload: (contentBase64: string) => Promise<{ sha256: string; size: number }>,
  kept: () => Promise<ImageFileManifest>,
): Promise<{ dockerfile: string; files: ImageFileManifest; note?: string }> {
  const dockerfile = await readDockerfile(opts.file)
  if (opts.context === undefined) return { dockerfile, files: await kept(), note: opts.note }
  const files: ImageFileManifest = {}
  for (const rel of await contextFiles(opts.context, opts.file)) {
    files[rel] = await upload((await fs.readFile(path.join(opts.context, rel))).toString('base64'))
  }
  return { dockerfile, files, note: opts.note }
}

async function readDockerfile(file: string): Promise<string> {
  try {
    return file === '-' ? await text(process.stdin) : await fs.readFile(file, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * A context dir's files, by context-relative path, less the Dockerfile
 * itself and what its .containerignore lists. Only literal paths may be
 * ignored, as in the server's own build contexts.
 */
export async function contextFiles(dir: string, dockerfile: string): Promise<string[]> {
  const ignore = new Set<string>()
  const ignoreFile = await fs.readFile(path.join(dir, '.containerignore'), 'utf8').catch(() => '')
  for (const line of ignoreFile.split('\n').map((l) => l.trim())) {
    if (line === '' || line.startsWith('#')) continue
    if (/[*?[\]!]/.test(line) || line.startsWith('/')) {
      throw new Error(`${path.join(dir, '.containerignore')} may list only literal paths, not ${JSON.stringify(line)}.`)
    }
    ignore.add(line.replace(/\/+$/, ''))
  }
  const own = dockerfile === '-' ? undefined : path.relative(dir, dockerfile).split(path.sep).join('/')
  const walk = async (rel: string): Promise<string[]> => {
    const out: string[] = []
    for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (ignore.has(child) || child === own) continue
      if (entry.isDirectory()) out.push(...await walk(child))
      else if (entry.isFile()) out.push(child)
    }
    return out
  }
  try {
    return await walk('')
  } catch (err) {
    throw new Error(`Cannot read the context ${dir}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Users by id, as a login or name, for the authors of revisions. */
async function userNames(): Promise<(id: string) => string> {
  const { users } = await api.whoami.$get()
  return (id) => {
    const user = users.find((u) => u.id === id)
    return user?.login ?? user?.name ?? id
  }
}

async function timeZone(): Promise<string> {
  return (await api.config['time-zone'].$get()).timeZone ?? 'UTC'
}

/** How long a build ran, or has run so far. */
function took(build: ImageBuild): string {
  if (build.startedAt === undefined) return '-'
  const end = build.finishedAt !== undefined ? Date.parse(build.finishedAt) : Date.now()
  const seconds = Math.round((end - Date.parse(build.startedAt)) / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}
