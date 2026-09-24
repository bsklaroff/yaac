import { useState, type FormEvent, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import { addHttpsCredential, generateSshKey } from '#lib/settingsApi'
import { AUTH_LIST_KEY, useAuthList } from '#lib/useAuthList'

export type GitCredentialKind = 'https' | 'ssh'

/** The server's SCP-style remote (`[user@]host:path`), per `parseGitRemote`. */
const SCP_RE = /^(?:[\w._-]+@)?([\w.-]+):(?!\/)(.+)$/

/** What a remote authenticates with: an SCP-style `git@host:path` remote an
 *  SSH key, anything else (an `https://` URL) a token. */
export function remoteKind(remoteUrl: string): GitCredentialKind {
  return SCP_RE.test(remoteUrl) ? 'ssh' : 'https'
}

/** The project slug the server derives from a remote — its last path
 *  segment, `.git` dropped, lowercased — or '' while it does not parse. */
export function remoteSlug(remoteUrl: string): string {
  let repoPath = SCP_RE.exec(remoteUrl)?.[2]
  if (repoPath === undefined) {
    try {
      repoPath = new URL(remoteUrl).pathname
    } catch {
      return ''
    }
  }
  return (repoPath.replace(/\/$/, '').replace(/\.git$/, '').split('/').pop() ?? '').toLowerCase()
}

/** `<project>-token` / `<project>-key` (`git-…` with no project), suffixed
 *  `-2`, `-3`… past the names taken. */
export function defaultCredentialName(kind: GitCredentialKind, project: string, taken: readonly string[]): string {
  const base = `${project || 'git'}-${kind === 'ssh' ? 'key' : 'token'}`
  let name = base
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`
  return name
}

const NEW = 'new'

export const INPUT = 'min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text '
  + 'outline-none focus:border-border-strong'

/**
 * Choose the git credential a project authenticates with: one of the stored
 * credentials of the kind its remote takes, or a new one. A new HTTPS token
 * is a name and the pasted token, stored when the action runs; a new SSH key
 * is generated on the spot, so its public half can be registered with the
 * git host before the action — the first git operation — needs it. The name
 * starts on a unique default.
 *
 * A credential created here stays created whatever the action does after,
 * and the picker then offers it as an existing one: a retry reuses it rather
 * than minting another. `offerExisting={false}` is the bare "new credential"
 * form (Settings → Add), whose action just finishes; `exclude` keeps a
 * project's current credential off the offer when it is changing it.
 */
export function GitCredentialPicker({
  kind,
  project,
  exclude,
  actionLabel,
  onSubmit,
  onCancel,
  disabled = false,
  offerExisting = true,
}: {
  kind: GitCredentialKind
  /** The project's slug, for the default name ('' when there is none). */
  project: string
  exclude?: string
  actionLabel: string
  /** Run with the chosen credential's id; a throw shows its message here. */
  onSubmit: (credentialId: string) => Promise<void>
  onCancel?: () => void
  /** The caller's own precondition (e.g. no URL yet). */
  disabled?: boolean
  offerExisting?: boolean
}): JSX.Element {
  const auth = useAuthList()
  const queryClient = useQueryClient()
  const all = auth?.gitCredentials ?? []
  const existing = offerExisting ? all.filter((c) => c.kind === kind && c.id !== exclude) : []

  // null = untouched. A pick of a credential that is not (or no longer) on
  // offer — the remote's kind changed under it — falls back like untouched.
  const [pick, setPick] = useState<string | null>(null)
  const [name, setName] = useState<string | null>(null) // null = the default
  const [token, setToken] = useState('')
  const [generated, setGenerated] = useState<{ id: string; publicKey: string } | null>(null)
  const [busy, setBusy] = useState<'generate' | 'submit' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choice = pick === NEW || existing.some((c) => c.id === pick) ? pick as string
    : existing.length > 0 || (offerExisting && !auth) ? '' : NEW
  const shownName = name ?? defaultCredentialName(kind, project, all.map((c) => c.name))
  // A generated key serves an SSH remote only; the URL may have changed since.
  const key = kind === 'ssh' ? generated : null
  const ready = !disabled && busy === null && (choice === NEW
    ? (kind === 'ssh' ? key !== null : shownName.trim() !== '' && token.trim() !== '')
    : choice !== '')

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })

  const generate = async (): Promise<void> => {
    if (shownName.trim() === '' || busy !== null) return
    setBusy('generate')
    setError(null)
    try {
      setGenerated(await generateSshKey(shownName.trim()))
      void refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to generate a key')
    } finally {
      setBusy(null)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (choice === NEW && kind === 'ssh' && key === null) { await generate(); return }
    if (!ready) return
    setBusy('submit')
    setError(null)
    try {
      let id = choice
      if (choice === NEW) {
        if (key !== null) {
          id = key.id
        } else {
          id = await addHttpsCredential(shownName.trim(), token.trim())
          // Stored now, whatever the action does: from here on it is an
          // existing credential, so a retry does not store it twice.
          await refresh()
          setPick(id)
          setToken('')
          setName(null)
        }
      }
      await onSubmit(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 text-xs">
      {offerExisting && (
        <select
          aria-label="Git credential"
          value={choice}
          onChange={(e) => { setPick(e.target.value); setError(null) }}
          className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-text outline-none"
        >
          {choice === '' && <option value="" disabled>Choose a git credential…</option>}
          {existing.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value={NEW}>{kind === 'ssh' ? 'New SSH key…' : 'New HTTPS token…'}</option>
        </select>
      )}

      {choice === NEW && (key !== null ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-accent/20 bg-accent/5 p-2.5">
          <p className="text-[11px] leading-relaxed text-text-dim">
            Register this public key with your git host — as a deploy key for the repo, or on your
            account — then continue.
          </p>
          <PublicKey publicKey={key.publicKey} wrap />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            aria-label="Credential name"
            value={shownName}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            className={INPUT}
          />
          {kind === 'https' ? (
            <input
              aria-label="Token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="token"
              className={INPUT}
            />
          ) : (
            <button
              type="button"
              onClick={() => void generate()}
              disabled={busy !== null || shownName.trim() === ''}
              className={BUTTON}
            >
              {busy === 'generate' ? 'Generating…' : 'Generate key'}
            </button>
          )}
        </div>
      ))}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className={BUTTON}>
            Cancel
          </button>
        )}
        <button type="submit" disabled={!ready} className={BUTTON}>
          {busy === 'submit' ? `${actionLabel}…` : actionLabel}
        </button>
      </div>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </form>
  )
}

/** An SSH public key with a Copy button — the whole of what there is to
 *  show of a key. `wrap` shows it in full rather than one truncated line. */
export function PublicKey({ publicKey, wrap = false }: { publicKey: string; wrap?: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false)
  // A truncated key can be expanded in place, to read or select by hand.
  const [shown, setShown] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(publicKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="shrink-0 text-[11px] text-text-dim">Public key:</span>
      <code
        title={publicKey}
        className={`min-w-0 flex-1 select-all font-mono text-[11px] text-text-faint ${wrap || shown ? 'break-all' : 'truncate'}`}
      >
        {publicKey}
      </code>
      <span className="flex shrink-0">
        {!wrap && (
          <button type="button" onClick={() => setShown((s) => !s)} className={TEXT_BUTTON}>
            {shown ? 'Hide' : 'View'}
          </button>
        )}
        <button type="button" onClick={copy} className={TEXT_BUTTON}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    </div>
  )
}

/** The host key an SSH assignment trusted on first use, for the user to
 *  compare against the fingerprints the host publishes. */
export function TrustedHostKey({ entry }: { entry: string }): JSX.Element {
  return (
    <p className="break-all font-mono text-[11px] text-text-faint">
      <span className="font-sans text-text-dim">Host key trusted: </span>{entry}
    </p>
  )
}
