/**
 * The review diff for a workspace: everything the agent changed since it
 * forked from its base branch (committed, staged, unstaged, untracked), as
 * a shell script run inside the workspace (the workspace's git metadata
 * names its own paths, so the server cannot run git on it) plus a parser
 * for its output. Only the checkout and scratch paths differ by driver.
 * The same run also says how far HEAD is from the base branch and, when
 * asked, lists the checkout for the file explorer, so the webapp polls one
 * thing per workspace.
 *
 * The script runs `git add -A` into a private index (GIT_INDEX_FILE), then
 * diffs the base tree against that index. This captures the whole working
 * tree without touching the agent's real index.
 *
 * Which stages each file's changes sit in comes from trees, so the working
 * tree is walked once (by `add -A`) however many stages are read: HEAD; the
 * agent's index, written as a tree from a scratch copy so the real one is
 * never written; and the private index's tree. `staged` is HEAD → the
 * agent's tree, `modified` and `untracked` are the agent's tree → the
 * working tree's (a file the agent's index lacks is untracked), and
 * `committed`, base → HEAD, is cached by that pair, since it changes only
 * when HEAD or the base moves.
 *
 * The webapp polls it, so:
 *  - The private index lives at a stable path and is reused, keeping git's
 *    stat cache so each poll does not re-hash every file.
 *  - Everything after `add -A` is a function of four trees (base, HEAD, the
 *    agent's index, the working tree), and reading their objects is what
 *    costs on a large changeset over a network filesystem. Each section is
 *    cached beside the private index under the trees it was read from, and
 *    the server holds each workspace's last reading, so a poll where only
 *    a few files changed reads just those (see readWorkspaceChanges).
 *  - The listing is held too, and printed again only when a path was
 *    added, deleted or retyped since the held one, so an unchanged checkout
 *    costs no transfer however many files it has.
 *  - A failed run must not look like an empty one: the script prints a
 *    completion marker only after every command behind the file list
 *    succeeds, so a partial run is an error, not "No changes".
 *  - An exec's output is capped (streamd's at 4 MiB), so a run whose output
 *    is larger leaves it in a file that the server fetches in pages.
 */

import { workspaceDriver } from '#drivers/driver'
import { ServerError } from '@yaac/shared/errors'
import { DIFF_CUT_LINE } from '@yaac/shared/types'
import type { ChangeStage, ChangeStatus, LineCounts, WorkspaceChange, WorkspaceDiff } from '@yaac/shared/types'

/**
 * The changes script's exit code for "no diff base": the ref does not
 * resolve in the checkout or shares no history with it. The caller decides
 * whose fault it is: an explicit `base` is the user's mistake; the default
 * base failing is ours.
 */
export const CHANGES_BASE_UNRESOLVED = 4

/**
 * The changes script's exit code for "an earlier run is still going": one
 * whose exec timed out can outlive it and hold the private index, so the
 * caller should try again shortly.
 */
export const CHANGES_BUSY = 7

/**
 * What a changes read takes besides the diff. `listing` asks for the
 * checkout's paths too: `paths` comes from the index the diff already built, while
 * `full` adds the ignored entries and untracked folders, which walk the
 * working tree again.
 */
export interface ChangesRequest {
  base?: string
  /** The branch the workspace forked from, used when `base` is unset. */
  defaultBase?: string
  /** Include the unified diff body. */
  diff: boolean
  listing?: 'paths' | 'full'
}

/** A changes read's answer, before `getWorkspaceChanges` adds what it reads
 *  on the server. */
export interface ChangesReading {
  changes: WorkspaceDiff
  /** The ref the base was found on (`origin/main`, `main`) and HEAD's
   *  distance from it; null when no fork point was found. */
  ref: { name: string; ahead: number; behind: number } | null
  listing?: {
    /** Every file in the working tree that git does not ignore. */
    paths: string[]
    /** The entries of `paths` that are symlinks. */
    links: string[]
    conflicted: string[]
    /** `full` only: ignored files, and wholly ignored folders as `dir/`. */
    ignored?: string[]
    /** `full` only: untracked folders, without the trailing slash. */
    untrackedDirs?: string[]
  }
  /** How long the read took in the workspace. */
  readMs: number
}

/** Where one workspace's diff is computed, as paths inside the workspace. */
export interface ChangesLocation {
  /** The checkout to diff. */
  workspaceDir: string
  /** The private index file: a stable path (see the module comment), never
   *  the agent's real index. */
  indexFile: string
}

/** Cap the returned diff body so a huge changeset can't blow up the response;
 *  the file list (from numstat) stays complete. */
const MAX_DIFF_BYTES = 1_000_000

/** In-workspace cap on the diff body, 2× the response cap. It only stops a
 *  huge diff from being buffered and sent whole; the server's cap trips
 *  first and decides `truncated`. */
const WORKSPACE_DIFF_CAP_BYTES = MAX_DIFF_BYTES * 2

/** The most of one file's diff the body carries, so one huge file cannot
 *  use up the caps above and leave every file after it with no diff. */
const MAX_FILE_DIFF_BYTES = MAX_DIFF_BYTES / 4

/**
 * The shell function `capped <command...>`: the diff body the command
 * prints, bounded by whole lines in bytes (`LC_ALL=C`), failing when the
 * command failed. It skips the first `$s` lines, then caps each file's part
 * at `$p`, ending a cut one with the cut line, and the whole at `$t`,
 * exiting there so git stops; git then dies of SIGPIPE (141), or xargs
 * reports its child killed (125), and either is a whole answer. A cut
 * between two files' parts prints no cut line, since no part was cut. A
 * read that skips into a line of `$p` bytes or more prints its first `$p`
 * bytes as the line, then the cut line, so the next read goes on from the
 * line after it.
 */
function cappedFn(errFile: string): string {
  const awk = '/^diff --git /{n=0} s>0{s--; next} n>p{next} {l=length($0)+1} '
    + 'n&&n+l>p{print c; n=p+1; next} b&&b+l>t{if(n)print c; exit} '
    + 'l>p{print substr($0,1,p); print c; n=p+1; next} {print; n+=l; b+=l}'
  return `capped() { rm -f ${errFile}; { "$@" 2>/dev/null || { r=$?; [ $r -eq 141 ] || [ $r -eq 125 ] || : > ${errFile}; }; } `
    + `| LC_ALL=C awk -v s="$s" -v p="$p" -v t="$t" -v c=${DIFF_CUT_LINE} '${awk}'; [ ! -e ${errFile} ]; }; `
}

const M_COMMITTED = '@@COMMITTED@@'
const M_STAGED = '@@STAGED@@'
const M_MODIFIED = '@@MODIFIED@@'
const M_UNTRACKED = '@@UNTRACKED@@'
/** The paths that changed since the working tree the server holds,
 *  printed when some part of the reading was read only at them. */
