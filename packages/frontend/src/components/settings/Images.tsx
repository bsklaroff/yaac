import { useEffect, useState, type FormEvent, type JSX, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BuildStatusBadge } from '#components/BuildPage'
import { DiffView } from '#components/DiffView'
import { ContainerOptions } from '#components/settings/ContainerOptions'
import { FileEditor } from '#components/settings/FileEditor'
import { ImageEditor, type ImageContent } from '#components/settings/ImageEditor'
import { useSettingsProject } from '#components/settings/ProjectPicker'
import { SettingsPageTitle } from '#components/settings/SettingsPage'
import { api } from '#lib/api'
import { diffTextPair } from '#lib/diff'
import { NavBackIcon } from '#lib/icons'
import { buildDuration, IMAGE_KEY, imageStateLabel, useFollowBuilds } from '#lib/images'
import { useUiStore } from '#lib/store'
import { relativeAge } from '#lib/time'
import {
  DEFAULT_IMAGE_CACHE_DAYS,
  STOCK_IMAGE_ID, type ImageFileManifest, type ImageRevision, type ImageSummary, type ProjectSummary,
} from '@yaac/shared/types'
import { YBadge, YButton, YConfirm, YInput, YSettingGroup, YSettingRow, YTabs, type YBadgeTone } from '#ui'

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/

/** What a new image's Dockerfile starts as: the stock image, to layer on. */
const LAYERED_TEMPLATE = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'

const STATE_TONE: Record<ImageSummary['state'], YBadgeTone> = {
  'ready': 'success', 'building': 'info', 'never-built': 'neutral', 'failed': 'danger',
}

const LAYERED_HINT = <>
  Use <code className="text-muted">ARG BASE_IMAGE</code> and{' '}
  <code className="text-muted">{'FROM ${BASE_IMAGE}'}</code> to layer on the stock image, or any
  other <code className="text-muted">FROM</code> for a standalone image. Saving builds it.
</>

type Tab = 'dockerfile' | 'revisions' | 'builds'
const TABS: { value: Tab; label: string }[] = [
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'revisions', label: 'Revisions' },
  { value: 'builds', label: 'Builds' },
]

/**
 * The project's Images page (docs/image-builds.md "Images, revisions and builds"): its images,
 * the stock one first and read-only, a form for a new one, the project's
 * build cache age and its npm cache setting. Opening an image shows its
 * Dockerfile, Revisions and Builds tabs.
 */
export function ProjectImages({ project, readOnly }: { project: ProjectSummary; readOnly: boolean }): JSX.Element {
  useFollowBuilds()
  const projectId = project.id
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const list = useQuery({
    queryKey: [IMAGE_KEY, 'list', projectId],
    queryFn: () => api.image.project[':projectId'].$get({ param: { projectId } }),
    staleTime: 0,
  })
  const open = list.data?.find((i) => i.id === openId)

  if (creating) {
    return <NewImage projectId={projectId} onDone={(id) => { setCreating(false); setOpenId(id) }} />
  }
  if (open !== undefined) {
    return (
      <ImageView
        image={open}
        projectId={projectId}
        readOnly={readOnly}
        onBack={() => setOpenId(null)}
      />
    )
  }
  return (
    <>
      <YSettingGroup>
        {list.data === undefined && (
          <p className="px-4 py-3 text-md text-subtle">{list.error?.message ?? 'Loading…'}</p>
        )}
        {list.data?.map((image) => (
          <YButton
            key={image.id}
            variant="bare"
            onClick={() => setOpenId(image.id)}
            aria-label={`Open image ${image.name}`}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-md hover:bg-hover"
          >
            <span className="min-w-0 flex-1 truncate font-medium text-text">{image.name}</span>
            {image.id === STOCK_IMAGE_ID && <span className="text-sm text-subtle">stock</span>}
            {image.isDefault && <YBadge tone="accent">default</YBadge>}
            {image.id !== STOCK_IMAGE_ID && <YBadge tone={STATE_TONE[image.state]}>{imageStateLabel(image)}</YBadge>}
          </YButton>
        ))}
      </YSettingGroup>
      {!readOnly && <YButton onClick={() => setCreating(true)} className="self-start">New image</YButton>}
      <YSettingGroup>
        <CacheDays projectId={projectId} days={project.imageCacheDays} readOnly={readOnly} />
        <ContainerOptions projectId={projectId} npmCache={project.npmCache} readOnly={readOnly} />
      </YSettingGroup>
    </>
  )
}

