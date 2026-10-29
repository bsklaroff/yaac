import { useMemo, type JSX } from 'react'
import { remoteKind } from '#components/GitCredentialPicker'
import { FileEditor } from '#components/settings/FileEditor'
import { BuildFiles } from '#components/settings/BuildFiles'
import { ProjectEnv } from '#components/settings/ProjectEnv'
import { EgressAllowlist } from '#components/settings/EgressAllowlist'
import { HostedRemote } from '#components/settings/HostedRemote'
import { ProjectSharing } from '#components/settings/ProjectSharing'
import { WorkspaceAutoDelete } from '#components/settings/WorkspaceAutoDelete'
import { KeptIgnoredPaths } from '#components/settings/KeptIgnoredPaths'
import { ProjectSelect, useSettingsProject } from '#components/settings/ProjectPicker'
import { api } from '#lib/api'
import { WarningIcon } from '#lib/icons'
import { projectBuildFilesApi } from '#lib/buildFilesApi'
import { useSnapshot } from '#lib/useSnapshot'
import { useTeammateView, useWhoami } from '#lib/viewer'

const project = api.project[':projectId']

async function loadConfig(projectId: string): Promise<string> {
  const { config } = await project.config.$get({ param: { projectId } })
  return JSON.stringify(config ?? {}, null, 2) + '\n'
}

async function saveConfig(projectId: string, text: string): Promise<void> {
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  await project.config.$put({ param: { projectId }, json: { config } })
}

/**
 * Settings section for a project's overlay files: `yaac-config.json` and
 * `Dockerfile.yaac`, for the project `useSettingsProject` picks; a teammate's
 * show read-only.
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

  // A containerless server builds no images, so the Dockerfile editors are
  // hidden.
  const buildsImages = useSnapshot()?.driver !== 'containerless'
  // Only with an egress proxy can a secret's value stay out of the
  // workspace, or an allowlist apply.
  const mediatedEgress = useSnapshot()?.driver !== 'containerless'

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

          {mediatedEgress && <div className="mt-6">
            <EgressAllowlist key={`allowlist:${projectId}`} projectId={projectId} readOnly={readOnly} />
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
            <div className="text-xs font-medium text-text">yaac-config.json</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
              This machine&apos;s config overlay for the project.
            </p>
            <div className="mt-2">
              <FileEditor
                key={`config:${projectId}`}
                title={`${selected.name} · yaac-config.json`}
                language="json"
                queryKey={['project-config', projectId]}
                load={() => loadConfig(projectId)}
                {...(readOnly ? {} : { save: (text: string) => saveConfig(projectId, text) })}
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