const M_CHANGED = '@@CHANGED@@'
const M_NUMSTAT = '@@NUMSTAT@@'
const M_NAMESTATUS = '@@NAMESTATUS@@'
/** Always printed after name-status. The listing's sections follow it,
 *  each NUL-separated and ended by `END`, since a path may hold a newline. */
const M_LISTING = '@@LISTING@@'
const M_PATHS = '@@PATHS@@'
const M_CONFLICTED = '@@CONFLICTED@@'
const M_IGNORED = '@@IGNORED@@'
const M_DIRS = '@@DIRS@@'
const END = '@@END@@'
/** `END` framed by NULs, as a printf format. */
const nulEnd = `\\000${END}\\000`
/** Printed only after every git command feeding the file list succeeded;
 *  see parseChangesOutput. */
const M_OK = '@@OK@@'
const M_DIFF = '@@DIFF@@'
/** Printed instead of the body when `git diff` could not finish it. */
const M_NODIFF = '@@NODIFF@@'

/** A run whose output passes this size leaves it in a file, fetched in
 *  pages of this size: base64 makes a page about 2.8 MB, under streamd's
 *  4 MiB exec output cap. */
export const OUTPUT_PAGE_BYTES = 2 * 1024 * 1024

/** The most paths a delta reads; past this a full read is about as cheap. */
const MAX_DELTA_PATHS = 300

/** Body flags that keep one `diff --git` header per file, whatever the
 *  user's config, so the body splits into per-file chunks. */
const BODY_FLAGS = '--no-ext-diff --submodule=short'

/**
 * Force-adds its arguments that still exist (a link counts, even broken),
 * in one `git add`, and nothing when none do. The names come from the
 * agent's index, so they are literal: `--` alone still lets a name like
 * `:(glob)**` or `*` match every ignored file, credentials included.
 */
const FORCE_ADD = 'for p; do shift; { [ -e "$p" ] || [ -L "$p" ]; } && set -- "$@" "$p"; done; '
  + '[ $# -eq 0 ] || exec git --literal-pathspecs add -f -- "$@"'

/**
 * The script body. Resolves the diff base, stages the working tree into the
 * private index, and prints a numstat per stage, the untracked files, then
 * numstat, name-status and the unified diff, each after a marker (see the
 * module comment for how the stages are read).
 *
 * Args (see buildChangesScript):
 *  - `$1`: a base branch the user picked. Tries `origin/<$1>`, then local
 *    `<$1>`. If neither resolves, exits `CHANGES_BASE_UNRESOLVED` rather than
 *    diffing against the wrong base.
 *  - `$2`: the branch the workspace forked from (e.g. `main`), the default
 *    when `$1` is empty. Tries `origin/<$2>`, local `<$2>`, then
 *    `@{upstream}`.
 *  - `$3`: `diff`, or `nodiff` to skip the diff body, so a caller that
 *    wants only the file list and counts does not pay to ship every line;
 *    or `patch`, no body either, but the changed paths' body on a delta, to
 *    keep the body the server holds current.
 *  - `$4`: empty, `paths` or `full`: which listing to print.
 *  - `$5`-`$9`: the base, HEAD, agent and working trees of the reading the
 *    server holds and its diff settings (`SETTINGS`), or empty; the base is
 *    left empty when the server's base diff does not cover this run (it
 *    wants a body the server lacks).
 *  - `$10`, `$11`: the working tree the server's listing holds the paths
 *    of, and the hash of its ignored entries and untracked folders, or
 *    empty.
 *
 * `$2` is needed because after the agent renames and pushes its branch,
 * `@{upstream}` is that branch's own remote, so the merge base collapses to
 * HEAD and all commits disappear. Local `<$2>` covers a fork branch that
 * was never pushed.
 *
 * `REF` names the ref the base was found on and how far HEAD is behind and
 * ahead of it, for the status bar. `TREES` names HEAD, the agent's tree and
 * the working tree's, and `SETTINGS` hashes what else decides git's diff
 * output: `diff.*` config and every attributes source (`.gitattributes`
 * files, `info/attributes`, `core.attributesFile`), since an attribute can
 * make another file binary or run it through a textconv.
 *
 * Each section is kept in a file beside the private index under a first
 * line naming the trees it was read from and the settings (`cached`):
 * `.committed` (base, HEAD), `.staged` (HEAD, the agent's tree),
 * `.unstaged` (modified and untracked: the agent's tree, the working tree),
 * and `.lists` and `.body` (base, the working tree). A run that wants no
 * body fills only `.lists`.
 *
 * `MODES <staged> <unstaged> <base>` then says how each part the server can
 * hold is printed: `same` prints nothing, as the server's copy still
 * applies; `delta` prints it read only at the `CHANGED` paths, those that
 * differ between the held working tree and this one; `full` prints it all,
 * from the files or from git. Staged has no delta, since editing a file
 * never moves it. Nothing held counts once the settings differ.
 *
 * The listing's paths come from the private index after `add -A`, so they
 * cost no second walk: every file git does not ignore, links marked by
 * their mode. Ignored entries and untracked folders do walk the tree, so
 * only `full` reads them. Conflicts come from the agent's index. `MODES`
 * then adds two words, `-` when no listing was asked for: the paths are
 * `same` when no path was added, deleted or retyped since the held working
 * tree, and the ignored entries and untracked folders `same` when their
 * hash (`EXTRAS`) matches the held one. Only a `full` part is printed.
 *
 * With no fork point, a HEAD that shares history with some origin branch
 * is diffed against itself and prints `FORK 0`: only uncommitted work
 * appears, and callers must not present that as "nothing changed". A HEAD
 * that shares none (an empty repo's first commits, or none yet) is diffed
 * against the empty tree, so all of it counts as added.
 *
 * Every command feeding the file list is status-checked, and `@@OK@@` is
 * printed only after all succeed. The diff body comes last, bounded per
 * file and in total by `capped`. Past a file's cap git still writes the
 * rest of that file's diff, which is read and dropped. A `git diff` that
 * fails before the cap (a textconv program that is missing) prints
 * `NODIFF` instead, so the file list still stands and the failed body is
 * neither cached nor shown as the whole diff.
 *
 * The output goes to a file of this run's own. Up to `OUTPUT_PAGE_BYTES`
 * it is printed; past that, only `PAGED <pid> <bytes>`, and the file stays
 * for the server to page through until the next run clears it. Only the
 * end of stderr is passed on, since a warning per file could pass the cap
 * too.
 */