/** A new image: its name and the Dockerfile it starts from. */
function NewImage({ projectId, onDone }: { projectId: string; onDone: (id: string | null) => void }): JSX.Element {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [dockerfile, setDockerfile] = useState(LAYERED_TEMPLATE)
  const create = useMutation({
    mutationFn: () => api.image.project[':projectId'].$post({ param: { projectId }, json: { name, dockerfile, files: {} } }),
    onSuccess: async (image) => {
      await queryClient.invalidateQueries({ queryKey: [IMAGE_KEY] })
      onDone(image.id)
    },
  })
  const invalid = name === '' ? 'Name it'
    : name === 'yaac' ? '“yaac” is the stock image'
    : !NAME_RE.test(name) ? 'Lowercase letters, digits, “.”, “_” and “-”, starting with a letter or digit'
    : null
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    if (invalid === null) create.mutate()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <BackButton label="Back to images" onClick={() => onDone(null)} />
      <YSettingGroup>
        <YSettingRow label="Name" hint={name !== '' && invalid}>
          <YInput aria-label="Image name" value={name} onChange={(e) => setName(e.target.value.trim())} className="w-64 font-mono" />
        </YSettingRow>
        <YSettingRow stacked label="Dockerfile" hint={LAYERED_HINT}>
          <FileEditor title="New image · Dockerfile" language="dockerfile" value={dockerfile} onChange={setDockerfile} />
        </YSettingRow>
      </YSettingGroup>
      {create.error && <p className="whitespace-pre-wrap text-md text-danger">{create.error.message}</p>}
      <YButton type="submit" variant="primary" disabled={invalid !== null || create.isPending} className="self-start">
        {create.isPending ? 'Creating…' : 'Create image'}
      </YButton>
    </form>
  )
}

/** One of the project's images: its tabs, and making it the default or
 *  deleting it. The stock image has only the default action. */
