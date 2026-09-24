import { useCallback } from 'react'
import { createWorktree } from '#lib/createWorktree'
import { configuredTools, useAuthList } from '#lib/useAuthList'
import { useProvisionWorktree } from '#lib/useProvisionWorktree'
import { useSnapshot } from '#lib/useSnapshot'
import { randomUUID } from '#lib/uuid'
import {
  resolveToolCreateDefaults,
  type AgentMode,
  type AgentTool,
  type ModelOption,
  type PermissionMode,
} from '@yaac/shared/types'

/** Everything a create for one agent is made of, and the models it offers. */
export interface AgentSetup {
  model: string
  permissionMode: PermissionMode
  mode: AgentMode
  /** The credential's model list, newest first — the form's suggestions. */
  models: ModelOption[]
  /** What the tool runs when nothing is remembered; tagged in the list. */
  defaultModel: string
}

export interface CreateDefaults {
  /** The snapshot and the credential list have both landed. Until then the
   *  fallbacks are unknowable — a missing snapshot would read a
   *  containerless server as sandboxed and offer `bypass` — so nothing may
   *  create. */
  ready: boolean
  /** The project has a git credential; without one nothing may create. */
  hasGitCredential: boolean
  /** The agent this project was last created with, else claude. */
  lastTool: AgentTool
  /** The agents with a stored credential; only these can create. */
  configured: ReadonlySet<AgentTool>
  /** What an untouched create for `tool` would run — the same resolution the
   *  server makes (`resolveToolCreateDefaults`), so the form shows exactly
   *  what submitting it untouched launches. */
  forTool: (tool: AgentTool) => AgentSetup
}

/**
 * The create form's defaults for a project, from the project's remembered
 * choices in the snapshot and each credential's model list. The popover opens
 * on them and Alt+N submits them as they stand, which is what makes the
 * shortcut and "open, Enter" the same create.
 */
export function useCreateDefaults(projectSlug: string | null): CreateDefaults {
  const snapshot = useSnapshot()
  const auth = useAuthList()
  const project = snapshot?.projects.find((p) => p.slug === projectSlug)
  const driver = snapshot?.driver
  return {
    ready: driver !== undefined && driver !== null && auth !== undefined,
    hasGitCredential: (project?.gitCredential ?? null) !== null,
    lastTool: project?.lastTool ?? 'claude',
    configured: configuredTools(auth),
    forTool: (tool) => {
      const summary = auth?.toolAuth.find((t) => t.tool === tool)
      const remembered = project?.createDefaults[tool]
      const mode = remembered?.mode ?? 'tui'
      const provider = summary?.opencodeProvider ?? summary?.piProvider
      const defaultModel = summary?.defaultModel ?? ''
      const resolved = resolveToolCreateDefaults({
        driver: driver ?? 'k8s',
        tool,
        agentMode: mode,
        remembered,
        ...(provider !== undefined ? { provider } : {}),
        defaultModel,
      })
      return { ...resolved, mode, models: summary?.models ?? [], defaultModel }
    },
  }
}

/**
 * Start a create with every choice made, through the shared provisioning
 * flow: an optimistic row that names the model from its first frame,
 * auto-opened so progress streams into the main pane. The id is generated up
 * front so the row is selectable and survives a reload.
 *
 * Everything is sent, so everything becomes the project's defaults for that
 * agent — pressing Create accepts what the form shows.
 */
export function useCreateWorktree(): (
  projectSlug: string,
  tool: AgentTool,
  setup: Pick<AgentSetup, 'model' | 'permissionMode' | 'mode'> & { modelName?: string },
  branch?: string,
) => void {
  const provision = useProvisionWorktree()
  return useCallback((projectSlug, tool, setup, branch) => {
    const { model, modelName, permissionMode, mode } = setup
    provision(projectSlug, tool, 'create', randomUUID(),
      (sid, onProgress, retryOpts) =>
        createWorktree(projectSlug, tool, onProgress, sid, {
          ...(branch !== undefined ? { branch } : {}),
          // Empty only when the credential's provider lists no models at
          // all; the server then launches without one.
          ...(model !== '' ? { model } : {}),
          permissionMode,
          mode,
          ...(retryOpts?.installMissingTool === true ? { installMissingTool: true } : {}),
        }),
      undefined,
      model !== '' ? { model, ...(modelName !== undefined ? { modelName } : {}) } : undefined)
  }, [provision])
}
