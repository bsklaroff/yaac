import { useState, type FormEvent, type JSX } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { AUTH_LIST_KEY, useAuthList } from '#lib/useAuthList'
import { useSnapshotSelect } from '#lib/useSnapshot'
import { repoHostToAllow } from '@yaac/shared/allowed-hosts'
import { parseGitRemote } from '@yaac/shared/git-remote'
import { projectNameFor } from '@yaac/shared/project-name'
import type { EgressAllowlist } from '@yaac/shared/types'
import { YButton, YInput, YSelect } from '#ui'

export type GitCredentialKind = 'https' | 'ssh'

/** The credential kind a remote takes, as the server reads it: ssh:// and
 *  SCP-style remotes use an SSH key; anything else (or nothing parseable
 *  yet) uses an HTTPS token. */
export function remoteKind(remoteUrl: string): GitCredentialKind {
  try {
    return parseGitRemote(remoteUrl).scheme
  } catch {
    return 'https'
  }
}

/** The project name the server would derive from a remote, or '' if the
 *  remote doesn't parse. */
export function remoteProjectName(remoteUrl: string): string {
  try {
    return projectNameFor(parseGitRemote(remoteUrl).path)
  } catch {
    return ''
  }
}

/** `<project name>-token` or `<project name>-key` (`git-…` without a
 *  project), with `-2`, `-3`… appended until the name is free. */
