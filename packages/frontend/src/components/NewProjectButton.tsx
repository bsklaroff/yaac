import { useState, type JSX } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { useQueryClient } from '@tanstack/react-query'
import { GitCredentialPicker, remoteKind, remoteSlug, TrustedHostKey } from '#components/GitCredentialPicker'
import { AddIcon } from '#lib/icons'
import { addProject } from '#lib/projectApi'
import { AUTH_LIST_KEY } from '#lib/useAuthList'
import { useUiStore } from '#store'

/**
 * Rail "+": add a project by cloning a git repo, with the git credential it
 * will authenticate with — a stored one of the kind its remote takes, or a
 * new one (GitCredentialPicker). On success selects the new project; an SSH
 * clone first shows the host key it trusted. A failed clone keeps any
 * credential just created, offered for the retry.
 */
export function NewProjectButton(
  /** 'rail' is the desktop rail's 40px chip; 'row' is the mobile project
   *  screen's full-width labelled row. */
  { variant = 'rail' }: { variant?: 'rail' | 'row' } = {},
): JSX.Element {
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [trusted, setTrusted] = useState<string | null>(null)
  const remoteUrl = url.trim()

  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) {
      setUrl('')
      setTrusted(null)
    }
  }

  const add = async (credentialId: string): Promise<void> => {
    const { slug, knownHostsEntry } = await addProject(remoteUrl, credentialId)
    // The credential now lists one more project.
    void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
    setActiveProject(slug)
    if (knownHostsEntry !== null) setTrusted(knownHostsEntry)
    else onOpenChange(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <button
        onClick={() => setOpen(true)}
        title="New project"
        className={variant === 'row'
          ? 'flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-text-dim transition '
            + 'active:bg-surface-2'
          : 'flex h-10 w-10 items-center justify-center rounded-[20px] bg-surface-2 text-text-dim transition-all '
            + 'hover:rounded-xl hover:bg-surface-3 hover:text-accent'}
      >
        <AddIcon size={18} />
        {variant === 'row' && <span>Add project</span>}
      </button>

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2
          rounded-lg border border-border bg-surface-2 p-5 text-text shadow-[0_16px_48px_var(--shadow-color)] outline-none
          transition duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0
          data-[ending-style]:scale-95 data-[ending-style]:opacity-0">
          <Dialog.Title className="text-sm font-semibold">Add project</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-text-dim">
            Clone a git repo as a new project, with the credential its git authenticates with.
          </Dialog.Description>
          {trusted === null ? (
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
                project={remoteSlug(remoteUrl)}
                actionLabel="Add"
                disabled={remoteUrl === ''}
                onSubmit={add}
                onCancel={() => onOpenChange(false)}
              />
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              <p className="text-xs text-text-dim">Project added.</p>
              <TrustedHostKey entry={trusted} />
              <Dialog.Close
                className="self-end rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition
                  hover:brightness-110"
              >
                Done
              </Dialog.Close>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
