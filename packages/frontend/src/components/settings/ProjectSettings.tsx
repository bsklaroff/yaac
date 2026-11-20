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
import { RemoveProject } from '#components/settings/RemoveProject'
import { WorkspaceAutoDelete } from '#components/settings/WorkspaceAutoDelete'
import { KeptIgnoredPaths } from '#components/settings/KeptIgnoredPaths'
import { Volumes } from '#components/settings/Volumes'
import { useSettingsProject } from '#components/settings/ProjectPicker'
import { SettingsPageTitle } from '#components/settings/SettingsPage'
import { api } from '#lib/api'
import { projectBuildFilesApi } from '#lib/buildFilesApi'
import type { ProjectPage } from '#lib/store'
import { useSnapshotSelect } from '#lib/useSnapshot'
import { useHasVolumes } from '#lib/volumes'
import { useTeammateView } from '#lib/viewer'
import { YCallout, YSettingGroup, YSettingRow } from '#ui'

const project = api.project[':projectId']

export const PROJECT_PAGE_LABEL: Record<ProjectPage, string> = {
  general: 'General',
  env: 'Environment',
  network: 'Network',
  storage: 'Storage',
  image: 'Image',
}

/**
 * One page of the project settings, for the project the settings nav picks
 * (`useSettingsProject`); a teammate's show read-only. A containerless
 * server builds no images and runs no pods, so the Image page and the
 * pod-only settings are not offered there.
 */
export function ProjectSettings({ page }: { page: ProjectPage }): JSX.Element {
  const readOnly = useTeammateView()
  const { selected } = useSettingsProject()
  const projectId = selected?.id ?? null
  const filesApi = useMemo(() => (projectId ? projectBuildFilesApi(projectId) : null), [projectId])
  const buildsImages = useSnapshotSelect((s) => s?.driver) !== 'containerless'
  // Only with an egress proxy can a secret's value stay out of the
  // workspace, or an allowlist apply.
  const mediatedEgress = buildsImages
  const hasVolumes = useHasVolumes()

  if (!selected || !projectId) {
    return <p className="text-md text-subtle">No projects yet. Add one from the rail first.</p>
  }

  return (
    <>
      <SettingsPageTitle title={PROJECT_PAGE_LABEL[page]} />

      {page === 'general' && <YSettingGroup>
        <ProjectIcon key={`icon:${projectId}`} project={selected} readOnly={readOnly} />
        <ProjectRepos key={`repos:${projectId}`} project={selected} readOnly={readOnly} />
        <WorkspaceAutoDelete
          key={`auto-delete:${projectId}`}
          projectId={projectId}
          name={selected.name}
          days={selected.stoppedWorkspaceRetentionDays}
          readOnly={readOnly}
        />
        {!readOnly && <RemoveProject key={`remove:${projectId}`} project={selected} />}
      </YSettingGroup>}

      {page === 'env' && <>
        {!mediatedEgress && (
          <YCallout title="This server runs workspaces directly on the host">
            <ul className="list-disc space-y-0.5 pl-4">
              <li>Secrets are placed unencrypted in each workspace&apos;s environment, where agents can read them.</li>
              <li>Internet access is not restricted: workspaces can reach any URL.</li>
            </ul>
          </YCallout>
        )}
        <YSettingGroup>
          <ProjectEnv key={`env:${projectId}`} projectId={projectId} mediatedEgress={mediatedEgress} readOnly={readOnly} />
          <ProjectRunSecrets key={`run-secrets:${projectId}`} projectId={projectId} readOnly={readOnly} />
        </YSettingGroup>
      </>}

      {page === 'network' && <YSettingGroup>
        {mediatedEgress && <EgressAllowlist key={`allowlist:${projectId}`} projectId={projectId} readOnly={readOnly} />}
        <PortForwards key={`ports:${projectId}`} projectId={projectId} ports={selected.portForwards} readOnly={readOnly} />
      </YSettingGroup>}

      {page === 'storage' && <YSettingGroup>
        <ScratchDirs key={`scratch:${projectId}`} projectId={projectId} settings={selected.scratchDirs} readOnly={readOnly} />
        {buildsImages && (
          <CacheVolumes key={`cache-volumes:${projectId}`} projectId={projectId} volumes={selected.cacheVolumes} readOnly={readOnly} />
        )}
        {hasVolumes && <Volumes key={`volumes:${projectId}`} projectId={projectId} readOnly={readOnly} />}
        <KeptIgnoredPaths
          key={`kept-ignored:${projectId}`}
          projectId={projectId}
          paths={selected.keptIgnoredPaths ?? []}
          readOnly={readOnly}
        />
      </YSettingGroup>}

      {page === 'image' && buildsImages && <YSettingGroup>
        <YSettingRow
          stacked
          label="Dockerfile"
          hint={<>
            Overrides the base image for this project. Use{' '}
            <code className="text-muted">{'ARG BASE_IMAGE'}</code> and{' '}
            <code className="text-muted">{'FROM ${BASE_IMAGE}'}</code> to layer on the default
            image, or any other <code className="text-muted">FROM</code> for a standalone image.
          </>}
        >
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
        </YSettingRow>
        <YSettingRow
          stacked
          label="Build files"
          hint={<>
            Files stored next to the Dockerfile as its build context — reference them
            with <code className="text-muted">COPY</code>. Changes apply on the next
            workspace create.
          </>}
        >
          {filesApi && <BuildFiles key={`files:${projectId}`} filesApi={filesApi} title={selected.name} readOnly={readOnly} />}
        </YSettingRow>
        <ContainerOptions key={`containers:${projectId}`} projectId={projectId} npmCache={selected.npmCache} readOnly={readOnly} />
      </YSettingGroup>}
    </>
  )
}
