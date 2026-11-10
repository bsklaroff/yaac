import { useMemo, type JSX } from 'react'
import { remoteKind } from '#components/GitCredentialPicker'
import { FileEditor } from '#components/settings/FileEditor'
import { BuildFiles } from '#components/settings/BuildFiles'
import { ProjectEnv } from '#components/settings/ProjectEnv'
import { ProjectRunSecrets } from '#components/settings/ProjectRunSecrets'
import { EgressAllowlist } from '#components/settings/EgressAllowlist'
import { ScratchDirs } from '#components/settings/ScratchDirs'
import { PortForwards } from '#components/settings/PortForwards'
import { CacheVolumes } from '#components/settings/CacheVolumes'
import { ContainerOptions } from '#components/settings/ContainerOptions'
import { HostedRemote } from '#components/settings/HostedRemote'
import { ProjectIcon } from '#components/settings/ProjectIcon'
import { ProjectSharing } from '#components/settings/ProjectSharing'
import { MoveToRemote } from '#components/settings/MoveToRemote'
import { KeptHostedRepo } from '#components/settings/KeptHostedRepo'
import { WorkspaceAutoDelete } from '#components/settings/WorkspaceAutoDelete'
import { KeptIgnoredPaths } from '#components/settings/KeptIgnoredPaths'
import { Volumes } from '#components/settings/Volumes'
import { Sites } from '#components/settings/Sites'
import { Workflows } from '#components/settings/Workflows'
import { ProjectSelect, useSettingsProject } from '#components/settings/ProjectPicker'
import { api } from '#lib/api'
import { WarningIcon } from '#lib/icons'
import { parseSteps } from '#lib/steps'
import { projectBuildFilesApi } from '#lib/buildFilesApi'
import { useSnapshot } from '#lib/useSnapshot'
import { useHasVolumes } from '#lib/volumes'
import { useTeammateView, useWhoami } from '#lib/viewer'

const project = api.project[':projectId']

async function saveInitSteps(projectId: string, text: string): Promise<void> {
  await project['init-steps'].$put({ param: { projectId }, json: { steps: parseSteps(text) } })
}

/**
 * Settings section for a project's settings and its `Dockerfile.yaac`, for
 * the project `useSettingsProject` picks; a teammate's show read-only.
 */
export function ProjectSettings(): JSX.Element {
  const teammateView = useTeammateView()
  const whoami = useWhoami()
  const all = useSnapshot()?.projects ?? []
  const { projects, selected, pick } = useSettingsProject()
  const projectId = selected?.id ?? null
  const sharedFrom = selected?.sharedFrom
  // A removed share stays readable by its owner, like a teammate's project.
  const readOnly = teammateView || sharedFrom?.revoked === true
  // A name its owner has twice names no one project to the CLI.
  const cliRef = selected && projects.filter((p) => p.name === selected.name).length > 1 ? selected.id : selected?.name
  const sharer = whoami?.users.find((u) => u.id === all.find((p) => p.id === sharedFrom?.projectId)?.owner)

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
            <p className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px]">
              <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 font-medium text-text-dim">
                {selected.hosted ? 'HOSTED BY YAAC' : remoteKind(selected.remoteUrl).toUpperCase()}
              </span>
              {!selected.hosted && (
                <span title={selected.remoteUrl} className="truncate font-mono text-text-faint">{selected.remoteUrl}</span>
              )}
              {sharedFrom && (
                <span className="truncate text-text-faint">
                  {sharedFrom.revoked ? 'Sharing removed' : 'Shared'}{sharer ? ` by ${sharer.name}` : ''}
                </span>
              )}
            </p>
          </div>

          <div className="mt-6">
            <ProjectIcon key={`icon:${projectId}`} project={selected} readOnly={readOnly} />
          </div>

          {selected.hosted && <div className="mt-6">
            <HostedRemote
              key={`hosted:${projectId}`}
              projectId={projectId}
              name={selected.name}
              cliRef={cliRef ?? selected.name}
              shared={sharedFrom !== undefined}
              guardDefaultBranch={selected.guardDefaultBranch}
              readOnly={readOnly || sharedFrom !== undefined}
            />
          </div>}

          {selected.hosted && !sharedFrom && <div className="mt-6">
            <ProjectSharing key={`sharing:${projectId}`} projectId={projectId} owner={selected.owner} readOnly={readOnly} />
          </div>}

          {selected.hosted && !sharedFrom && !readOnly && <div className="mt-6">
            <MoveToRemote key={`move:${projectId}`} projectId={projectId} name={selected.name} />
          </div>}

          {selected.keepsHostedRepo && <div className="mt-6">
            <KeptHostedRepo key={`kept:${projectId}`} projectId={projectId} remoteUrl={selected.remoteUrl} readOnly={readOnly} />
          </div>}

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
            <Workflows key={`workflows:${projectId}`} projectId={projectId} readOnly={readOnly} />
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
              nestedContainers={selected.nestedContainers}
              npmCache={selected.npmCache}
              readOnly={readOnly}
            />
          </div>}

          {hasVolumes && <div className="mt-6">
            <Volumes key={`volumes:${projectId}`} projectId={projectId} readOnly={readOnly} />
          </div>}

          {hasVolumes && <div className="mt-6">
            <Sites key={`sites:${projectId}`} projectId={projectId} readOnly={readOnly} />
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
            <div className="text-xs font-medium text-text">Init steps</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
              What every workspace runs when it starts, unless its create brings its own steps: steps by name,
              each{' '}<code className="text-text-dim">{'{"run": "<cmd>" or ["<cmd>", …], "needs": [...]}'}</code>,
              with <code className="text-text-dim">{'"service": true'}</code> and an optional{' '}
              <code className="text-text-dim">ready</code> check for one that keeps running.
            </p>
            {selected.initWorkflow !== undefined && (
              <p className="mt-1 text-[11px] leading-relaxed text-text-faint">
                These follow workflow <code className="text-text-dim">{selected.initWorkflow}</code>; saving the
                editor gives the project its own steps instead.
              </p>
            )}
            <div className="mt-2">
              <FileEditor
                key={`init-steps:${projectId}`}
                title={`${selected.name} · init steps`}
                language="json"
                queryKey={['project-init-steps', projectId]}
                load={() => Promise.resolve(`${JSON.stringify(selected.initSteps, null, 2)}\n`)}
                {...(readOnly ? {} : { save: (text: string) => saveInitSteps(projectId, text) })}
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