function changesScript(loc: ChangesLocation): string {
  const i = loc.indexFile
  return `cd ${loc.workspaceDir} 2>/dev/null || exit 3; `
  // The run waits and retries only until 10 seconds after it starts, half
  // the server's exec timeout, so the work after either still fits.
  + 'd=$(($(date +%s)+10)); '
  // One run at a time per workspace, even past the server's mutex: a run
  // whose exec timed out may still be going in the workspace, holding the
  // private index. The run lock holds its pid, made by an atomic `ln`. A
  // live holder is waited for (its run warms the index) until the deadline,
  // then the run gives up with CHANGES_BUSY. A dead holder's lock is
  // cleared, and so is one over two minutes old, whose pid may since belong
  // to an unrelated process. A run killed while it waits removes its pid
  // file, and one killed while it holds the lock removes the lock.
  + `lk=${i}.run; trap 'rm -f "$lk.$$"' EXIT; trap 'exit 143' TERM; echo $$ > "$lk.$$"; `
  + 'while ! ln "$lk.$$" "$lk" 2>/dev/null; do '
  + 'p=$(cat "$lk" 2>/dev/null); '
  + 'if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && [ -z "$(find "$lk" -mmin +2 2>/dev/null)" ]; then '
  + `[ $(date +%s) -lt $d ] || exit ${CHANGES_BUSY}; sleep 0.2; `
  + 'else rm -f "$lk"; fi; done; '
  + 'rm -f "$lk.$$"; trap \'rm -f "$lk"\' EXIT; '
  // Holding the run lock, any git lock on the private index, and any seed
  // copy, was left by a killed run.
  + `rm -f ${i}.out.* ${i}.lock ${i}.seed.*; o=${i}.out.$$; ( `
  // An unborn HEAD (an empty repo's checkout) reads as the empty tree.
  + 'e=$(git hash-object -t tree /dev/null) || exit 6; head=$(git rev-parse -q --verify HEAD) || head=$e; '
  + 'ref=; fork=1; '
  + 'unforked() { if git merge-base "$head" $(git for-each-ref --format="%(objectname)" refs/remotes/origin) '
  + '>/dev/null 2>&1; then base=$head; fork=0; else base=$e; fi; }; '
  + 'if [ -n "$1" ]; then '
  + 'for r in "origin/$1" "$1"; do base=$(git merge-base "$r" HEAD 2>/dev/null) && { ref=$r; break; }; done; '
  + `[ -n "$ref" ] || exit ${CHANGES_BASE_UNRESOLVED}; `
  + 'elif [ -n "$2" ]; then '
  + 'for r in "origin/$2" "$2" "@{upstream}"; do base=$(git merge-base "$r" HEAD 2>/dev/null) && { ref=$r; break; }; done; '
  + '[ -n "$ref" ] || unforked; '
  + 'else '
  + 'base=$(git merge-base @{upstream} HEAD 2>/dev/null) && ref=@{upstream} || unforked; '
  + 'fi; '
  + 'printf "BASE %s\\n" "$base"; '
  + 'printf "FORK %s\\n" "$fork"; '
  + '[ "$ref" != "@{upstream}" ] || ref=$(git rev-parse --abbrev-ref "@{upstream}"); '
  + '[ -z "$ref" ] || { n=$(git rev-list --left-right --count "$ref...HEAD" --) && printf "REF %s %s\\n" "$ref" "$n"; }; '
  // `cached <file> <key> <command...>`: the command's output, kept in the
  // file under the key line and the settings. Written through a `.tmp` of
  // this run's own, so neither a killed run nor one still writing after
  // its shell was killed leaves half an entry; a key line that does not
  // match is a miss.
  + 'cached() { f=$1; k="$2 $cf"; shift 2; [ "$(head -n 1 "$f" 2>/dev/null)" = "$k" ] '
  + '|| { rm -f "$f".tmp.*; { echo "$k"; "$@"; } > "$f.tmp.$$" && mv "$f.tmp.$$" "$f"; } || return 1; tail -n +2 "$f"; }; '
  // The agent's index, copied (git swaps it in by rename, so a copy is
  // never half-written) and written as a tree. With a merge conflict it has
  // no tree, and its changes count as modified.
  + `cp "$(git rev-parse --git-path index)" ${i}.agent 2>/dev/null `
  + `&& agent=$(GIT_INDEX_FILE=${i}.agent git write-tree 2>/dev/null) `
  + '|| agent=$(git rev-parse "$head^{tree}") || exit 6; '
  // The stable private index lets git's stat cache make `add -A`
  // incremental across polls.
  + `export GIT_INDEX_FILE=${i}; `
  // A missing private index starts as a copy of the agent's, whose stat
  // data spares `add -A` hashing every file on a workspace's first poll.
  // The copy is made whole before it is moved in, so a killed run never
  // leaves a broken index. `add -A` compares only mtime and size
  // (`core.checkStat=minimal`): the server writes a new checkout's index,
  // and a pod sees other inode numbers, so under the default check every
  // seeded entry would look changed.
  + `seed() { [ -f ${i} ] || { cp ${i}.agent ${i}.seed.$$ && mv ${i}.seed.$$ ${i}; } 2>/dev/null; }; seed; `
  // `stage` writes the working tree into the private index. `--ignore-errors`
  // adds what it can past an entry git cannot index (a nested repo with no
  // commit), exiting 1, so one such entry costs the diff and the listing
  // only that entry. `add -A` skips a tracked file that matches .gitignore
  // (one added with `add -f`), which would then read as deleted, so those
  // the agent's index tracks that are still on disk are force-added.
  // Staging fails when a file is deleted between git listing and adding
  // it, as a branch switch does to many, and leaves the index as it was.
  // So staging is retried with the index kept, each retry costing only
  // what changed, and only an index git cannot read is seeded afresh.
  + 'stage() { { git -c core.checkStat=minimal add -A --ignore-errors || [ $? -eq 1 ]; } '
  + `&& { [ ! -f ${i}.agent ] || GIT_INDEX_FILE=${i}.agent git ls-files -z -c -i --exclude-standard `
  + `| xargs -0 sh -c ${shSingleQuote(FORCE_ADD)} yaac-force-add; }; }; `
  + `until stage; do git ls-files -s >/dev/null 2>&1 || { rm -f ${i}; seed; }; `
  + '[ $(date +%s) -lt $d ] || exit 5; sleep 0.2; done; '
  + 'work=$(git write-tree) || exit 5; '
  + 'printf "TREES %s %s %s\\n" "$head" "$agent" "$work"; '
  // The attributes files come from the private index, so their content
  // costs no read of the working tree.
  + 'cf=$({ git config --get-regexp \'^diff\\.\'; git ls-files -s -- \':(glob)**/.gitattributes\'; '
  + 'cat "$(git rev-parse --git-path info/attributes)" '
  + '"$(git config --path core.attributesFile || echo "${XDG_CONFIG_HOME:-$HOME/.config}/git/attributes")"; } 2>/dev/null '
  + '| git hash-object --stdin) || exit 6; printf "SETTINGS %s\\n" "$cf"; '
  + `printf "${M_COMMITTED}\\n"; cached ${i}.committed "$base $head" git diff --numstat "$base" "$head" || exit 6; `
  + 'staged() { git diff --numstat "$head" "$agent"; }; '
  + `unstaged() { printf "${M_MODIFIED}\\n" && git diff --numstat --no-renames --diff-filter=a "$agent" "$work" `
  + `&& printf "${M_UNTRACKED}\\n" && git diff --name-only --no-renames --diff-filter=A "$agent" "$work"; }; `
  + `lists() { printf "${M_NUMSTAT}\\n" && git diff --numstat "$base" "$work" `
  + `&& printf "${M_NAMESTATUS}\\n" && git diff --name-status "$base" "$work"; }; `
  + `s=0; p=${MAX_FILE_DIFF_BYTES}; t=${WORKSPACE_DIFF_CAP_BYTES}; ${cappedFn(`${i}.err`)}`
  + `body() { capped git diff ${BODY_FLAGS} "$base" "$work"; }; `
  + 'hit() { [ "$(head -n 1 "$1" 2>/dev/null)" = "$2 $cf" ]; }; '
  // `pd`: run git on the changed paths, named literally.
  + `pd() { xargs -0 git --literal-pathspecs "$@" < ${i}.paths; }; `
  // The paths that differ between the held working tree and this one, read
  // from the two trees alone (no file content), when there are few enough
  // to be worth reading one by one.
  + 'hb=$5; hh=$6; ha=$7; hw=$8; [ "$9" = "$cf" ] || { hb=; hh=; ha=; hw=; }; ch=; '
  + `[ -n "$hw" ] && [ "$hw" != "$work" ] && git diff --name-status --no-renames "$hw" "$work" > ${i}.delta 2>/dev/null `
  + `&& [ $(wc -l < ${i}.delta) -le ${MAX_DELTA_PATHS} ] `
  + `&& git diff -z --name-only --no-renames "$hw" "$work" > ${i}.paths && [ $(wc -c < ${i}.paths) -le 32768 ] && ch=1; `
  + 'sm=full; [ "$hh $ha" != "$head $agent" ] || sm=same; '
  // Modified and untracked are read without rename pairing, so any changed
  // path can be read on its own.
  + 'um=full; if [ "$ha $hw" = "$agent $work" ]; then um=same; '
  + `elif [ "$ha" = "$agent" ] && [ -n "$ch" ] && ! hit ${i}.unstaged "$agent $work"; then um=delta; fi; `
  // The base diff can be patched when the base is the same and every
  // changed path is an edit to a file the base has too. Rename pairing
  // needs both sides of a rename in one diff, so an added, deleted or
  // retyped path, or copy detection, takes the full read. Leaves `ns`, the
  // paths' name-status.
  + `bdelta() { [ "$hb" = "$base" ] && [ -n "$ch" ] && ! grep -qv '^M' ${i}.delta `
  + '&& case $(git config diff.renames) in copy*) false;; esac '
  + `&& ns=$(pd diff --name-status --no-renames "$base" "$work" --) && ! printf '%s\\n' "$ns" | grep -q '^[AT]'; }; `
  + 'm=full; if [ "$hb $hw" = "$base $work" ]; then m=same; '
  // The files win over a delta when they hold everything this run prints,
  // but a `patch` run wants the delta's body.
  + `elif ! { [ "$3" != patch ] && hit ${i}.lists "$base $work" && { [ "$3" = nodiff ] || hit ${i}.body "$base $work"; }; } `
  + '&& bdelta; then m=delta; fi; '
  // The listing's paths are a function of the working tree's paths and
  // modes, so an edit leaves them as held. `ls-files` lists every gitlink,
  // so this must see one even when `.gitmodules` says `ignore = all`.
  + 'pm=-; xm=-; [ -z "$4" ] || { pm=full; [ -z "${10}" ] '
  + '|| ! git diff-tree --quiet -r --ignore-submodules=none --diff-filter=ADT "${10}" "$work" || pm=same; }; '
  + `[ "$4" != full ] || { { printf "${M_IGNORED}\\n"; git ls-files -z --others --ignored --exclude-standard --directory `
  + `&& printf '${nulEnd}${M_DIRS}\\n' && git ls-files -z --others --exclude-standard --directory && printf '${nulEnd}'; } `
  + `> ${i}.extras && xh=$(git hash-object --no-filters ${i}.extras) || exit 6; `
  + 'printf "EXTRAS %s\\n" "$xh"; xm=full; [ "$xh" != "${11}" ] || xm=same; }; '
  + 'printf "MODES %s %s %s %s %s\\n" $sm $um $m $pm $xm; '
  + `[ $um != delta ] && [ $m != delta ] || { printf "${M_CHANGED}\\n"; cut -f2- ${i}.delta; }; `
  + `[ $sm = same ] || { printf "${M_STAGED}\\n"; cached ${i}.staged "$head $agent" staged || exit 6; }; `
  + `case $um in delta) printf "${M_MODIFIED}\\n"; pd diff --numstat --no-renames --diff-filter=a "$agent" "$work" -- || exit 6; `
  + `printf "${M_UNTRACKED}\\n"; pd diff --name-only --no-renames --diff-filter=A "$agent" "$work" -- || exit 6;; `
  + `full) cached ${i}.unstaged "$agent $work" unstaged || exit 6;; esac; `
  + `case $m in delta) printf "${M_NUMSTAT}\\n"; pd diff --numstat --no-renames "$base" "$work" -- || exit 6; `
  + `printf "${M_NAMESTATUS}\\n%s\\n" "$ns";; `
  + `full) cached ${i}.lists "$base $work" lists || exit 6;; esac; `
  + `printf "${M_LISTING}\\n"; `
  + `[ $pm != full ] || { printf "${M_PATHS}\\n"; git ls-files -z -s || exit 6; printf '${nulEnd}'; }; `
  + `[ -z "$4" ] || { printf "${M_CONFLICTED}\\n"; { [ ! -f ${i}.agent ] `
  + `|| GIT_INDEX_FILE=${i}.agent git ls-files -z -u; } || exit 6; printf '${nulEnd}'; }; `
  + `[ $xm != full ] || cat ${i}.extras || exit 6; `
  + `printf "${M_OK}\\n"; `
  + `case $m in delta) [ "$3" = nodiff ] || { capped pd diff ${BODY_FLAGS} --no-renames "$base" "$work" -- > ${i}.dbody `
  + `&& { printf "${M_DIFF}\\n"; cat ${i}.dbody; } || printf "${M_NODIFF}\\n"; };; `
  + `full) [ "$3" != diff ] || { cached ${i}.body "$base $work" body > /dev/null `
  + `&& { printf "${M_DIFF}\\n"; tail -n +2 ${i}.body; } || printf "${M_NODIFF}\\n"; };; esac; `
  + `exit 0 ) > $o 2> ${i}.stderr; r=$?; tail -c 4096 ${i}.stderr >&2; `
  + `if [ $(wc -c < $o) -gt ${OUTPUT_PAGE_BYTES} ]; then printf "PAGED %s %s\\n" $$ $(wc -c < $o); `
  + 'else cat $o; rm -f $o; fi; exit $r'
}

