import { useEffect, useRef, useState, type FormEvent, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { useQueryClient } from '@tanstack/react-query'
import {
  GitCredentialPicker, INPUT, PublicKey, remoteKind, TrustedHostKey, type GitCredentialKind,
} from '#components/GitCredentialPicker'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { setProjectGitCredential } from '#lib/projectApi'
import { deleteGitCredential, renameGitCredential, replaceGitCredential } from '#lib/settingsApi'
import { AUTH_LIST_KEY, useAuthList } from '#lib/useAuthList'
import { useInlineEdit } from '#lib/useInlineRename'
import { useSnapshot } from '#lib/useSnapshot'
import { useUiStore } from '#store'
import type { GitCredentialSummary, ProjectSummary } from '@yaac/shared/types'

/**
 * Settings → Credentials → git (docs/git-credentials.md): the stored
 * credentials with the projects each serves, a form for a new one, and the
 * projects that have none — which cannot create worktrees until one is
 * assigned. Replacing a credential's secret keeps its name and projects;
 * deleting it leaves its projects with none.
 *
 * `settingsFocusProject` (an "Add git authentication" or failed-auth
 * affordance elsewhere) scrolls that project's row into view, with its
 * picker open.
 */
export function GitCredentials(): JSX.Element {
  const auth = useAuthList()
  const projects = useSnapshot()?.projects ?? []
  // Served once: after an assignment here the project's row is where it
  // should be, and its "Change" picker must not reopen under its new
  // credential.
  const [focus, setFocus] = useState(useUiStore.getState().settingsFocusProject)
  const queryClient = useQueryClient()
  // Host keys the assignments made here trusted, shown on the project's row.
  const [trusted, setTrusted] = useState<Record<string, string>>({})
  // Public keys a Replace here generated, by the replacement's id: shown
  // with the reminder to register them until the settings close.
  const [newKeys, setNewKeys] = useState<Record<string, string>>({})
  const [addKey, setAddKey] = useState(0) // remounts the add form once it's done
  // A Delete or Replace that failed, kept here rather than on its row: the
  // server may have made the change and failed only to tell the egress
  // proxy (RUNTIME_UNAVAILABLE), so the list is refreshed — and a deleted
  // row, with any message on it, goes.
  const [failure, setFailure] = useState<string | null>(null)

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })

  const assign = async (slug: string, credentialId: string): Promise<void> => {
    const hostKey = await setProjectGitCredential(slug, credentialId)
    setFocus(null)
    setTrusted((t) => {
      const next = { ...t }
      if (hostKey === null) delete next[slug]
      else next[slug] = hostKey
      return next
    })
    await refresh()
  }

  const unassigned = projects.filter((p) => p.gitCredential === null)

  return (
    <>
      <Group
        label="Git credentials"
        hint="HTTPS tokens the proxy injects, and SSH keys yaac generated. Each project uses one; replace a credential to rotate it for all of its projects."
      >
        <div className="space-y-2 text-xs">
          {/* Unused credentials last: the ones in use are what a user looks
              for, and an unused one is a candidate for deleting. The sort is
              stable, so each group keeps the server's oldest-first order. */}
          {failure && <p className="text-[11px] text-red-400">{failure}</p>}
          {[...(auth?.gitCredentials ?? [])].sort((a, b) => Number(a.projects.length === 0) - Number(b.projects.length === 0)).map((c) => (
            <CredentialRow
              key={c.id}
              credential={c}
              projects={projects}
              focus={focus}
              trusted={trusted}
              newKey={newKeys[c.id]}
              onAssign={assign}
              onReplaced={(id, publicKey) => {
                if (publicKey !== undefined) setNewKeys((k) => ({ ...k, [id]: publicKey }))
                setFailure(null)
                void refresh()
              }}
              onChanged={() => { setFailure(null); void refresh() }}
              onFailed={(message) => { setFailure(message); void refresh() }}
            />
          ))}
          {auth && auth.gitCredentials.length === 0 && (
            <p className="text-text-faint">No git credentials yet.</p>
          )}
        </div>
      </Group>

      <Group label="Add git credential" hint="Stored without a project; you can assign it to projects after creation.">
        <AddCredential key={addKey} onDone={() => { setAddKey((k) => k + 1); void refresh() }} />
      </Group>

      {unassigned.length > 0 && (
        <Group label="Projects without git authentication" hint="Assign each a credential to create worktrees in it.">
          <div className="space-y-2 text-xs">
            {unassigned.map((p) => (
              <ProjectRow key={p.slug} slug={p.slug} focused={focus === p.slug}>
                <p className="truncate font-mono text-[11px] text-text-faint">{p.remoteUrl}</p>
                <GitCredentialPicker
                  kind={remoteKind(p.remoteUrl)}
                  project={p.slug}
                  actionLabel="Assign"
                  onSubmit={(id) => assign(p.slug, id)}
                />
              </ProjectRow>
            ))}
          </div>
        </Group>
      )}
    </>
  )
}

