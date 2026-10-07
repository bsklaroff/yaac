import { useState, type JSX } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { useQueryClient } from '@tanstack/react-query'
import { GitCredentialPicker, remoteKind, remoteProjectName, TrustedHostKey } from '#components/GitCredentialPicker'
import { AddIcon } from '#lib/icons'
import { addProjectInBackground } from '#lib/projectOps'
import { Modal } from '#components/ui/Modal'
import { useUiStore } from '#lib/store'
import { useReadOnly } from '#lib/viewer'

/** Opens the add-project dialog. */
export function NewProjectButton(
  /** 'rail': the desktop rail chip. 'row': the mobile projects-screen row.
   *  'cta': the welcome screen's button. */
  { variant = 'rail' }: { variant?: 'rail' | 'row' | 'cta' } = {},
): JSX.Element | null {
  const setAddProjectForm = useUiStore((s) => s.setAddProjectForm)
  const readOnly = useReadOnly()
  if (readOnly) return null
  return (
    <button
      onClick={() => setAddProjectForm({ remoteUrl: '' })}
      title="New project"
      className={{
        row: 'flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-text-dim transition '
          + 'active:bg-surface-2',
        rail: 'flex h-10 w-10 items-center justify-center rounded-[20px] bg-surface-2 text-text-dim transition-all '
          + 'hover:rounded-xl hover:bg-surface-3 hover:text-accent',
        cta: 'flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition '
          + 'hover:brightness-110',
      }[variant]}
    >
      <AddIcon size={variant === 'cta' ? 14 : 18} />
      {variant !== 'rail' && <span>Add project</span>}
    </button>
  )
}

/**
 * The add-project dialog: clone a git repo with a credential chosen in
 * `GitCredentialPicker`. Submitting closes the form and runs the clone in the
 * background (#lib/projectOps). Host keys that SSH adds trusted show once no
 * form is open.
 */
export function AddProjectDialog(): JSX.Element {
  const form = useUiStore((s) => s.addProjectForm)
  const setAddProjectForm = useUiStore((s) => s.setAddProjectForm)
  const keys = useUiStore((s) => s.trustedHostKeys)
  const clearTrustedHostKeys = useUiStore((s) => s.clearTrustedHostKeys)
  const close = (): void => {
    if (form !== null) setAddProjectForm(null)
    else clearTrustedHostKeys()
  }

  return (
    <Modal
      open={form !== null || keys.length > 0}
      onOpenChange={(next) => { if (!next) close() }}
      variant="form"
      className="w-[420px]"
    >
      <Dialog.Title className="text-sm font-semibold">Add project</Dialog.Title>
      {form !== null ? (
        <>
          <Dialog.Description className="mt-1 text-xs text-text-dim">
            Clone a git repo as a new project, with the credential its git authenticates with.
          </Dialog.Description>
          <CloneForm key={form.remoteUrl} initialUrl={form.remoteUrl} onDone={close} />
        </>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {keys.map((k) => (
            <div key={`${k.projectName} ${k.entry}`} className="flex flex-col gap-2">
              <p className="text-xs text-text-dim">Added {k.projectName}.</p>
              <TrustedHostKey entry={k.entry} />
            </div>
          ))}
          <Dialog.Close
            className="self-end rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition
              hover:brightness-110"
          >
            Done
          </Dialog.Close>
        </div>
      )}
    </Modal>
  )
}

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
      <input
        aria-label="Repository URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        autoFocus
        placeholder="https://github.com/owner/repo.git"
        className="rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none
          focus:border-border-strong"
      />
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
