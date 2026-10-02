import { useEffect, useState, type JSX } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { useQueryClient } from '@tanstack/react-query'
import { GitCredentialPicker, remoteKind, remoteSlug, TrustedHostKey } from '#components/GitCredentialPicker'
import { AddIcon } from '#lib/icons'
import { api } from '#lib/api'
import { Modal } from '#components/ui/Modal'
import { AUTH_LIST_KEY } from '#lib/useAuthList'
import { useUiStore } from '#lib/store'
import { useSnapshot } from '#lib/useSnapshot'

/**
 * Add-project button and dialog: clone a git repo with a credential chosen in
 * `GitCredentialPicker`. On success, selects the new project once the
 * snapshot lists it (selecting it sooner, the shell's fallback for an unknown
 * project would switch straight back); an SSH clone first shows the host key
 * it trusted.
 */
export function NewProjectButton(
  /** 'rail': the desktop rail chip. 'row': the mobile projects-screen row. */
  { variant = 'rail' }: { variant?: 'rail' | 'row' } = {},
): JSX.Element {
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const queryClient = useQueryClient()
  const projects = useSnapshot()?.projects
  const [added, setAdded] = useState<string | null>(null)
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
    const { project: { slug }, knownHostsEntry } = await api.project.add.$post({
      json: { remoteUrl, gitCredentialId: credentialId },
    })
    // Refresh the credential's project list.
    void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
    setAdded(slug)
    if (knownHostsEntry !== null) setTrusted(knownHostsEntry)
    else onOpenChange(false)
  }

  useEffect(() => {
    if (added === null || !projects?.some((p) => p.slug === added)) return
    setActiveProject(added)
    setAdded(null)
  }, [added, projects, setActiveProject])

  return (
    <>
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

      <Modal open={open} onOpenChange={onOpenChange} variant="form" className="w-[420px]">
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
      </Modal>
    </>
  )
}