/** A labeled sub-section of the credentials pane. */
function Group({ label, hint, children }: { label: string; hint: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mt-6">
      <div className="text-xs font-medium text-text">{label}</div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">{hint}</p>
      <div className="mt-2">{children}</div>
    </div>
  )
}

/** One stored credential: its name (click to rename), kind and preview, the
 *  projects using it — each with "Change" — and Replace and Delete, each
 *  destructive step behind a confirmation that names the projects it hits. */
function CredentialRow({ credential: c, projects, focus, trusted, newKey, onAssign, onReplaced, onChanged, onFailed }: {
  credential: GitCredentialSummary
  projects: ProjectSummary[]
  focus: string | null
  trusted: Record<string, string>
  /** The public key a Replace just generated, not yet acknowledged. */
  newKey: string | undefined
  onAssign: (slug: string, credentialId: string) => Promise<void>
  onReplaced: (id: string, publicKey?: string) => void
  onChanged: () => void
  /** A Delete or Replace failed, possibly after the server made it. */
  onFailed: (message: string) => void
}): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'delete' | 'replace' | null>(null)
  const [replacingToken, setReplacingToken] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const rename = useInlineEdit(c.name, (next) => {
    if (next === '') return
    setError(null)
    renameGitCredential(c.id, next)
      .then(onChanged)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'failed to rename'))
  })

  const run = async (action: () => Promise<void>, failure: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      onFailed(`${c.name}: ${err instanceof Error ? err.message : failure}`)
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }
  const replace = (): Promise<void> => run(async () => {
    const replaced = await replaceGitCredential(c.id, c.kind === 'https' ? token.trim() : undefined)
    setReplacingToken(false)
    setToken('')
    onReplaced(replaced.id, replaced.publicKey)
  }, 'failed to replace')
  const submitToken = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (token.trim() !== '' && !busy) void replace()
  }

  const using = c.projects.join(', ')
  return (
    <div className="flex flex-col gap-2 rounded-md bg-bg px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        {rename.editing ? (
          <input
            ref={rename.inputRef}
            aria-label="Rename credential"
            defaultValue={rename.seed}
            maxLength={100}
            onKeyDown={rename.handleKeyDown}
            onBlur={rename.handleBlur}
            className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-text
              outline-none focus:border-border-strong"
          />
        ) : (
          <button
            type="button"
            onClick={rename.start}
            title="Rename"
            className="min-w-0 truncate text-left font-medium text-text"
          >
            {c.name}
          </button>
        )}
        <span className="shrink-0 font-mono text-text-faint">{c.kind}</span>
        <span className="ml-auto shrink-0 font-mono text-text-faint">{c.kind === 'https' && c.preview}</span>
        {/* A pair of text actions sits closer than the row's other items. */}
        <span className="flex shrink-0">
          {!replacingToken && (
            <button
              type="button"
              onClick={() => (c.kind === 'https' ? setReplacingToken(true) : setConfirm('replace'))}
              className={TEXT_BUTTON}
            >
              Replace
            </button>
          )}
          <button type="button" onClick={() => setConfirm('delete')} className={TEXT_BUTTON}>
            Delete
          </button>
        </span>
      </div>
      {replacingToken && (
        <form onSubmit={submitToken} className="flex items-center gap-2">
          <input
            aria-label="New token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="new token"
            autoFocus
            className={INPUT}
          />
          <button type="submit" disabled={busy || token.trim() === ''} className={BUTTON}>
            {busy ? 'Replacing…' : 'Replace'}
          </button>
          <button type="button" onClick={() => { setReplacingToken(false); setToken('') }} className={BUTTON}>
            Cancel
          </button>
        </form>
      )}
      {newKey !== undefined ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-accent/20 bg-accent/5 p-2.5">
          <p className="text-[11px] leading-relaxed text-text-dim">
            A new key replaced the old one. Register this public key with your git host — as a deploy
            key for the repo, or on your account — before its projects&apos; git works again.
          </p>
          <PublicKey publicKey={newKey} wrap />
        </div>
      ) : c.publicKey !== undefined && <PublicKey publicKey={c.publicKey} />}
      {c.projects.length === 0 && <p className="text-[11px] text-text-faint">No assigned projects</p>}
      {c.projects.map((slug) => (
        <UsingProject
          key={slug}
          slug={slug}
          credentialId={c.id}
          remoteUrl={projects.find((p) => p.slug === slug)?.remoteUrl}
          focused={focus === slug}
          trusted={trusted[slug]}
          onAssign={(id) => onAssign(slug, id)}
        />
      ))}
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={`Delete ${c.name}?`}
        description={c.projects.length === 0 ? 'No project uses it.'
          : `${using} will be left with no git credential, and cannot create worktrees until assigned another.`}
        busy={busy}
        requireClick
        onConfirm={() => void run(async () => { await deleteGitCredential(c.id); onChanged() }, 'failed to delete')}
      />
      <ConfirmDialog
        open={confirm === 'replace'}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={`Generate a new key for ${c.name}?`}
        description={`The current key is discarded. ${c.projects.length === 0
          ? 'Register the new public key with your git host before a project uses it.'
          : `Git in ${using} fails until the new public key is registered with your git host.`}`}
        confirmLabel="Generate new key"
        busy={busy}
        requireClick
        onConfirm={() => void replace()}
      />
    </div>
  )
}