/** Single-quote a value for the one shell pass a driver's `exec` applies,
 *  so it stays one literal argv token. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Build the `exec` command tail: `sh -c <script> yaac-changes <base>
 * <defaultBase> <diff|nodiff|patch> <listing> <held trees, settings and
 * listing keys>`. Both
 * branch names are passed as positionals, never interpolated into the
 * script, so any value reaches git as one literal ref (and a bogus one
 * simply fails to resolve). Both empty selects the `@{upstream}` default.
 */
export function buildChangesScript(loc: ChangesLocation, request: ChangesRequest, held?: HeldReading): string {
  return `sh -c ${shSingleQuote(changesScript(loc))} yaac-changes `
    + [request.base, request.defaultBase].map((b) => shSingleQuote((b ?? '').trim())).join(' ')
    + ` ${request.diff ? 'diff' : held?.body && held.base ? 'patch' : 'nodiff'} ${request.listing ?? "''"} `
    + [held?.base, held?.head, held?.agent, held?.work, held?.settings, held?.listing?.work, held?.listing?.extras?.hash]
      .map((t) => shSingleQuote(t ?? '')).join(' ')
}

/** Map a git name-status letter to our ChangeStatus. */
export function statusFromCode(code: string): ChangeStatus {
  switch (code[0]) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'typechange'
    default: return 'modified' // 'M' and anything unexpected
  }
}

