import { useCallback } from 'react'
import { createWorkspace } from '#lib/createWorkspace'
import { configuredTools, useAuthList } from '#lib/useAuthList'
import { useProvisionWorkspace } from '#lib/useProvisionWorkspace'
import { useSnapshot } from '#lib/useSnapshot'
import { randomUUID } from '#lib/uuid'
import {
  DEFAULT_AGENT_MODE,
  resolveToolCreateDefaults,
  type AgentMode,
  type AgentTool,
  type ModelOption,
  type PermissionMode,
} from '@yaac/shared/types'

/** The create settings for one agent, and the models it offers. */
export interface AgentSetup {
  model: string
  permissionMode: PermissionMode
  /** Absent when the model has no effort setting. */
  effort?: string
  mode: AgentMode
  /** The credential's model list, newest first, shown as suggestions. */
  models: ModelOption[]
  /** The tool's own default model, marked in the list. */
  defaultModel: string
}

export interface CreateDefaults {
  /** The snapshot and the credential list have both loaded. Creating is
   *  blocked until then, since the defaults depend on them (without the
   *  snapshot, a containerless server would look sandboxed and get
   *  `bypass`). */
  ready: boolean
  /** The project has a git credential, which creating requires. */
  hasGitCredential: boolean
  /** The agent this project was last created with, else claude. */
  lastTool: AgentTool
  /** The branch this project was last created from, if a create named one. */
  lastBranch?: string
  /** The agents with a stored credential; only these can create. */
  configured: ReadonlySet<AgentTool>
  /** The settings an unedited create for `tool` would use, resolved as the
   *  server does (`resolveToolCreateDefaults`). */
  forTool: (tool: AgentTool) => AgentSetup
}

/**
 * The create form's defaults for a project, from its remembered choices in
 * the snapshot and each credential's model list.
 */
export function useCreateDefaults(projectId: string | null): CreateDefaults {
  const snapshot = useSnapshot()
  const auth = useAuthList()
  const project = snapshot?.projects.find((p) => p.id === projectId)
  const driver = snapshot?.driver
  return {
    ready: driver !== undefined && driver !== null && auth !== undefined,
    hasGitCredential: (project?.gitCredential ?? null) !== null,
    lastTool: project?.lastTool ?? 'claude',
    ...(project?.lastBranch !== undefined ? { lastBranch: project.lastBranch } : {}),
    configured: configuredTools(auth),
    forTool: (tool) => {
      const summary = auth?.toolAuth.find((t) => t.tool === tool)
      const remembered = project?.createDefaults[tool]
      const mode = remembered?.mode ?? DEFAULT_AGENT_MODE
      const provider = summary?.opencodeProvider ?? summary?.piProvider
      const defaultModel = summary?.defaultModel ?? ''
      const models = summary?.models ?? []
      const resolved = resolveToolCreateDefaults({
        driver: driver ?? 'k8s',
        tool,
        remembered,
        ...(provider !== undefined ? { provider } : {}),
        defaultModel,
        effortsFor: (model) => models.find((m) => m.id === model)?.efforts,
      })
      return { ...resolved, mode, models, defaultModel }
    },
  }
}

/**
 * Start a create through the shared provisioning flow (see
 * `useProvisionWorkspace`). The id is generated here so the row is
 * selectable and survives a reload. Every setting is sent, so all of them
 * become the project's defaults for that agent.
 */
export function useCreateWorkspace(): (
  projectId: string,
  tool: AgentTool,
  setup: Pick<AgentSetup, 'model' | 'permissionMode' | 'effort' | 'mode'> & {
    modelName?: string
    prompt?: string
    title?: string
    /** The row's label while it provisions, when `title` is unset. */
    shownTitle?: string
    groupId?: string
    /** A group to create and file it under, by name. */
    newGroup?: string
    draftId?: string
  },
  branch?: string,
) => void {
  const provision = useProvisionWorkspace()
  return useCallback((projectId, tool, setup, branch) => {
    const { model, modelName, permissionMode, effort, mode, prompt, title, shownTitle, groupId, newGroup, draftId } = setup
    const label = title || shownTitle
    provision(projectId, tool, 'create', randomUUID(),
      (sid, onProgress) =>
        createWorkspace(projectId, tool, onProgress, sid, {
          ...(branch !== undefined ? { branch } : {}),
          // Empty when the provider lists no models; launch without one.
          ...(model !== '' ? { model } : {}),
          permissionMode,
          ...(effort !== undefined ? { effort } : {}),
          mode,
          ...(prompt ? { prompt } : {}),
          ...(title ? { title } : {}),
          ...((groupId ?? newGroup) !== undefined ? { group: groupId ?? newGroup } : {}),
          ...(draftId !== undefined ? { draftId } : {}),
        }),
      groupId,
      {
        ...(label ? { title: label } : {}),
        ...(prompt ? { prompt } : {}),
        ...(model !== '' ? { model, ...(modelName !== undefined ? { modelName } : {}) } : {}),
      })
  }, [provision])
}
