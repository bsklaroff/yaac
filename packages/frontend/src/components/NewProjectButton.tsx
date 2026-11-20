import { memo, useState, type FormEvent, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  AllowlistAddNotice, GitCredentialPicker, remoteKind, remoteProjectName, TrustedHostKey,
} from '#components/GitCredentialPicker'
import { AddIcon } from '#lib/icons'
import { addProjectInBackground, createProjectInBackground } from '#lib/projectOps'
import { projectNameFor } from '@yaac/shared/project-name'
import { useUiStore } from '#lib/store'
import { useTeammateView } from '#lib/viewer'
import { YButton, YDialog, YDialogClose, YDialogDescription, YDialogTitle, YInput, YSegmented } from '#ui'

/** Opens the add-project dialog. */
export function NewProjectButton(
  /** 'row': the mobile projects-screen row. 'cta': the welcome screen's button. */
  { variant }: { variant: 'row' | 'cta' },
): JSX.Element | null {
  const setAddProjectForm = useUiStore((s) => s.setAddProjectForm)
  const readOnly = useTeammateView()
  if (readOnly) return null
  const open = (): void => setAddProjectForm({ remoteUrl: '' })
  if (variant === 'cta') {
    return <YButton variant="primary" icon={AddIcon} onClick={open}>Add project</YButton>
  }
  return (
    <YButton
      variant="bare"
      onClick={open}
      className="flex w-full items-center gap-3 px-3 py-3 text-left text-base text-muted transition active:bg-selected"
    >
      <AddIcon size={18} />
      <span>Add project</span>
    </YButton>
  )
}

/**
 * The add-project dialog: clone a git repo with a credential chosen in
 * `GitCredentialPicker`, or create an empty project whose remote yaac hosts
 * (docs/hosted-projects.md). Submitting closes the form and runs the add in
 * the background (#lib/projectOps). Host keys that SSH adds trusted show
 * once no form is open.
 */
export const AddProjectDialog = memo(function AddProjectDialog(): JSX.Element {
  const form = useUiStore((s) => s.addProjectForm)
  const setAddProjectForm = useUiStore((s) => s.setAddProjectForm)
  const keys = useUiStore((s) => s.trustedHostKeys)
  const clearTrustedHostKeys = useUiStore((s) => s.clearTrustedHostKeys)
  const close = (): void => {
    if (form !== null) setAddProjectForm(null)
    else clearTrustedHostKeys()
  }

  return (
    <YDialog
      open={form !== null || keys.length > 0}
      onOpenChange={(next) => { if (!next) close() }}
      variant="form"
      className="w-[420px]"
    >
      <YDialogTitle className="text-base font-semibold">Add project</YDialogTitle>
      {form !== null ? (
        <>
          <YSegmented
            ariaLabel="Source"
            className="mt-3"
            options={[{ value: 'clone', label: 'Clone a repository' }, { value: 'create', label: 'New project' }]}
            value={'name' in form ? 'create' : 'clone'}
            onChange={(source) => setAddProjectForm(source === 'create' ? { name: '' } : { remoteUrl: '' })}
          />
          {'name' in form ? (
            <>
              <YDialogDescription className="mt-3 text-md text-muted">
                Start an empty project. yaac hosts its git repository, so it needs no credential;
                clone it to your machine with <code>yaac project clone</code>.
              </YDialogDescription>
              <CreateForm key={form.name} initialName={form.name} onDone={close} />
            </>
          ) : (
            <>
              <YDialogDescription className="mt-3 text-md text-muted">
                Clone a git repo as a new project, with the credential its git authenticates with.
              </YDialogDescription>
              <CloneForm key={form.remoteUrl} initialUrl={form.remoteUrl} onDone={close} />
            </>
          )}
        </>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {keys.map((k) => (
            <div key={`${k.projectName} ${k.entry}`} className="flex flex-col gap-2">
              <p className="text-md text-muted">Added {k.projectName}.</p>
              <TrustedHostKey entry={k.entry} />
            </div>
          ))}
          <YDialogClose render={<YButton variant="primary" className="self-end" />}>Done</YDialogClose>
        </div>
      )}
    </YDialog>
  )
})

/** The allowlist a project starts with: the defaults and nothing added. */
const NEW_PROJECT_ALLOWLIST = { hosts: [], defaults: true }

function CloneForm({ initialUrl, onDone }: { initialUrl: string; onDone: () => void }): JSX.Element {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState(initialUrl)
  const remoteUrl = url.trim()

  const add = (credentialId: string): Promise<void> => {
    addProjectInBackground(remoteUrl, remoteProjectName(remoteUrl) || remoteUrl, credentialId, queryClient)
    onDone()
    return Promise.resolve()
  }

  return (
    <div className="mt-4 flex flex-col gap-3">
      <YInput
        aria-label="Repository URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        autoFocus
        placeholder="https://github.com/owner/repo.git"
        className="font-mono"
      />
      <AllowlistAddNotice remoteUrl={remoteUrl} allowlist={NEW_PROJECT_ALLOWLIST} />
      <GitCredentialPicker
        kind={remoteKind(remoteUrl)}
        projectName={remoteProjectName(remoteUrl)}
        actionLabel="Add"
        disabled={remoteUrl === ''}
        onSubmit={add}
        onCancel={onDone}
      />
    </div>
  )
}

function CreateForm({ initialName, onDone }: { initialName: string; onDone: () => void }): JSX.Element {
  const [name, setName] = useState(initialName)
  const projectName = projectNameFor(name.trim())

  const create = (e: FormEvent): void => {
    e.preventDefault()
    createProjectInBackground(name.trim())
    onDone()
  }

  return (
    <form onSubmit={create} className="mt-4 flex flex-col gap-3">
      <YInput
        aria-label="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        placeholder="my-project"
        className="font-mono"
      />
      {name.trim() !== '' && projectName !== name.trim() && (
        <p className="text-sm text-subtle">
          {projectName === '' ? 'Use at least one letter or digit.' : <>Named <code>{projectName}</code>.</>}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <YButton variant="ghost" onClick={onDone}>Cancel</YButton>
        <YButton variant="primary" type="submit" disabled={projectName === ''}>Create</YButton>
      </div>
    </form>
  )
}
