import { useMemo, useState, type JSX } from 'react'
import { remoteKind } from '#components/GitCredentialPicker'
import { FileEditor } from '#components/settings/FileEditor'
import { BuildFiles } from '#components/settings/BuildFiles'
import { ProjectEnv } from '#components/settings/ProjectEnv'
import { api } from '#lib/api'
import { projectBuildFilesApi } from '#lib/buildFilesApi'
import { useSnapshot } from '#lib/useSnapshot'
import { useUiStore } from '#lib/store'

const project = api.project[':slug']

async function loadConfig(slug: string): Promise<string> {
  const { config } = await project.config.$get({ param: { slug } })
  return JSON.stringify(config ?? {}, null, 2) + '\n'
}

async function saveConfig(slug: string, text: string): Promise<void> {
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  await project.config.$put({ param: { slug }, json: { config } })
}

/**
 * Settings section for a project's overlay files: `yaac-config.json` and
 * `Dockerfile.yaac`. A picker chooses the project, defaulting to the active
 * one.
 */
export function ProjectSettings(): JSX.Element {
  const projects = useSnapshot()?.projects ?? []
  const activeProjectSlug = useUiStore((s) => s.activeProjectSlug)
  // The dialog unmounts on close, so this re-defaults to the active project
  // each time settings open.
  const [picked, setPicked] = useState<string | null>(activeProjectSlug)

  // If the pick disappears, fall back to the active project, then the first.
  const slug = picked && projects.some((p) => p.slug === picked)
    ? picked
    : (activeProjectSlug && projects.some((p) => p.slug === activeProjectSlug)
        ? activeProjectSlug
        : (projects[0]?.slug ?? null))
  const remoteUrl = projects.find((p) => p.slug === slug)?.remoteUrl

  const filesApi = useMemo(() => (slug ? projectBuildFilesApi(slug) : null), [slug])

  // A containerless server builds no images, so the Dockerfile editors are
  // hidden.
  const buildsImages = useSnapshot()?.driver !== 'containerless'
  // Only with an egress proxy can a secret's value stay out of the
  // workspace.
  const mediatedEgress = useSnapshot()?.driver !== 'containerless'

  return (
    <section>
      <h2 className="text-sm font-semibold">Project Config</h2>

      {projects.length === 0 || !slug ? (
        <p className="mt-6 text-xs text-text-faint">No projects yet. Add one from the rail first.</p>
      ) : (
        <>
          <div className="mt-6">
            <div className="text-xs font-medium text-text">Project</div>
            <select
              value={slug}
              onChange={(e) => setPicked(e.target.value)}
              className="mt-2 w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text
                outline-none focus:border-border-strong"
            >
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>{p.slug}</option>
              ))}
            </select>
            {remoteUrl !== undefined && (
              <p className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px]">
                <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 font-medium text-text-dim">
                  {remoteKind(remoteUrl).toUpperCase()}
                </span>
                <span title={remoteUrl} className="truncate font-mono text-text-faint">{remoteUrl}</span>
              </p>
            )}
          </div>

          <div className="mt-6">
            <ProjectEnv key={`env:${slug}`} slug={slug} mediatedEgress={mediatedEgress} />
          </div>

          <div className="mt-6">
            <div className="text-xs font-medium text-text">yaac-config.json</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
              This machine&apos;s config overlay for the project.
            </p>
            <div className="mt-2">
              <FileEditor
                key={`config:${slug}`}
                title={`${slug} · yaac-config.json`}
                language="json"
                queryKey={['project-config', slug]}
                load={() => loadConfig(slug)}
                save={(text) => saveConfig(slug, text)}
              />
            </div>
          </div>

          {buildsImages && <><div className="mt-6">
            <div className="text-xs font-medium text-text">Dockerfile</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
              Overrides the base image for this project. Use{' '}
              <code className="text-text-dim">{'ARG BASE_IMAGE'}</code> and{' '}
              <code className="text-text-dim">{'FROM ${BASE_IMAGE}'}</code> to layer on the default
              image, or any other <code className="text-text-dim">FROM</code> for a standalone image.
            </p>
            <div className="mt-2">
              <FileEditor
                key={`dockerfile:${slug}`}
                title={`${slug} · Dockerfile`}
                language="dockerfile"
                queryKey={['project-dockerfile', slug]}
                load={async () => (await project.dockerfile.$get({ param: { slug } })).content}
                save={async (content) => { await project.dockerfile.$put({ param: { slug }, json: { content } }) }}
              />
            </div>
          </div>

          <div className="mt-6">
            <div className="text-xs font-medium text-text">Build files</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
              Files stored next to the Dockerfile as its build context — reference them
              with <code className="text-text-dim">COPY</code>. Changes apply on the next
              workspace create.
            </p>
            <div className="mt-2">
              {filesApi && <BuildFiles key={`files:${slug}`} filesApi={filesApi} title={slug} />}
            </div>
          </div></>}
        </>
      )}
    </section>
  )
}
