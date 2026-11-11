import { InvalidArgumentError, type Command } from 'commander'
import { FULL_COMMIT_PATTERN } from '@yaac/shared/steps'
import type { RepoStart } from '@yaac/shared/types'

/**
 * What a create-shaped command starts with (docs/project-repos.md): which
 * of the project's repos, each one's start, whether a lone repo sits in a
 * folder of its own, and where the agent runs. Shared by `workspace create`
 * (queued or not) and `routine create|edit`.
 */
export interface SelectionOptions {
  /** From each `--repo <dir>[@<branch or full commit>]`. */
  repo?: RepoStart[]
  /** False for `--no-repos`. */
  repos?: boolean
  nested?: boolean
  cwd?: string
  /** Shorthand for the start of a selection of exactly one repo. */
  branch?: string
  commit?: string
}

/**
 * Commander's parser for a repeated `--repo`: a repo's folder in the
 * project (or its id), then `@` and the branch its checkout starts at, or a
 * full commit in the branch's place; without one it starts at the remote's
 * default branch.
 */
export function repoArg(value: string, previous: RepoStart[] = []): RepoStart[] {
  const at = value.indexOf('@')
  const repo = at < 0 ? value : value.slice(0, at)
  const start = at < 0 ? undefined : value.slice(at + 1)
  if (repo === '' || start === '') throw new InvalidArgumentError('expected <dir> or <dir>@<branch>')
  return [...previous, {
    repo,
    ...(start === undefined ? {} : FULL_COMMIT_PATTERN.test(start) ? { commit: start } : { branch: start }),
  }]
}

/** Add the selection options to a create-shaped command. */
export function selectionOptions(cmd: Command, each: string): Command {
  return cmd
    .option('--repo <dir[@branch]>', `A repo of the project ${each} starts with, by its folder (see \`yaac project repo list\`), at this branch, or with a full commit in the branch's place at that commit; repeatable. Without any, the repos the project's last create included, each at its default branch`, repoArg)
    .option('--no-repos', `${each[0].toUpperCase()}${each.slice(1)} starts with no repos: an empty workspace dir`)
    .option('--nested', 'Put a lone repo in a folder named for it instead of at the workspace root; several repos always sit in folders. Defaults to the project\'s last choice')
    .option('--no-nested', 'Put a lone repo at the workspace root')
    .option('--cwd <dir>', 'Where the agent starts: a selected repo\'s folder, or . for the workspace root. Defaults to the project\'s last choice where that repo is selected, else a lone repo, else the root')
}

/** The selection the options name, in the shape the routes take; a field
 *  left out is resolved by the server from what the project last used. */
export function selectionOf(opts: SelectionOptions): {
  repos?: RepoStart[]
  nested?: boolean
  cwd?: string
  branch?: string
  commit?: string
} {
  if (opts.commit !== undefined && opts.branch !== undefined) throw new Error('Give --branch or --commit, not both.')
  if (opts.repos === false) {
    const stray = (['repo', 'branch', 'commit'] as const).find((o) => opts[o] !== undefined)
      ?? (opts.nested === true ? 'nested' : undefined)
    if (stray !== undefined) throw new Error(`--no-repos starts with no checkout, so it does not take --${stray}.`)
  }
  return {
    ...(opts.repos === false ? { repos: [] } : opts.repo !== undefined ? { repos: opts.repo } : {}),
    ...(opts.nested !== undefined ? { nested: opts.nested } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
    ...(opts.commit !== undefined ? { commit: opts.commit } : {}),
  }
}