export function defaultCredentialName(kind: GitCredentialKind, projectName: string, taken: readonly string[]): string {
  const base = `${projectName || 'git'}-${kind === 'ssh' ? 'key' : 'token'}`
  let name = base
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`
  return name
}

const NEW = 'new'

/**
 * Pick a project's git credential: an existing one of the right kind, or a
 * new one. A new HTTPS token is stored on submit. A new SSH key is generated
 * immediately so the user can register its public key with the git host
 * before the first git operation needs it.
 *
 * A credential created here is kept even if `onSubmit` fails, and is then
 * offered as existing so a retry reuses it. `offerExisting={false}` shows only
 * the new-credential form; `exclude` hides the project's current credential.
 * `inline` puts the submit button at the end of the new credential's fields
 * rather than on a line of its own, for a form with nothing to cancel.
 */
export function GitCredentialPicker({
  kind,
  projectName,
  exclude,
  actionLabel,
  onSubmit,
  onCancel,
  disabled = false,
  offerExisting = true,
  inline = false,
}: {
  kind: GitCredentialKind
  /** The project's name, for the default credential name ('' when there is
   *  no project). */
  projectName: string
  exclude?: string
  actionLabel: string
  /** Run with the chosen credential's id; a throw shows its message here. */
  onSubmit: (credentialId: string) => Promise<void>
  onCancel?: () => void
  /** The caller's own precondition (e.g. no URL yet). */
  disabled?: boolean
  offerExisting?: boolean
  inline?: boolean
}): JSX.Element {
  const auth = useAuthList()
  const queryClient = useQueryClient()
  const all = auth?.gitCredentials ?? []
  const existing = offerExisting ? all.filter((c) => c.kind === kind && c.id !== exclude) : []

  // null = untouched. A pick no longer on offer (e.g. the remote's kind
  // changed) is treated as untouched.
  const [pick, setPick] = useState<string | null>(null)
  const [name, setName] = useState<string | null>(null) // null = the default
  const [token, setToken] = useState('')
  const [generated, setGenerated] = useState<{ id: string; publicKey: string } | null>(null)

  const choice = pick === NEW || existing.some((c) => c.id === pick) ? pick as string
    : existing.length > 0 || (offerExisting && !auth) ? '' : NEW
  const shownName = name ?? defaultCredentialName(kind, projectName, all.map((c) => c.name))
  // Ignore a generated key if the remote is no longer SSH.
  const key = kind === 'ssh' ? generated : null
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })

  const generateKey = useMutation({
    mutationFn: (keyName: string) => api.auth.git['ssh-keys'].$post({ json: { name: keyName } }),
    onSuccess: (made) => {
      setGenerated(made)
      void refresh()
    },
  })
  const choose = useMutation({
    mutationFn: async (): Promise<void> => {
      let id = choice
      if (choice === NEW) {
        if (key !== null) {
          id = key.id
        } else {
          id = (await api.auth.git.credentials.$post({ json: { name: shownName.trim(), token: token.trim() } })).id
          // Switch to it as an existing credential so a retry doesn't
          // store it twice.
          await refresh()
          setPick(id)
          setToken('')
          setName(null)
        }
      }
      await onSubmit(id)
    },
  })
  const busy = generateKey.isPending ? 'generate' : choose.isPending ? 'submit' : null
  const error = (choose.error ?? generateKey.error)?.message ?? null
  const clearError = (): void => {
    choose.reset()
    generateKey.reset()
  }

  const ready = !disabled && busy === null && (choice === NEW
    ? (kind === 'ssh' ? key !== null : shownName.trim() !== '' && token.trim() !== '')
    : choice !== '')

  const generate = (): void => {
    if (shownName.trim() === '' || busy !== null) return
    clearError()
    generateKey.mutate(shownName.trim())
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (choice === NEW && kind === 'ssh' && key === null) { generate(); return }
    if (!ready) return
    clearError()
    choose.mutate()
  }

  const submitButton = (
    <YButton variant="primary" size={inline ? 'md' : 'sm'} type="submit" disabled={!ready}>
      {busy === 'submit' ? `${actionLabel}…` : actionLabel}
    </YButton>
  )
  const submitRow = (
    <div className="flex justify-end gap-2">
      {onCancel && (
        <YButton variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </YButton>
      )}
      {submitButton}
    </div>
  )
  // The new credential's fields end with the submit button when inline.
  const fieldsRow = inline && choice === NEW && key === null && !onCancel
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 text-md">
      {offerExisting && (
        <YSelect
          aria-label="Git credential"
          value={choice}
          onChange={(e) => { setPick(e.target.value); clearError() }}
        >
          {choice === '' && <option value="" disabled>Choose a git credential…</option>}
          {existing.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value={NEW}>{kind === 'ssh' ? 'New SSH key…' : 'New HTTPS token…'}</option>
        </YSelect>
      )}

      {choice === NEW && (key !== null ? (
        <div className="flex flex-col gap-1.5 bg-info-soft p-2.5">
          <p className="text-sm leading-relaxed text-muted">
            Register this public key with your git host — as a deploy key for the repo, or on your
            account — then continue.
          </p>
          <PublicKey publicKey={key.publicKey} wrap />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <YInput
            aria-label="Credential name"
            value={shownName}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            className="flex-1 font-mono"
          />
          {kind === 'https' ? (
            <YInput
              aria-label="Token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="token"
              className="flex-1 font-mono"
            />
          ) : (
            <YButton size={inline ? 'md' : 'sm'} onClick={generate} disabled={busy !== null || shownName.trim() === ''}>
              {busy === 'generate' ? 'Generating…' : 'Generate key'}
            </YButton>
          )}
          {fieldsRow && submitButton}
        </div>
      ))}

      {!fieldsRow && submitRow}
      {error && <p className="text-sm text-danger">{error}</p>}
    </form>
  )
}

/** An SSH public key with a Copy button. `wrap` shows it in full rather
 *  than as one truncated line with a View toggle. */
export function PublicKey({ publicKey, wrap = false }: { publicKey: string; wrap?: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [shown, setShown] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(publicKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="shrink-0 text-sm text-muted">Public key:</span>
      <code
        title={publicKey}
        className={`min-w-0 flex-1 select-all font-mono text-sm text-subtle ${wrap || shown ? 'break-all' : 'truncate'}`}
      >
        {publicKey}
      </code>
      <span className="flex shrink-0">
        {!wrap && (
          <YButton variant="secondary" size="sm" onClick={() => setShown((s) => !s)}>
            {shown ? 'Hide' : 'View'}
          </YButton>
        )}
        <YButton variant="ghost" size="sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </YButton>
      </span>
    </div>
  )
}

/** The host key an SSH assignment trusted on first use, for the user to
 *  compare against the fingerprints the host publishes. */
export function TrustedHostKey({ entry }: { entry: string }): JSX.Element {
  return (
    <p className="break-all font-mono text-sm text-subtle">
      <span className="font-sans text-muted">Host key trusted: </span>{entry}
    </p>
  )
}

/**
 * Warns that adding a repo will add its host to the project's egress
 * allowlist, as the server does (`repoHostToAllow`). Shows nothing without
 * an egress proxy, until the allowlist is known, or for a remote whose host
 * the server would not add. `remoteUrl` is '' for a repo yaac hosts.
 */
export function AllowlistAddNotice({ remoteUrl, allowlist }: {
  remoteUrl: string
  allowlist: EgressAllowlist | undefined
}): JSX.Element | null {
  const mediatedEgress = useSnapshotSelect((s) => s?.driver) !== 'containerless'
  const host = mediatedEgress && allowlist ? repoHostToAllow(allowlist, remoteUrl) : null
  if (host === null) return null
  return (
    <p className="text-sm text-muted">
      <span className="font-mono">{host}</span> is not in the project&apos;s egress allowlist. Adding the repo adds
      it, so workspaces can reach the repo.
    </p>
  )
}