/** A project under the credential it uses, with "Change" to assign it
 *  another. */
function UsingProject({ slug, credentialId, remoteUrl, focused, trusted, onAssign }: {
  slug: string
  /** The credential it uses now, which "Change" does not offer. */
  credentialId: string
  /** Absent until the snapshot names the project. */
  remoteUrl: string | undefined
  focused: boolean
  trusted: string | undefined
  onAssign: (credentialId: string) => Promise<void>
}): JSX.Element {
  const [changing, setChanging] = useState(focused)
  return (
    <ProjectRow slug={slug} focused={focused} nested>
      {!changing && remoteUrl !== undefined && (
        <button type="button" onClick={() => setChanging(true)} className={clsx(TEXT_BUTTON, 'absolute right-1.5 top-1')}>
          Change
        </button>
      )}
      {trusted !== undefined && <TrustedHostKey entry={trusted} />}
      {changing && remoteUrl !== undefined && (
        <GitCredentialPicker
          kind={remoteKind(remoteUrl)}
          project={slug}
          exclude={credentialId}
          actionLabel="Assign"
          onSubmit={async (id) => { await onAssign(id); setChanging(false) }}
          onCancel={() => setChanging(false)}
        />
      )}
    </ProjectRow>
  )
}

/** A project's row: its slug, then whatever it offers. Focused, it scrolls
 *  into view and stands out. */
function ProjectRow({ slug, focused, nested = false, children }: {
  slug: string
  focused: boolean
  nested?: boolean
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'center' })
  }, [focused])
  return (
    <div
      ref={ref}
      data-project={slug}
      className={clsx(
        'relative flex flex-col gap-1.5 rounded-md px-2.5 py-1.5',
        nested ? 'border border-hairline-soft' : 'bg-bg',
        focused && 'ring-1 ring-accent',
      )}
    >
      <span className="font-mono text-text-dim">{slug}</span>
      {children}
    </div>
  )
}

/** A credential no project uses yet: the picker's "new" form, with the kind
 *  chosen here since there is no remote to take it from. */
function AddCredential({ onDone }: { onDone: () => void }): JSX.Element {
  const [kind, setKind] = useState<GitCredentialKind>('https')
  return (
    <div className="flex flex-col gap-2">
      <select
        aria-label="Credential kind"
        value={kind}
        onChange={(e) => setKind(e.target.value === 'ssh' ? 'ssh' : 'https')}
        className="w-fit rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-text outline-none"
      >
        <option value="https">HTTPS token</option>
        <option value="ssh">SSH key</option>
      </select>
      <GitCredentialPicker
        key={kind}
        kind={kind}
        project=""
        offerExisting={false}
        actionLabel={kind === 'ssh' ? 'Done' : 'Save'}
        onSubmit={() => { onDone(); return Promise.resolve() }}
      />
    </div>
  )
}