function ImageView({ image, projectId, readOnly, onBack }: {
  image: ImageSummary
  projectId: string
  readOnly: boolean
  onBack: () => void
}): JSX.Element {
  const queryClient = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const act = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [IMAGE_KEY] }),
  })
  const stock = image.id === STOCK_IMAGE_ID
  const makeDefault = (): void => act.mutate(() =>
    api.image.project[':projectId'].default.$put({ param: { projectId }, json: { imageId: image.id } }))
  const remove = (): void => act.mutate(async () => {
    await api.image[':imageId'].$delete({ param: { imageId: image.id } })
    setConfirmDelete(false)
    onBack()
  })

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <BackButton label="Back to images" onClick={onBack} />
        <h3 className="mr-auto text-base font-semibold">{image.name}</h3>
        {image.isDefault ? <YBadge tone="accent">project default</YBadge> : !readOnly && (
          <YButton size="sm" onClick={makeDefault} disabled={act.isPending}>Set as project default</YButton>
        )}
        {!stock && !readOnly && (
          <YButton size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>Delete image</YButton>
        )}
      </div>
      {act.error && !confirmDelete && <p className="text-md text-danger">{act.error.message}</p>}
      {stock ? (
        <p className="text-md text-muted">
          The image yaac ships, with every agent and its tools installed. It is read-only: make a new image
          to add to it.
        </p>
      ) : (
        <ImageTabs
          imageId={image.id}
          buildFor={projectId}
          readOnly={readOnly}
          hint={LAYERED_HINT}
          save={(content) => api.image[':imageId'].$put({ param: { imageId: image.id }, json: content })}
        />
      )}
      <YConfirm
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${image.name}?`}
        description="Its revisions and build history go with it. Running workspaces keep their image."
        busy={act.isPending}
        {...(act.error ? { error: act.error.message } : {})}
        onConfirm={remove}
      />
    </>
  )
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return <YButton variant="ghost" size="sm" icon={NavBackIcon} onClick={onClick} aria-label={label} title={label} />
}

/**
 * An image's Dockerfile, Revisions and Builds tabs. `buildFor` is the
 * project a manual build is for, which a user image needs to say.
 */
function ImageTabs({ imageId, buildFor, readOnly, hint, save }: {
  imageId: string
  buildFor: string | undefined
  readOnly: boolean
  hint: ReactNode
  save: (content: ImageContent) => Promise<{ revision: ImageRevision; changed: boolean }>
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('dockerfile')
  const detail = useQuery({
    queryKey: [IMAGE_KEY, 'detail', imageId],
    queryFn: () => api.image[':imageId'].$get({ param: { imageId } }),
    staleTime: 0,
  })
  return (
    <>
      <YTabs tabs={TABS} value={tab} onChange={setTab} ariaLabel="Image" />
      {detail.data === undefined ? (
        <p className="text-md text-subtle">{detail.error?.message ?? 'Loading…'}</p>
      ) : tab === 'dockerfile' ? (
        <ImageEditor
          key={detail.data.revision?.id ?? ''}
          image={detail.data.image}
          revision={detail.data.revision}
          title={detail.data.image.name}
          hint={hint}
          save={save}
          readOnly={readOnly}
        />
      ) : tab === 'revisions' ? (
        <Revisions image={detail.data.image} readOnly={readOnly} />
      ) : (
        <Builds imageId={imageId} buildFor={buildFor} readOnly={readOnly} />
      )}
    </>
  )
}

/** Which support files differ between two revisions, as diff markers. */
function fileChanges(from: ImageFileManifest, to: ImageFileManifest): string[] {
  const paths = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()
  return paths.flatMap((p) => (from[p] === undefined ? [`+ ${p}`]
    : to[p] === undefined ? [`− ${p}`]
    : from[p].sha256 !== to[p].sha256 ? [`~ ${p}`]
    : []))
}

/** An image's revisions, newest first: each viewed, diffed against the one
 *  before it or the current one, or restored as a new revision. */
function Revisions({ image, readOnly }: { image: ImageSummary; readOnly: boolean }): JSX.Element {
  const queryClient = useQueryClient()
  const revisions = useQuery({
    queryKey: [IMAGE_KEY, 'revisions', image.id],
    queryFn: () => api.image[':imageId'].revisions.$get({ param: { imageId: image.id } }),
    staleTime: 0,
  })
  const [shown, setShown] = useState<{ id: string; against?: 'previous' | 'current' } | null>(null)
  const restore = useMutation({
    mutationFn: (revisionId: string) => api.image[':imageId'].revisions[':revisionId'].restore.$post({
      param: { imageId: image.id, revisionId },
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [IMAGE_KEY] }),
  })

  if (revisions.data === undefined) return <p className="text-md text-subtle">{revisions.error?.message ?? 'Loading…'}</p>
  const list = revisions.data
  const currentId = image.currentRevision?.id
  const current = list.find((r) => r.id === currentId)
  const toggle = (id: string, against?: 'previous' | 'current'): void =>
    setShown(shown?.id === id && shown.against === against ? null : { id, ...(against ? { against } : {}) })

  return (
    <div className="flex flex-col gap-2">
      {restore.data && (
        <div className="text-md">
          <p className="text-success">Restored as revision {restore.data.revision.number}.</p>
          {restore.data.droppedFiles.length > 0 && (
            <p className="text-warning">
              These files are no longer kept and were left out: {restore.data.droppedFiles.join(', ')}
            </p>
          )}
        </div>
      )}
      {restore.error && <p className="text-md text-danger">{restore.error.message}</p>}
      <YSettingGroup>
        {list.map((rev, i) => {
          const previous = list[i + 1]
          const isCurrent = rev.id === currentId
          const open = shown?.id === rev.id ? shown : null
          // Older on the left: the previous revision before this one, this
          // one before the current.
          const pair = open?.against === 'previous' && previous ? [previous, rev]
            : open?.against === 'current' && current ? [rev, current]
            : undefined
          return (
            <div key={rev.id} className="flex flex-col gap-2 px-4 py-2.5 text-md">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">#{rev.number}</span>
                {isCurrent && <YBadge tone="accent">current</YBadge>}
                {rev.buildStatus && <BuildStatusBadge status={rev.buildStatus} />}
                <span className="text-muted">{rev.author}</span>
                <span className="text-subtle">{relativeAge(rev.createdAt)}</span>
                <span className="ml-auto flex gap-1">
                  <YButton size="sm" variant="ghost" onClick={() => toggle(rev.id)} aria-pressed={open !== null && !open.against}>
                    View
                  </YButton>
                  {previous && (
                    <YButton size="sm" variant="ghost" onClick={() => toggle(rev.id, 'previous')} aria-pressed={open?.against === 'previous'}>
                      Diff previous
                    </YButton>
                  )}
                  {!isCurrent && current && (
                    <YButton size="sm" variant="ghost" onClick={() => toggle(rev.id, 'current')} aria-pressed={open?.against === 'current'}>
                      Diff current
                    </YButton>
                  )}
                  {!isCurrent && !readOnly && (
                    <YButton size="sm" onClick={() => restore.mutate(rev.id)} disabled={restore.isPending}>Restore</YButton>
                  )}
                </span>
              </div>
              {rev.note && <p className="text-muted">{rev.note}</p>}
              {open !== null && !open.against && (
                <>
                  <FileEditor title={`${image.name} · revision ${rev.number}`} language="dockerfile" value={rev.dockerfile} />
                  {Object.keys(rev.files).length > 0 && (
                    <p className="font-mono text-sm text-muted">{Object.keys(rev.files).sort().join('  ')}</p>
                  )}
                </>
              )}
              {pair !== undefined && (
                <div className="overflow-hidden rounded-sm bg-sunken/80 py-1" aria-label={`Diff of revision ${pair[0].number} to ${pair[1].number}`}>
                  <DiffView lines={diffTextPair(pair[0].dockerfile, pair[1].dockerfile)} language="dockerfile" />
                  {fileChanges(pair[0].files, pair[1].files).map((c) => (
                    <p key={c} className="px-2 font-mono text-sm text-muted">{c}</p>
                  ))}
                </div>
              )}
              {rev.missingFiles.length > 0 && (
                <p className="text-sm text-subtle">No longer kept: {rev.missingFiles.join(', ')}</p>
              )}
            </div>
          )
        })}
      </YSettingGroup>
    </div>
  )
}

/** An image's builds, newest first, each opening its page; and a manual
 *  build, with or without the cache. */
function Builds({ imageId, buildFor, readOnly }: { imageId: string; buildFor: string | undefined; readOnly: boolean }): JSX.Element {
  const queryClient = useQueryClient()
  const openBuild = useUiStore((s) => s.openBuild)
  const builds = useQuery({
    queryKey: [IMAGE_KEY, 'builds', imageId],
    queryFn: () => api.image.builds.$get({ query: { imageId } }),
    staleTime: 0,
  })
  const request = useMutation({
    mutationFn: (noCache: boolean) => api.image[':imageId'].builds.$post({
      param: { imageId },
      json: { ...(noCache ? { noCache } : {}), ...(buildFor !== undefined ? { projectId: buildFor } : {}) },
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [IMAGE_KEY] }),
  })
  return (
    <div className="flex flex-col gap-2">
      {!readOnly && (
        <div className="flex gap-2">
          <YButton onClick={() => request.mutate(false)} disabled={request.isPending || buildFor === undefined}>Build now</YButton>
          <YButton onClick={() => request.mutate(true)} disabled={request.isPending || buildFor === undefined}>
            Rebuild without cache
          </YButton>
        </div>
      )}
      {request.error && <p className="text-md text-danger">{request.error.message}</p>}
      {builds.data === undefined ? (
        <p className="text-md text-subtle">{builds.error?.message ?? 'Loading…'}</p>
      ) : builds.data.length === 0 ? (
        <p className="text-md text-subtle">No builds yet.</p>
      ) : (
        <YSettingGroup>
          {builds.data.map((b) => (
            <YButton
              key={b.id}
              variant="bare"
              onClick={() => openBuild(b.id)}
              aria-label={`Open build of revision ${b.revisionNumber}`}
              className="flex w-full flex-wrap items-center gap-2 px-4 py-2 text-left text-md hover:bg-hover"
            >
              <BuildStatusBadge status={b.status} />
              <span>revision {b.revisionNumber}</span>
              <span className="text-muted">{b.reason}{b.noCache ? ', without cache' : ''}</span>
              <span className="ml-auto text-subtle">{relativeAge(b.queuedAt)}</span>
              {b.finishedAt && <span className="text-subtle">{buildDuration(b)}</span>}
            </YButton>
          ))}
        </YSettingGroup>
      )}
    </div>
  )
}

/** How many days a project's build cache is read before it is rebuilt from
 *  scratch; absent is the server's default. */
function CacheDays({ projectId, days, readOnly }: { projectId: string; days: number | undefined; readOnly: boolean }): JSX.Element {
  const [draft, setDraft] = useState(days?.toString() ?? '')
  useEffect(() => setDraft(days?.toString() ?? ''), [days])
  const save = useMutation({
    mutationFn: (next: number | null) =>
      api.image.project[':projectId']['cache-days'].$put({ param: { projectId }, json: { days: next } }),
  })
  const parsed = /^\d+$/.test(draft.trim()) ? Number(draft.trim()) : NaN
  const valid = parsed >= 1 && parsed <= 365
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    if (valid) save.mutate(parsed)
  }
  return (
    <YSettingRow
      label="Build cache age"
      hint={`Days a build reuses cached steps before building them again. Blank is the default, ${DEFAULT_IMAGE_CACHE_DAYS}.`}
    >
      <form onSubmit={submit} className="flex items-center gap-2">
        <YInput
          value={draft}
          onChange={(e) => { setDraft(e.target.value); save.reset() }}
          inputMode="numeric"
          placeholder={String(DEFAULT_IMAGE_CACHE_DAYS)}
          aria-label="Build cache age in days"
          disabled={readOnly}
          className="w-20 font-mono"
        />
        <span className="text-sm text-muted">days</span>
        {!readOnly && <>
          <YButton type="submit" size="sm" disabled={!valid || parsed === days || save.isPending}>Save</YButton>
          {days !== undefined && (
            <YButton variant="secondary" size="sm" onClick={() => save.mutate(null)} disabled={save.isPending}>Default</YButton>
          )}
        </>}
        {save.isSuccess && <span className="text-sm text-success">Saved</span>}
      </form>
      {save.error && <p className="mt-2 text-md text-danger">{save.error.message}</p>}
    </YSettingRow>
  )
}

/**
 * The user's own Dockerfile.user, layered atop every project image: the
 * same tabs as a project image. It has none until its first save; manual
 * builds are for the project the settings nav picks.
 */
export function UserImagePane(): JSX.Element {
  useFollowBuilds()
  const queryClient = useQueryClient()
  const buildFor = useSettingsProject().selected?.id
  const user = useQuery({
    queryKey: [IMAGE_KEY, 'user'],
    queryFn: () => api.image.user.$get(),
    staleTime: 0,
  })
  const hint = <>
    Layered atop every project image. Must start with <code className="text-muted">ARG BASE_IMAGE</code> and{' '}
    <code className="text-muted">{'FROM ${BASE_IMAGE}'}</code>.
  </>
  const save = async (content: ImageContent): Promise<{ revision: ImageRevision; changed: boolean }> => {
    const saved = await api.image.user.$put({ json: content })
    await queryClient.invalidateQueries({ queryKey: [IMAGE_KEY, 'user'] })
    return saved
  }
  return (
    <>
      <SettingsPageTitle title="User Dockerfile" />
      {user.data === undefined ? (
        <p className="text-md text-subtle">{user.error?.message ?? 'Loading…'}</p>
      ) : user.data.image === null ? (
        <ImageEditor image={null} revision={null} title="Dockerfile.user" template={LAYERED_TEMPLATE} hint={hint} save={save} />
      ) : (
        <ImageTabs imageId={user.data.image.id} buildFor={buildFor} readOnly={false} hint={hint} save={save} />
      )}
    </>
  )
}