/**
 * Resolve git's rename path notation to the destination path:
 * `{old => new}` inline segments and a bare `old => new` both collapse to the
 * "new" side.
 */
export function resolveRenamePath(raw: string): string {
  let s = raw.replace(/\{[^}]*? => ([^}]*?)\}/g, '$1')
  const arrow = s.indexOf(' => ')
  if (arrow !== -1) s = s.slice(arrow + 4)
  return s.trim()
}

/** Parse `git diff --numstat` into per-path add/delete counts (binary = -/-). */
export function parseNumstat(text: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const out = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [addRaw, delRaw, ...rest] = parts
    const path = resolveRenamePath(rest.join('\t'))
    const binary = addRaw === '-' || delRaw === '-'
    out.set(path, {
      additions: binary ? 0 : Number(addRaw) || 0,
      deletions: binary ? 0 : Number(delRaw) || 0,
      binary,
    })
  }
  return out
}

/** A name-status row: the new path, its status, and (for R/C) the old path. */
type NameStatusEntry = { path: string; status: ChangeStatus; oldPath?: string }

/** Parse `git diff --name-status` into {path,status,oldPath?} (rename → new
 *  path; oldPath is the "from" side of an R/C row). */
export function parseNameStatus(text: string): NameStatusEntry[] {
  const out: NameStatusEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const code = parts[0]
    // R/C rows are `R100\told\tnew`; everything else `M\tpath`.
    const renameOrCopy = code[0] === 'R' || code[0] === 'C'
    const path = renameOrCopy ? parts[2] : parts[1]
    if (!path) continue
    const entry: NameStatusEntry = { path, status: statusFromCode(code) }
    if (renameOrCopy && parts[1]) entry.oldPath = parts[1]
    out.push(entry)
  }
  return out
}

/** The entries of a NUL-separated listing section; null when it was not
 *  printed. */
function nulSection(raw: string, marker: string): string[] | null {
  const s = raw.indexOf(`${marker}\n`)
  if (s === -1) return null
  const from = s + marker.length + 1
  const e = raw.indexOf(`\0${END}\0`, from)
  return raw.slice(from, e === -1 ? undefined : e).split('\0').filter(Boolean)
}

/** A line holding one of the line-separated sections' markers. */
const MARKER_LINE = new RegExp(`^(?:${[
  M_COMMITTED, M_STAGED, M_MODIFIED, M_UNTRACKED, M_CHANGED, M_NUMSTAT, M_NAMESTATUS, M_LISTING,
].join('|')})$`, 'gm')

/** The lines after `marker` up to the next marker line; empty when it was
 *  not printed. */
function section(head: string, marker: string): string {
  const s = head.indexOf(`\n${marker}\n`)
  if (s === -1) return ''
  MARKER_LINE.lastIndex = s + marker.length + 2
  return head.slice(MARKER_LINE.lastIndex, MARKER_LINE.exec(head)?.index)
}

type Counts = LineCounts & { binary: boolean }

/** The base diff: numstat, name-status and the unified diff of the base
 *  tree against the working tree, the costliest part of a reading. */
interface BaseDiff {
  numstat: Map<string, Counts>
  nameStatus: NameStatusEntry[]
  /** The unified diff within the in-workspace caps, `whole` unless a
   *  file's part is missing or cut. Unset when no body was read. */
  body?: { text: string; whole: boolean }
}

/** The listing the server holds: the paths, read at working tree `work`,
 *  and the ignored entries and untracked folders, under their hash. */
interface HeldListing {
  work: string
  paths: string[]
  links: string[]
  extras?: { hash: string; ignored: string[]; untrackedDirs: string[] }
}

/**
 * What the server holds of a workspace's last reading: every part a later
 * run can reuse or patch rather than read again, and the trees it was read
 * from (see readWorkspaceChanges). `committed` is left out, as the script
 * reads it from its own cache.
 */
export interface HeldReading extends BaseDiff {
  base: string
  head: string
  agent: string
  work: string
  settings: string
  staged: Map<string, Counts>
  modified: Map<string, Counts>
  untracked: Set<string>
  listing?: HeldListing
}

/**
 * A unified diff split into its files' parts, keyed by path. git prints the
 * parts in name-status order, one `diff --git` header each, but two for a
 * typechange (a deletion, then a creation), so a typechange the cap left
 * one part of has none.
 */
function chunksOf(files: NameStatusEntry[], text: string): Map<string, string> {
  const parts = text ? text.split(/(?=^diff --git )/m) : []
  const chunks = new Map<string, string>()
  let k = 0
  for (const f of files) {
    const n = f.status === 'typechange' ? 2 : 1
    if (k + n > parts.length) break
    chunks.set(f.path, parts.slice(k, k + n).join(''))
    k += n
  }
  return chunks
}

