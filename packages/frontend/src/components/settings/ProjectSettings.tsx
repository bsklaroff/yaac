import { useMemo, type JSX } from 'react'
import { FileEditor } from '#components/settings/FileEditor'
import { BuildFiles } from '#components/settings/BuildFiles'
import { ProjectEnv } from '#components/settings/ProjectEnv'
import { ProjectRunSecrets } from '#components/settings/ProjectRunSecrets'
import { EgressAllowlist } from '#components/settings/EgressAllowlist'
import { ScratchDirs } from '#components/settings/ScratchDirs'
import { PortForwards } from '#components/settings/PortForwards'
import { CacheVolumes } from '#components/settings/CacheVolumes'
import { ContainerOptions } from '#components/settings/ContainerOptions'
import { ProjectIcon } from '#components/settings/ProjectIcon'
import { ProjectRepos } from '#components/settings/ProjectRepos'
import { WorkspaceAutoDelete } from '#components/settings/WorkspaceAutoDelete'
import { KeptIgnoredPaths } from '#components/settings/KeptIgnoredPaths'
import { Volumes } from '#components/settings/Volumes'
import { Sites } from '#components/settings/Sites'
import { Workflows } from '#components/settings/Workflows'
import { ProjectSelect, useSettingsProject } from '#components/settings/ProjectPicker'
import { api } from '#lib/api'
import { WarningIcon } from '#lib/icons'
import { projectBuildFilesApi } from '#lib/buildFilesApi'
import { useSnapshot } from '#lib/useSnapshot'
import { useHasVolumes } from '#lib/volumes'
import { useTeammateView } from '#lib/viewer'

const project = api.project[':projectId']

/**
 * Settings section for a project's settings and its `Dockerfile.yaac`, for
 * the project `useSettingsProject` picks; a teammate's show read-only.
 */
export function ProjectSettings(): JSX.Element {
  const readOnly = useTeammateView()
  const { projects, selected, pick } = useSettingsProject()
  const projectId = selected?.id ?? null

  const filesApi = useMemo(() => (projectId ? projectBuildFilesApi(projectId) : null), [projectId])

  // A containerless server builds no images and runs no pods, so the
  // Dockerfile editors and the pod-only settings are hidden.
  const buildsImages = useSnapshot()?.driver !== 'containerless'
  // Only with an egress proxy can a secret's value stay out of the
  // workspace, or an allowlist apply.
  const mediatedEgress = useSnapshot()?.driver !== 'containerless'
  // Volumes and sites are both cluster-only.
  const hasVolumes = useHasVolumes()

  return (
    <section>
      <h2 className="text-sm font-semibold">Project Config</h2>

      {!selected || !projectId ? (
        <p className="mt-6 text-xs text-text-faint">No projects yet. Add one from the rail first.</p>
      ) : (
        <>
          <div className="mt-6">
            <div className="text-xs font-medium text-text">Project</div>
            <ProjectSelect projects={projects} value={projectId} onChange={pick} className="mt-2 w-full" />
          </div>

          <div className="mt-6">
            <ProjectIcon key={`icon:${projectId}`} project={selected} readOnly={readOnly} />
          </div>

          <div className="mt-6">
            <ProjectRepos key={`repos:${projectId}`} project={selected} readOnly={readOnly} />
          </div>

          {!mediatedEgress && (
            <div role="note" className="mt-6 flex gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-text-dim">
              <WarningIcon size={14} className="mt-0.5 shrink-0 text-warning" />
              <div>
                <div className="font-medium text-warning">This server runs workspaces directly on the host</div>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  <li>Secrets are placed unencrypted in each workspace&apos;s environment, where agents can read them.</li>
                  <li>Internet access is not restricted: workspaces can reach any URL.</li>
                </ul>
              </div>
            </div>
          )}

          <div className="mt-6">
            <ProjectEnv
              key={`env:${projectId}`}
              projectId={projectId}
              mediatedEgress={mediatedEgress}
              readOnly={readOnly}
            />
          </div>

          <div className="mt-6">
            <ProjectRunSecrets key={`run-secrets:${projectId}`} projectId={projectId} readOnly={readOnly} />
          </div>

          <div className="mt-6">
            <Workflows key={`workflows:${projectId}`} projectId={projectId} repos={selected.repos} readOnly={readOnly} />
          </div>

          {mediatedEgress && <div className="mt-6">
            <EgressAllowlist key={`allowlist:${projectId}`} projectId={projectId} readOnly={readOnly} />
          </div>}

          <div className="mt-6">
            <PortForwards
              key={`ports:${projectId}`}
              projectId={projectId}
              ports={selected.portForwards}
              readOnly={readOnly}
            />
          </div>

          <div className="mt-6">
            <ScratchDirs
              key={`scratch:${projectId}`}
              projectId={projectId}
              settings={selected.scratchDirs}
              readOnly={readOnly}
            />
          </div>

          {buildsImages && <div className="mt-6">
            <CacheVolumes
              key={`cache-volumes:${projectId}`}
              projectId={projectId}
              volumes={selected.cacheVolumes}
              readOnly={readOnly}
            />
          </div>}

          {buildsImages && <div className="mt-6">
            <ContainerOptions
              key={`containers:${projectId}`}
              projectId={projectId}
              npmCache={selected.npmCache}
              readOnly={readOnly}
            />
          </div>}

          {hasVolumes && <div className="mt-6">
            <Volumes key={`volumes:${projectId}`} projectId={projectId} readOnly={readOnly} />
          </div>}

          {hasVolumes && <div className="mt-6">
            <Sites key={`sites:${projectId}`} project={selected} readOnly={readOnly} />
          </div>}

          <div className="mt-6">
            <WorkspaceAutoDelete
              key={`auto-delete:${projectId}`}
              projectId={projectId}
              name={selected.name}
              days={selected.stoppedWorkspaceRetentionDays}
              readOnly={readOnly}
            />
          </div>

          <div className="mt-6">
            <KeptIgnoredPaths
              key={`kept-ignored:${projectId}`}
              projectId={projectId}
              paths={selected.keptIgnoredPaths ?? []}
              readOnly={readOnly}
            />
          </div>

          <div className="mt-6">
            <Workflows key={`init-workflows:${projectId}`} projectId={projectId} repos={selected.repos} readOnly={readOnly} init />
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
                key={`dockerfile:${projectId}`}
                title={`${selected.name} · Dockerfile`}
                language="dockerfile"
                queryKey={['project-dockerfile', projectId]}
                load={async () => (await project.dockerfile.$get({ param: { projectId } })).content}
                {...(readOnly ? {} : {
                  save: async (content: string) => {
                    await project.dockerfile.$put({ param: { projectId }, json: { content } })
                  },
                })}
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
              {filesApi && <BuildFiles key={`files:${projectId}`} filesApi={filesApi} title={selected.name} readOnly={readOnly} />}
            </div>
          </div></>}
        </>
      )}
    </section>
  )
}
