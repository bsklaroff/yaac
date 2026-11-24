import { useState, type JSX, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BuildStatusBadge } from '#components/BuildPage'
import { BuildFiles, type EditedFiles } from '#components/settings/BuildFiles'
import { FileEditor } from '#components/settings/FileEditor'
import { api } from '#lib/api'
import { encodeBase64, IMAGE_KEY } from '#lib/images'
import { useUiStore } from '#lib/store'
import type { ImageFileManifest, ImageRevision, ImageSummary } from '@yaac/shared/types'
import { YButton, YInput, YSettingGroup, YSettingRow } from '#ui'

export interface ImageContent {
  dockerfile: string
  files: ImageFileManifest
  note?: string
}

/**
 * An image's Dockerfile tab: its Dockerfile and support files as of the
 * current revision, edited here and saved as one new revision (`save`),
 * which starts a build. Under the editor, the newest build of the current
 * revision, linking to its page, and its check warnings beside the lines
 * they name.
 *
 * `image` is null for a user image not made yet: it opens on `template`,
 * and takes support files once its first save makes it. Callers remount it
 * per revision (`key`), so a save starts the next edit fresh.
 */
export function ImageEditor({ image, revision, title, template = '', hint, save, readOnly = false }: {
  image: ImageSummary | null
  revision: ImageRevision | null
  title: string
  template?: string
  hint: ReactNode
  save: (content: ImageContent) => Promise<{ revision: ImageRevision; changed: boolean }>
  readOnly?: boolean
}): JSX.Element {
  const queryClient = useQueryClient()
  const imageId = image?.id
  const savedDockerfile = revision?.dockerfile ?? template
  const [dockerfile, setDockerfile] = useState(savedDockerfile)
  const [files, setFiles] = useState<EditedFiles>(revision?.files ?? {})
  const [note, setNote] = useState('')
  const dirty = dockerfile !== savedDockerfile || JSON.stringify(files) !== JSON.stringify(revision?.files ?? {})

  const upload = imageId === undefined ? undefined : async (body: { content: string } | { contentBase64: string }) =>
    api.image[':imageId'].files.$post({ param: { imageId }, json: body })

  const saving = useMutation({
    mutationFn: async () => {
      const manifest: ImageFileManifest = {}
      for (const [path, f] of Object.entries(files)) manifest[path] = 'text' in f ? await upload!({ content: f.text }) : f
      return save({ dockerfile, files: manifest, ...(note.trim() !== '' ? { note: note.trim() } : {}) })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [IMAGE_KEY] }),
  })

  const readText = async (path: string, file: { sha256: string }): Promise<string> => {
    if (imageId === undefined || revision === null || revision.files[path]?.sha256 !== file.sha256) {
      throw new Error(`${path} was uploaded since the last save: save to edit it here`)
    }
    const read = await api.image[':imageId'].revisions[':revisionId'].file.$get({
      param: { imageId, revisionId: revision.id }, query: { path },
    })
    if (read.binary) throw new Error(`${path} is a binary file`)
    return read.content
  }

  const footer = !readOnly && (
    <div className="flex flex-wrap items-center gap-2">
      <YInput
        aria-label="Revision note"
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => { setNote(e.target.value); saving.reset() }}
        maxLength={500}
        className="min-w-0 flex-1"
      />
      <YButton variant="primary" onClick={() => saving.mutate()} disabled={saving.isPending || !dirty}>
        {saving.isPending ? 'Saving…' : 'Save'}
      </YButton>
      {saving.data?.changed === false && <span className="text-md text-subtle">No changes</span>}
      {saving.error && <p className="w-full whitespace-pre-wrap text-md text-danger">{saving.error.message}</p>}
    </div>
  )

  return (
    <YSettingGroup>
      <YSettingRow stacked label="Dockerfile" hint={hint}>
        <div className="flex flex-col gap-2">
          <FileEditor
            title={`${title} · Dockerfile`}
            language="dockerfile"
            value={dockerfile}
            {...(readOnly ? {} : { onChange: (text: string) => { setDockerfile(text); saving.reset() } })}
            footer={footer}
          />
          {image?.latestBuildId !== undefined && revision !== null && (
            <LatestBuild buildId={image.latestBuildId} revision={revision} />
          )}
        </div>
      </YSettingRow>
      <YSettingRow
        stacked
        label="Support files"
        hint={<>
          The Dockerfile&apos;s build context: reference them with <code className="text-muted">COPY</code>.
          They are saved with the Dockerfile.
        </>}
      >
        <BuildFiles
          files={files}
          title={title}
          readText={readText}
          {...(readOnly ? {} : { onChange: (next: EditedFiles) => { setFiles(next); saving.reset() } })}
          {...(upload ? { upload: async (data: ArrayBuffer) => upload({ contentBase64: encodeBase64(data) }) } : {})}
        />
      </YSettingRow>
    </YSettingGroup>
  )
}

/** The newest build of the image's current revision, and the check
 *  warnings it found against the lines they name. */
function LatestBuild({ buildId, revision }: { buildId: string; revision: ImageRevision }): JSX.Element | null {
  const openBuild = useUiStore((s) => s.openBuild)
  const { data: build } = useQuery({
    queryKey: [IMAGE_KEY, 'build', buildId],
    queryFn: () => api.image.builds[':buildId'].$get({ param: { buildId } }),
    staleTime: 0,
  })
  if (build === undefined) return null
  const lines = revision.dockerfile.split('\n')
  const current = build.revisionId === revision.id
  return (
    <div className="flex flex-col gap-1 text-md">
      <div className="flex items-center gap-2">
        <span className="text-muted">Build of revision {build.revisionNumber}</span>
        <BuildStatusBadge status={build.status} />
        {build.status === 'running' && build.stepText && (
          <span className="min-w-0 truncate font-mono text-sm text-subtle">{build.stepText}</span>
        )}
        <YButton size="sm" variant="ghost" onClick={() => openBuild(build.id)} className="ml-auto">Open build</YButton>
      </div>
      {current && build.warnings.length > 0 && (
        <ul aria-label="Check warnings" className="flex flex-col gap-1">
          {build.warnings.map((w, i) => (
            <li key={i} className="flex flex-col">
              <span className="text-warning">{w.line !== undefined ? `Line ${w.line}: ` : ''}{w.message}</span>
              {w.line !== undefined && lines[w.line - 1] !== undefined && (
                <code className="truncate text-sm text-subtle">{lines[w.line - 1]}</code>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