/** Escapes git's C-style quoting of a path uses, besides octal bytes. */
const QUOTED: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/** The bytes of a path as git prints it, unquoted: git orders paths by
 *  these, while a quoted name starts with `"` and would sort first. */
function pathBytes(p: string): Buffer {
  if (!p.startsWith('"')) return Buffer.from(p)
  const out: number[] = []
  for (let k = 1; k < p.length - 1; k++) {
    const oct = p[k] === '\\' ? /^[0-7]{3}/.exec(p.slice(k + 1)) : null
    if (oct) {
      out.push(parseInt(oct[0], 8))
      k += 3
    } else if (p[k] === '\\') {
      k++
      out.push(QUOTED[p[k]] ?? p.charCodeAt(k))
    } else {
      out.push(...Buffer.from(p[k]))
    }
  }
  return Buffer.from(out)
}

/** The unified diff from per-file parts in file order, stopping at the
 *  first file whose part is missing, or once past the cap; not `whole`
 *  when it stopped early or holds a part that was cut. */
function joinChunks(files: NameStatusEntry[], chunks: Map<string, string>): { text: string; whole: boolean } {
  let text = ''
  let bytes = 0
  let whole = true
  for (const [n, f] of files.entries()) {
    const c = chunks.get(f.path)
    if (c === undefined) return { text, whole: false }
    text += c
    bytes += Buffer.byteLength(c)
    if (c.endsWith(`\n${DIFF_CUT_LINE}\n`)) whole = false
    if (bytes >= WORKSPACE_DIFF_CAP_BYTES && n < files.length - 1) return { text, whole: false }
  }
  return { text, whole }
}

/** `held` without the `changed` entries, then with `read`'s. */
function patched<T>(held: Map<string, T>, changed: Set<string>, read: Map<string, T>): Map<string, T> {
  return new Map([...[...held].filter(([p]) => !changed.has(p)), ...read])
}

/**
 * `held` with the paths a delta read replaced by what it read: their
 * numstat, name-status rows and body parts. Every path is an edit to a file
 * both trees and the base have, so no rename pairing changes and the other
 * rows stand. Rows stay in git's order, which is byte order of the path. A
 * delta read without a body leaves none.
 */
function splice(held: BaseDiff, changed: Set<string>, read: BaseDiff): BaseDiff {
  const numstat = patched(held.numstat, changed, read.numstat)
  const nameStatus = [...held.nameStatus.filter((e) => !changed.has(e.path)), ...read.nameStatus]
    .sort((a, b) => Buffer.compare(pathBytes(a.path), pathBytes(b.path)))
  let body: BaseDiff['body']
  if (held.body && read.body) {
    const chunks = chunksOf(held.nameStatus, held.body.text)
    for (const p of changed) chunks.delete(p)
    for (const [p, c] of chunksOf(read.nameStatus, read.body.text)) chunks.set(p, c)
    body = joinChunks(nameStatus, chunks)
  }
  return { numstat, nameStatus, ...(body ? { body } : {}) }
}

/**
 * Parse the script's output. name-status gives the file list and statuses;
 * numstat gives the counts. The diff body is capped at `maxDiffBytes`.
 *
 * Throws when the `@@OK@@` marker is missing, since the run then failed
 * partway and an empty file list would falsely read as "No changes".
 */
export function parseChangesOutput(raw: string, maxDiffBytes = MAX_DIFF_BYTES): Omit<ChangesReading, 'readMs'> {
  return readRun(raw, undefined, maxDiffBytes).reading
}

/**
 * `parseChangesOutput`, against the reading the run was offered (`held`),
 * whose parts it reuses or patches as `MODES` says. Also returns what the
 * reading came from, for the server to hold.
 */
