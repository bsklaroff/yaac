import { useState, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { remoteKind } from '#components/GitCredentialPicker'
import { WarningIcon } from '#lib/icons'
import {
  checkRepoPushAccess, moveRepoToUpstream, moveRepoToYaac, previewRepoHost, previewRepoMove, refreshRepos,
  removeRepoUpstream, setRepoReadOnly, setRepoUpstream, useRepos,
} from '#lib/repoApi'
import { useUiStore } from '#lib/store'
import { useAuthList } from '#lib/useAuthList'
import type { RepoSummary, UpstreamMoveBranch } from '@yaac/shared/types'
import { YButton, YCheckbox, YConfirm, YInput, YSectionLabel, YSelect } from '#ui'

/*
 * A repo's fork settings (docs/repo-forks.md): the warning shown where a
 * repo's pushes are refused, whether it is read-only, its upstream, and
 * the moves onto yaac and back onto the upstream.
 */

/** A remote as a sentence names it: `acme/tool` for a git host's URL. */
function shortRemote(remoteUrl: string): string {
  return remoteUrl.replace(/^[a-z+]+:\/\/([^@/]*@)?[^/]+\//, '').replace(/^[^@/]*@[^:]+:/, '').replace(/\.git$/, '')
}

/**
 * The warning on a repo whose credential was refused a push and that is
 * not read-only, wherever the repo is shown, with the ways out. Nothing
 * converts the repo on its own: a lost push right is as often an expired
 * token as a changed permission. `owned` hides the ways out from anyone
 * but the repo's owner.
 */
export function PushRefusedWarning({ repoId, remoteUrl, owned }: { repoId: string; remoteUrl: string; owned: boolean }): JSX.Element {
  const queryClient = useQueryClient()
  const openSettings = useUiStore((s) => s.openSettings)
  const act = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => refreshRepos(queryClient),
  })
  return (
    <div role="note" aria-label="Pushes refused"
      className="flex flex-col gap-1.5 border-l-2 border-warning bg-warning-soft px-3 py-2 text-sm leading-relaxed text-muted">
      <p className="flex items-center gap-2">
        <WarningIcon size={14} aria-hidden className="shrink-0 text-warning" />
        Pushes to {shortRemote(remoteUrl)} are refused.
      </p>
      {owned && (
        <div className="flex flex-wrap items-center gap-2">
          <MoveToYaac repoId={repoId} remoteUrl={remoteUrl} />
          <YButton size="sm" variant="secondary" disabled={act.isPending}
            onClick={() => act.mutate(() => setRepoReadOnly(repoId, true))}>
            Make read-only
          </YButton>
          <YButton size="sm" variant="secondary" onClick={() => openSettings('repos', undefined, repoId)}>
            Assign another credential
          </YButton>
          <YButton size="sm" variant="ghost" disabled={act.isPending}
            onClick={() => act.mutate(() => checkRepoPushAccess(repoId))}>
            {act.isPending ? 'Checking…' : 'Check again'}
          </YButton>
        </div>
      )}
      {act.error && <p className="text-danger">{act.error.message}</p>}
    </div>
  )
}

/**
 * Move a repo on a git host onto yaac, behind a confirmation naming the
 * workspaces it stops, read when the dialog opens. The remote it leaves
 * becomes its upstream.
 */
export function MoveToYaac({ repoId, remoteUrl }: { repoId: string; remoteUrl: string }): JSX.Element {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const preview = useQuery({
    queryKey: ['repo-host', repoId],
    queryFn: () => previewRepoHost(repoId),
    enabled: open,
    staleTime: 0,
  })
  const move = useMutation({
    mutationFn: () => moveRepoToYaac(repoId),
    onSuccess: async () => { setOpen(false); await refreshRepos(queryClient) },
  })
  const stopping = preview.data?.projects.flatMap((p) => p.workspaces.map((w) => `${w.slice(0, 8)} in ${p.name}`)) ?? []
  return (
    <>
      <YButton size="sm" onClick={() => { move.reset(); setOpen(true) }}>Move to yaac…</YButton>
      <YConfirm
        open={open}
        onOpenChange={setOpen}
        title={`Move ${shortRemote(remoteUrl)} to yaac?`}
        description={'yaac then hosts the repo, and workspaces push there. '
          + `${remoteUrl} becomes its upstream, which workspaces fetch as upstream/* and never push. `
          + (preview.isPending ? 'Every running workspace with a checkout of it stops first.'
            : stopping.length === 0 ? 'No running workspace has a checkout of it.'
              : `These running workspaces stop first, keeping their checkouts: ${stopping.join(', ')}.`)}
        confirmLabel="Move"
        destructive={false}
        busy={move.isPending || preview.isPending}
        {...(move.error || preview.error ? { error: (move.error ?? preview.error)?.message } : {})}
        onConfirm={() => move.mutate()}
      />
    </>
  )
}