function readRun(
  raw: string, held: HeldReading | undefined, maxDiffBytes = MAX_DIFF_BYTES,
): { reading: Omit<ChangesReading, 'readMs'>; next: HeldReading } {
  const ok = raw.indexOf(`${M_OK}\n`)
  if (ok === -1) {
    throw new Error('workspace changes: script produced no completion marker (partial or failed run)')
  }
  // Everything but the diff body comes before the marker; the body is file
  // content, so nothing else is looked for in it.
  const head = raw.slice(0, ok)
  const base = /^BASE (.*)$/m.exec(head)?.[1].trim() ?? ''
  const [headTree = '', agent = '', work = ''] = /^TREES (.*)$/m.exec(head)?.[1].trim().split(' ') ?? []
  const settings = /^SETTINGS (.*)$/m.exec(head)?.[1].trim() ?? ''
  // FORK 0: no fork point, diffed against HEAD, so commits are missing.
  const baseResolved = /^FORK 0$/m.exec(head) === null
  const [stagedMode, unstagedMode, baseMode, pathsMode, extrasMode] = /^MODES (\w+) (\w+) (\w+) (\S+) (\S+)$/m
    .exec(head)?.slice(1) ?? []
  if ((!held && [stagedMode, unstagedMode, baseMode].some((m) => m === 'same' || m === 'delta'))
    || (pathsMode === 'same' && !held?.listing) || (extrasMode === 'same' && !held?.listing?.extras)) {
    throw new Error('workspace changes: the run reused a reading this server does not hold')
  }
  const changed = new Set(section(head, M_CHANGED).split('\n').filter(Boolean))

  const staged = stagedMode === 'same' ? held!.staged : parseNumstat(section(head, M_STAGED))
  let modified = parseNumstat(section(head, M_MODIFIED))
  let untracked = new Set(section(head, M_UNTRACKED).split('\n').filter(Boolean))
  if (unstagedMode === 'same') {
    ({ modified, untracked } = held!)
  } else if (unstagedMode === 'delta') {
    modified = patched(held!.modified, changed, modified)
    untracked = new Set([...[...held!.untracked].filter((p) => !changed.has(p)), ...untracked])
  }

  // The marker is printed only when the body was asked for and not held.
  const d = raw.indexOf(`${M_DIFF}\n`, ok)
  const text = d === -1 ? undefined : raw.slice(d + M_DIFF.length + 1).replace(/^\n/, '')
  let diff: BaseDiff = held!
  if (baseMode !== 'same') {
    const nameStatus = parseNameStatus(section(head, M_NAMESTATUS))
    diff = {
      numstat: parseNumstat(section(head, M_NUMSTAT)),
      nameStatus,
      ...(text !== undefined ? { body: joinChunks(nameStatus, chunksOf(nameStatus, text)) } : {}),
    }
    if (baseMode === 'delta') diff = splice(held!, changed, diff)
  }

  const byStage: [ChangeStage, Map<string, LineCounts>][] = [
    ['committed', parseNumstat(section(head, M_COMMITTED))],
    ['staged', staged],
    ['modified', modified],
  ]
  const files: WorkspaceChange[] = diff.nameStatus.map(({ path, status, oldPath }) => {
    const { additions, deletions, binary } = diff.numstat.get(path) ?? { additions: 0, deletions: 0, binary: false }
    const stages: WorkspaceChange['stages'] = {}
    for (const [stage, counts] of byStage) {
      const c = counts.get(path)
      if (c) stages[stage] = { additions: c.additions, deletions: c.deletions }
    }
    if (untracked.has(path)) stages.untracked = { additions, deletions }
    const change: WorkspaceChange = { path, status, additions, deletions, binary, stages }
    if (oldPath) change.oldPath = oldPath
    return change
  })

  // Measure bytes, not UTF-16 code units: the script's caps are in bytes,
  // so comparing `.length` could report a diff the script already cut as
  // `truncated: false`.
  // A body that failed is shown as cut short to nothing, and not held.
  const failed = raw.includes(`${M_NODIFF}\n`, ok)
  const body = failed ? { text: '', whole: false } : diff.body
  const truncated = body !== undefined && (!body.whole || Buffer.byteLength(body.text) > maxDiffBytes)
  const shown = body && cutDiff(body.text, maxDiffBytes)

  // `REF <ref> <behind>\t<ahead>`: rev-list counts the left side first.
  const refMatch = /^REF (\S+) (\d+)\s+(\d+)$/m.exec(head)
  const ref = refMatch ? { name: refMatch[1], behind: Number(refMatch[2]), ahead: Number(refMatch[3]) } : null

  let listing: ChangesReading['listing']
  let heldListing = held?.listing
  if (pathsMode !== undefined && pathsMode !== '-') {
    let { paths, links } = heldListing ?? { paths: [], links: [] }
    if (pathsMode === 'full') {
      // `<mode> <object> <stage>\t<path>`; a link's mode is 120000.
      const entries = (nulSection(head, M_PATHS) ?? []).map((e) => ({ mode: e.slice(0, 6), path: e.slice(e.indexOf('\t') + 1) }))
      paths = entries.map((e) => e.path)
      links = entries.filter((e) => e.mode === '120000').map((e) => e.path)
    }
    let extras = heldListing?.extras
    if (extrasMode === 'full') {
      extras = {
        hash: /^EXTRAS (\w+)$/m.exec(head)?.[1] ?? '',
        ignored: nulSection(head, M_IGNORED) ?? [],
        untrackedDirs: (nulSection(head, M_DIRS) ?? []).filter((d) => d.endsWith('/')).map((d) => d.slice(0, -1)),
      }
    }
    listing = {
      paths,
      links,
      // One entry per conflict stage.
      conflicted: [...new Set((nulSection(head, M_CONFLICTED) ?? []).map((e) => e.slice(e.indexOf('\t') + 1)))],
      ...(extrasMode !== '-' && extras ? { ignored: extras.ignored, untrackedDirs: extras.untrackedDirs } : {}),
    }
    heldListing = { work, paths, links, ...(extras ? { extras } : {}) }
  }

  return {
    reading: {
      changes: { base, work, baseResolved, files, ...(shown !== undefined ? { diff: shown } : {}), truncated },
      ref,
      ...(listing ? { listing } : {}),
    },
    // `diff` may be `held` itself, so it goes first.
    next: {
      ...diff, base, head: headTree, agent, work, settings, staged, modified, untracked,
      ...(heldListing ? { listing: heldListing } : {}),
    },
  }
}

/** A read of one workspace's changes, queued or running. */
interface ChangesRun {
  request: ChangesRequest
  started: boolean
  result: Promise<ChangesReading>
  /** How many callers still want it; see `runChangesRead`. */
  waiting: number
  abandon: AbortController
}

/** Per workspace, its running read first, then the ones queued behind it. */
const changesRuns = new Map<string, ChangesRun[]>()

const LISTING_RANK = { undefined: 0, paths: 1, full: 2 } as const
const listingRank = (r: ChangesRequest): number => LISTING_RANK[r.listing ?? 'undefined']

/**
 * Run `read` for a workspace's changes, one read at a time, sharing reads
 * between requests. The reads share one git index in the workspace, so
 * they cannot overlap, and each walks the whole working tree, which is
 * slow on a network filesystem. A request against the same base therefore
 * joins a read still queued, widening what it asks for, rather than
 * queuing one of its own. It never joins the running read: that read
 * started before the request arrived, so it could miss an edit the caller
 * just made. Every caller gets back only the parts it asked for.
 *
 * A caller leaves by aborting `signal`. Once every caller of a read has
 * left, the read is abandoned: a queued one never runs, and a running one
 * is stopped, so a poll the webapp has replaced (opening the Changes pane
 * mid-poll) does not hold up the read that replaced it. Either way its
 * callers get an `AbortError`.
 */
export function runChangesRead(
  jobName: string,
  request: ChangesRequest,
  read: (request: ChangesRequest, signal: AbortSignal) => Promise<ChangesReading>,
  signal?: AbortSignal,
): Promise<ChangesReading> {
  const runs = changesRuns.get(jobName) ?? []
  let run = runs.find((r) => !r.started && !r.abandon.signal.aborted
    && (r.request.base ?? '') === (request.base ?? '') && (r.request.defaultBase ?? '') === (request.defaultBase ?? ''))
  if (run) {
    run.request = {
      ...run.request,
      diff: run.request.diff || request.diff,
      listing: listingRank(request) > listingRank(run.request) ? request.listing : run.request.listing,
    }
  }
  if (!run) {
    const before = runs.at(-1)?.result
    const queued = { request, started: false, waiting: 0, abandon: new AbortController() } as ChangesRun
    queued.result = (async () => {
      await before?.catch(() => undefined)
      queued.started = true
      try {
        queued.abandon.signal.throwIfAborted()
        return await read(queued.request, queued.abandon.signal)
      } finally {
        runs.splice(runs.indexOf(queued), 1)
        if (runs.length === 0) changesRuns.delete(jobName)
      }
    })()
    runs.push(queued)
    changesRuns.set(jobName, runs)
    run = queued
  }
  const joined = run
  joined.waiting++
  if (signal) {
    // No reason, so an abandoned read rejects with an `AbortError` whether
    // it was queued or running.
    const leave = (): void => { if (--joined.waiting === 0) joined.abandon.abort() }
    if (signal.aborted) leave()
    else {
      signal.addEventListener('abort', leave, { once: true })
      void joined.result.catch(() => undefined).finally(() => { signal.removeEventListener('abort', leave) })
    }
  }
  return joined.result.then((reading) => answerFor(reading, request))
}

/** `reading` cut down to what `request` asked for. */
function answerFor(reading: ChangesReading, request: ChangesRequest): ChangesReading {
  const { diff: _diff, ...bare } = reading.changes
  const { listing, ...rest } = reading
  const cut = listing && request.listing === 'paths'
    ? { paths: listing.paths, links: listing.links, conflicted: listing.conflicted }
    : request.listing && listing
  return {
    ...rest,
    changes: request.diff ? reading.changes : { ...bare, truncated: false },
    ...(cut ? { listing: cut } : {}),
  }
}

/**
 * `diff` cut to the whole lines within `maxBytes` UTF-8 bytes, as the
 * script cuts it: the part the cut runs through ends in the cut line, which
 * may take it a line past the cap. A line break is never inside a
 * multi-byte character, so no character is split.
 */
function cutDiff(diff: string, maxBytes: number): string {
  const buf = Buffer.from(diff, 'utf8')
  if (buf.length <= maxBytes) return diff
  const end = buf.lastIndexOf(0x0a, maxBytes - 1) + 1
  const kept = buf.subarray(0, end).toString('utf8')
  return buf.subarray(end, end + 11).toString() === 'diff --git ' ? kept : `${kept}${DIFF_CUT_LINE}\n`
}

/** Per workspace, what its last read came from, and when a read last used
 *  it. */
const heldReadings = new Map<string, { held: HeldReading; usedAt: number }>()

/** A held reading no read has used for this long is dropped. */
const HELD_IDLE_MS = 5 * 60_000

/** Drop what the server holds of a workspace's changes, on teardown. */
export function forgetWorkspaceChanges(jobName: string): void {
  heldReadings.delete(jobName)
}

/**
 * A running workspace's diff, and its listing when asked, read inside it.
 * Rejects with `WorkspaceExecError` on failure (`CHANGES_BASE_UNRESOLVED`
 * when a named base has no fork point); a transport failure passes through
 * untranslated, and so does an abort of `signal`, the caller leaving (see
 * `runChangesRead`). The private index sits at a stable path in the scratch dir,
 * so git's stat cache survives between polls.
 *
 * What each read came from is held and offered to the next one, its base
 * diff only when that covers what the read asks for (a body, if wanted).
 * The script then prints, per part, nothing or only the few files changed
 * since, which are spliced in here. The in-workspace caches back this up
 * after a server restart. An output over `OUTPUT_PAGE_BYTES` is fetched
 * in pages, one exec each.
 */
export function readWorkspaceChanges(
  jobName: string, request: ChangesRequest, signal?: AbortSignal,
): Promise<ChangesReading> {
  const driver = workspaceDriver()
  const { workspaceDir, scratchDir } = driver.workspacePaths(jobName)
  return runChangesRead(jobName, request, async (req, abandoned) => {
    const started = Date.now()
    for (const [name, h] of heldReadings) if (started - h.usedAt > HELD_IDLE_MS) heldReadings.delete(name)
    const held = heldReadings.get(jobName)?.held
    // A blank base tree tells the script the base diff is not on offer.
    const offered = held && (!req.diff || held.body ? held : { ...held, base: '' })
    const indexFile = `${scratchDir}/yaac-changes.idx`
    const opts = { timeout: 20_000, maxAttempts: 2, signal: abandoned }
    let { stdout } = await driver.exec(jobName, buildChangesScript({ workspaceDir, indexFile }, req, offered), opts)
    const paged = /^PAGED (\d+) (\d+)\n$/.exec(stdout)
    if (paged) {
      // Base64, since a page may end inside a character.
      const file = shSingleQuote(`${indexFile}.out.${paged[1]}`)
      const pages: Buffer[] = []
      const size = Number(paged[2])
      let got = 0
      while (got < size) {
        const page = Buffer.from((await driver.exec(
          jobName, `tail -c +${got + 1} ${file} | head -c ${OUTPUT_PAGE_BYTES} | base64`, opts,
        )).stdout, 'base64')
        if (page.length === 0) throw new Error('workspace changes: the run\'s output file ended early')
        pages.push(page)
        got += page.length
      }
      if (got !== size) throw new Error('workspace changes: the run\'s output file is not the size it printed')
      stdout = Buffer.concat(pages).toString('utf8')
    }
    const { reading, next } = readRun(stdout, offered)
    heldReadings.set(jobName, { held: next, usedAt: Date.now() })
    return { ...reading, readMs: Date.now() - started }
  }, signal)
}

/** `readChangeDiffs`'s exit code for "a tree it was given is gone". */
export const CHANGES_READING_GONE = 4

/**
 * More of a diff the changes poll left out, for the Changes pane: the parts
 * of `files` in the diff from `base` to the working tree `work`, both as a
 * reading answered them, so the parts match that reading's. A renamed
 * file's old path is diffed too, so the pair is found again. The answer is
 * capped as the poll's body is, but with `skip`, it is the one file's part
 * after the first `skip` lines, up to the whole cap, for a reader scrolling
 * down a file whose part was cut.
 *
 * The trees stay in the checkout's object store after the reading that
 * wrote them; a run that finds either gone fails with
 * `CHANGES_READING_GONE`.
 */
export async function readChangeDiffs(jobName: string, request: {
  base: string
  work: string
  files: { path: string; oldPath?: string }[]
  skip?: number
}): Promise<string> {
  const driver = workspaceDriver()
  const { workspaceDir, scratchDir } = driver.workspacePaths(jobName)
  const { base, work, files, skip } = request
  const [p, t] = skip === undefined ? [MAX_FILE_DIFF_BYTES, MAX_DIFF_BYTES] : [MAX_DIFF_BYTES, MAX_DIFF_BYTES]
  const script = `cd ${workspaceDir} 2>/dev/null || exit 3; `
    + `git cat-file -e "$1^{tree}" && git cat-file -e "$2^{tree}" || exit ${CHANGES_READING_GONE}; `
    + `s=${skip ?? 0}; p=${p}; t=${t}; e=${scratchDir}/yaac-diff.err.$$; ${cappedFn('$e')}`
    + `capped git --literal-pathspecs diff ${BODY_FLAGS} "$@"; r=$?; rm -f $e; exit $r`
  // Paths are named as name-status prints them, quoted when unusual. git
  // fails the whole run on one outside the checkout.
  const paths = files.flatMap((f) => [f.path, ...f.oldPath ? [f.oldPath] : []]).map((f) => pathBytes(f).toString())
  const bad = paths.find((f) => f.includes('\0') || f.startsWith('/') || f.split('/').includes('..'))
  if (bad !== undefined) throw new ServerError('VALIDATION', `${JSON.stringify(bad)} is not a path in the checkout`)
  const { stdout } = await driver.exec(jobName, `sh -c ${shSingleQuote(script)} yaac-diff `
    + [base, work, '--', ...paths].map(shSingleQuote).join(' '), { timeout: 20_000 })
  return stdout
}