/** Whether no workspace pushes to a repo, in any project. */
export function RepoReadOnly({ repo }: { repo: RepoSummary }): JSX.Element {
  const queryClient = useQueryClient()
  const set = useMutation({
    mutationFn: (enabled: boolean) => setRepoReadOnly(repo.id, enabled),
    onSuccess: () => refreshRepos(queryClient),
  })
  return (
    <div>
      <YCheckbox checked={repo.readOnly} disabled={set.isPending} onCheckedChange={(on) => set.mutate(on)}>
        Read-only: workspaces fetch it and never push, in every project
      </YCheckbox>
      {set.error && <p className="mt-1 text-sm text-danger">{set.error.message}</p>}
    </div>
  )
}

const BY_URL = 'url'

/**
 * A repo's upstream, the repo its history comes from: one of the owner's
 * other repos, or a remote recorded without a clone, read with one of
 * their credentials or anonymously. Removing it drops `upstream/*`.
 */
export function RepoUpstream({ repo }: { repo: RepoSummary }): JSX.Element {
  const queryClient = useQueryClient()
  const repos = useRepos() ?? []
  const credentials = useAuthList()?.gitCredentials ?? []
  const [editing, setEditing] = useState(false)
  const [pick, setPick] = useState(BY_URL)
  const [url, setUrl] = useState('')
  const [credentialId, setCredentialId] = useState('')
  const current = repos.find((r) => r.id === repo.upstreamRepoId)
  const offered = repos.filter((r) => r.id !== repo.id && r.owner === repo.owner && r.deleted === undefined)
  const kind = remoteKind(url.trim())
  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => { setEditing(false); await refreshRepos(queryClient) },
  })
  const submit = (): void => change.mutate(() => setRepoUpstream(repo.id, pick === BY_URL
    ? { remoteUrl: url.trim(), ...(credentialId !== '' ? { credentialId } : {}) }
    : { repoId: pick }))

  return (
    <div>
      <p className="text-sm leading-relaxed text-subtle">
        {current === undefined
          ? 'No upstream. Give it one to see a fork\'s source as upstream/* in its workspaces.'
          : <>A fork of <span className="font-mono text-text">{current.hosted ? `repo ${current.id.slice(0, 8)}` : current.remoteUrl}</span>.
            Workspaces fetch it as upstream/* and never push to it.</>}
      </p>
      {current?.upstreamFetchError !== undefined && (
        <p className="mt-1 text-sm text-warning">Its last fetch failed: {current.upstreamFetchError}</p>
      )}
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <YSelect aria-label="Upstream" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value={BY_URL}>A remote URL…</option>
            {offered.map((r) => <option key={r.id} value={r.id}>{r.hosted ? `repo ${r.id.slice(0, 8)} (hosted by yaac)` : r.remoteUrl}</option>)}
          </YSelect>
          {pick === BY_URL && (
            <>
              <YInput aria-label="Upstream URL" value={url} onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo.git" className="font-mono" />
              <YSelect aria-label="Upstream credential" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                <option value="">No credential (a public https remote)</option>
                {credentials.filter((c) => c.kind === kind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </YSelect>
            </>
          )}
          <div className="flex items-center gap-2">
            <YButton size="sm" variant="primary" disabled={change.isPending || (pick === BY_URL && url.trim() === '')} onClick={submit}>
              {change.isPending ? 'Setting…' : 'Set upstream'}
            </YButton>
            <YButton size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</YButton>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <YButton size="sm" variant="secondary" onClick={() => setEditing(true)}>{current === undefined ? 'Set upstream…' : 'Change…'}</YButton>
          {current !== undefined && (
            <YButton size="sm" variant="ghost" disabled={change.isPending} onClick={() => change.mutate(() => removeRepoUpstream(repo.id))}>
              Remove upstream
            </YButton>
          )}
        </div>
      )}
      {change.error && <p className="mt-1 text-sm text-danger">{change.error.message}</p>}
    </div>
  )
}

/** The upstream GitHub said a just-added repo is a fork of, to set or
 *  dismiss (docs/repo-forks.md "Remote forks"). */
export function UpstreamSuggestion({ repoId }: { repoId: string }): JSX.Element | null {
  const queryClient = useQueryClient()
  const url = useUiStore((s) => s.upstreamSuggestions[repoId])
  const suggest = useUiStore((s) => s.suggestUpstream)
  const set = useMutation({
    mutationFn: (remoteUrl: string) => setRepoUpstream(repoId, { remoteUrl }),
    onSuccess: async () => { suggest(repoId, null); await refreshRepos(queryClient) },
  })
  if (url === undefined) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
      <span>GitHub says this repo is a fork of <span className="font-mono">{shortRemote(url)}</span>.</span>
      <YButton size="sm" disabled={set.isPending} onClick={() => set.mutate(url)}>Set as upstream</YButton>
      <YButton size="sm" variant="ghost" onClick={() => suggest(repoId, null)}>Dismiss</YButton>
      {set.error && <span className="text-danger">{set.error.message}</span>}
    </div>
  )
}

/** What a branch that needs a choice gets: pushed, pushed under another
 *  name, or left behind. */
type BranchChoice = { kind: 'push'; as?: string } | { kind: 'leave' }

/**
 * Move a fork back onto its upstream once its owner can push there
 * (docs/repo-forks.md "Moving back to the upstream"). The preview fetches
 * both remotes and lists every branch that needs a choice, with what
 * depends on it; the move starts once each has one.
 */
export function MoveToUpstream({ repo, upstreamUrl }: { repo: RepoSummary; upstreamUrl: string }): JSX.Element {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [choices, setChoices] = useState<Record<string, BranchChoice>>({})
  const preview = useQuery({
    queryKey: ['repo-move-upstream', repo.id],
    queryFn: () => previewRepoMove(repo.id, true),
    enabled: open,
    staleTime: 0,
  })
  const move = useMutation({
    mutationFn: () => moveRepoToUpstream(repo.id, {
      push: Object.entries(choices).flatMap(([branch, c]) =>
        (c.kind === 'push' ? [{ branch, ...(c.as !== undefined && c.as !== '' ? { as: c.as } : {}) }] : [])),
      leave: Object.entries(choices).flatMap(([branch, c]) => (c.kind === 'leave' ? [branch] : [])),
    }),
    onSuccess: async () => { setOpen(false); await refreshRepos(queryClient) },
  })
  const needChoice = (preview.data?.toUpstream?.branches ?? []).filter((b) => b.state !== 'same' && b.state !== 'upstream-only')
  const all = (kind: 'push' | 'leave'): void => setChoices(Object.fromEntries(needChoice.map((b) =>
    [b.branch, kind === 'push' && b.state !== 'diverged' ? { kind: 'push' } : { kind: 'leave' }])))
  const unchosen = needChoice.some((b) => choices[b.branch] === undefined)

  return (
    <div>
      <YSectionLabel>Move to upstream</YSectionLabel>
      <p className="mt-0.5 text-sm leading-relaxed text-subtle">
        Once you can push to {upstreamUrl}, make it this repo&apos;s remote: the branches you pick are pushed there, and
        the rest stay where the fork is.
      </p>
      <YButton size="sm" className="mt-2" onClick={() => { setChoices({}); move.reset(); setOpen(true) }}>Move to upstream…</YButton>
      <YConfirm
        open={open}
        onOpenChange={setOpen}
        title={`Move to ${shortRemote(upstreamUrl)}?`}
        description={`${preview.data?.runningWorkspaces ?? 'Every'} running workspace(s) with a checkout of this repo stop first, `
          + 'whoever owns them. Nothing is forced, so a push only adds a branch or fast-forwards one.'
          + ((preview.data?.sharedWith.length ?? 0) > 0 ? ` Its sharing with ${preview.data?.sharedWith.join(', ')} ends.` : '')}
        confirmLabel="Move"
        destructive={false}
        blocked={unchosen}
        busy={move.isPending || preview.isPending}
        {...(move.error || preview.error ? { error: (move.error ?? preview.error)?.message } : {})}
        onConfirm={() => move.mutate()}
      >
        {needChoice.length > 0 && (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex gap-2">
              <YButton size="sm" variant="secondary" onClick={() => all('push')}>Push all</YButton>
              <YButton size="sm" variant="secondary" onClick={() => all('leave')}>Leave all</YButton>
            </div>
            {needChoice.map((b) => (
              <BranchRow key={b.branch} branch={b} choice={choices[b.branch]}
                onChoose={(c) => setChoices((all) => ({ ...all, [b.branch]: c }))} />
            ))}
          </div>
        )}
      </YConfirm>
    </div>
  )
}

/** One branch that needs a choice, with what depends on it. */
function BranchRow({ branch, choice, onChoose }: {
  branch: UpstreamMoveBranch
  choice: BranchChoice | undefined
  onChoose: (choice: BranchChoice) => void
}): JSX.Element {
  const d = branch.dependents
  const depends = [
    d.running > 0 && `${d.running} running`, d.stopped > 0 && `${d.stopped} stopped`,
    d.queued > 0 && `${d.queued} queued`, d.routines > 0 && `${d.routines} routine(s)`,
  ].filter(Boolean).join(', ')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-text">{branch.branch}</span>
      <span className="text-subtle">{branch.state === 'fork-only' ? 'only the fork has it' : branch.state}</span>
      {depends !== '' && <span className="text-subtle">({depends})</span>}
      <YSelect
        aria-label={`What to do with ${branch.branch}`}
        value={choice?.kind ?? ''}
        onChange={(e) => onChoose(e.target.value === 'push' ? { kind: 'push' } : { kind: 'leave' })}
        className="w-32"
      >
        <option value="" disabled>Choose…</option>
        {branch.state !== 'diverged' && <option value="push">Push</option>}
        <option value="leave">Leave behind</option>
      </YSelect>
      {choice?.kind === 'push' && (
        <YInput aria-label={`Push ${branch.branch} as`} value={choice.as ?? ''} placeholder={branch.branch}
          onChange={(e) => onChoose({ kind: 'push', as: e.target.value })} className="w-40 font-mono" />
      )}
    </div>
  )
}
