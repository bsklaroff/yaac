/**
 * The review diff for a workspace: everything the agent changed since it
 * forked from its base branch (committed, staged, unstaged, untracked),
 * read by shell scripts run inside the workspace (its git metadata names
 * its own paths, so the server cannot run git on it). Only the checkout and
 * scratch paths differ by driver. The same read says how far HEAD is from
 * the base branch and, when asked, lists the checkout for the file
 * explorer, so the webapp polls one thing per workspace
 * (docs/file-editor.md "Changes").
 *
 * A read is a scan and, when it finds anything new, a fill. The scan stages
 * the working tree into a private index (GIT_INDEX_FILE), so the agent's
 * own index and object store are never written, and prints the raw diff of
 * each tree pair the answer is built from: committed (base → HEAD), staged
 * (HEAD → the agent's index, written as a tree from a copy), unstaged (the
 * agent's tree → the working tree's; a file the agent's index lacks is
 * untracked) and the base diff (base → the working tree). The working tree
 * is walked once, by staging, however many pairs are read.
 *
 * A raw diff reads only trees, so it is cheap; reading blobs is what costs
 * on a large changeset over a network filesystem. A file's numstat row and
 * body part are a function of its raw line and the diff settings, so the
 * server keeps them per workspace under that key (`Entry`), and the fill
 * reads blobs only for the lines it lacks. An edit costs one file's diff
 * however large the changeset, and nothing cached belongs to a base, so a
 * second base shares what it can.
 */

import { workspaceDriver } from '#drivers/driver'
import { ServerError } from '@yaac/shared/errors'
import { DIFF_CUT_LINE } from '@yaac/shared/types'
import type {
  ChangeStage, ChangeStatus, CommitDetail, LineCounts, WorkspaceChange, WorkspaceComparison, WorkspaceDiff,
} from '@yaac/shared/types'

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

/** A fill's exit code for "a tree or blob it was given is gone". */
export const CHANGES_READING_GONE = 8

/**
 * What a changes read takes besides the diff. `listing` asks for the
 * checkout's paths too: `paths` comes from the index the diff already built, while
 * `full` adds the ignored entries and untracked folders, which walk the
 * working tree again.
 */
export interface ChangesRequest {
  base?: string
  /** The ref compared against when `base` is unset (`forkBase`). */
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

/** Cap the returned diff body so a huge changeset can't blow up the response;
 *  the file list (from numstat) stays complete. */
const MAX_DIFF_BYTES = 1_000_000

/** In-workspace cap on a fill's body, 2× the response cap. It only stops a
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
 * exiting there so git stops, after printing `$z` if set; git then dies of
 * SIGPIPE (141), or xargs reports its child killed (125), and either is a
 * whole answer. A cut between two files' parts prints no cut line, since no
 * part was cut. A read that skips into a line of `$p` bytes or more prints
 * its first `$p` bytes as the line, then the cut line, so the next read
 * goes on from the line after it. git's stderr goes to `log`.
 */
function cappedFn(errFile: string, log: string): string {
  const awk = '/^diff --git /{n=0} s>0{s--; next} n>p{next} {l=length($0)+1} '
    + 'n&&n+l>p{print c; n=p+1; next} b&&b+l>t{if(n)print c; if(z!="")print z; exit} '
    + 'l>p{print substr($0,1,p); print c; n=p+1; next} {print; n+=l; b+=l}'
  return `capped() { rm -f ${errFile}; { "$@" 2>${log} || { r=$?; [ $r -eq 141 ] || [ $r -eq 125 ] || : > ${errFile}; }; } `
    + `| LC_ALL=C awk -v s="$s" -v p="$p" -v t="$t" -v z="$z" -v c=${DIFF_CUT_LINE} '${awk}'; [ ! -e ${errFile} ]; }; `
}

/** Heads each tree pair's raw diff in a scan: `RAW <pair name>`. */
const M_RAW = '@@RAW@@'
/** The entry file, read back, ended by `END`. */
const M_ENTRIES = '@@ENTRIES@@'
/** The listing's sections, each NUL-separated and ended by `END`, since a
 *  path may hold a newline. */
const M_PATHS = '@@PATHS@@'
const M_CONFLICTED = '@@CONFLICTED@@'
const M_IGNORED = '@@IGNORED@@'
const M_DIRS = '@@DIRS@@'
/** The folders (as `dir/`) and files too large to stage, NUL-separated
 *  like the listing's. */
const M_SKIPPED = '@@SKIPPED@@'
const END = '@@END@@'
/** `END` framed by NULs, as a printf format. */
const nulEnd = `\\000${END}\\000`
/** A scan's last line, printed only after every command in it succeeded,
 *  so a partial run is an error, not "No changes". */
const M_OK = '@@OK@@'
/** Heads each pair's part of a fill's output. */
const M_PAIR = '@@PAIR@@'
/** Heads a fill's body. */
const M_BODY = '@@BODY@@'
/** Ends a fill's body that the total cap cut, whose last part may be cut. */
const M_TOTAL = '@@TOTAL@@'
/** Ends a fill's body that `git diff` could not finish. */
const M_NODIFF = '@@NODIFF@@'

/** A scan whose output passes this size leaves it in a file, fetched in
 *  pages of this size: base64 makes a page about 2.8 MB, under streamd's
 *  4 MiB exec output cap. */
export const OUTPUT_PAGE_BYTES = 2 * 1024 * 1024

/** The most of the entry file a scan prints back; past it, the server
 *  replaces the file rather than reading it. */
const MAX_ENTRY_FILE_BYTES = 16 * OUTPUT_PAGE_BYTES

/** The most pages `execPaged` reads, so nothing in a workspace can have
 *  the server hold more. */
const MAX_OUTPUT_PAGES = 64

/** The most lines a fill reads by path; past this, diffing the whole pair
 *  is about as cheap. */
const MAX_FILL_PATHS = 300

/** Body flags that keep one plain `diff --git` header per file, whatever
 *  the user's config, so the body splits into per-file chunks. */
const BODY_FLAGS = '--no-ext-diff --no-color --submodule=short'

/** An untracked folder holding more files than this, that no ignore
 *  pattern covers, is not staged (see `SKIP_COUNT`). */
export const MAX_UNTRACKED_FOLDER_FILES = 2000

/** Nor is an untracked file larger than this: staging writes its blob into
 *  scratch, which a pod holds in memory. */
export const MAX_UNTRACKED_FILE_BYTES = 10 * 1024 * 1024

/**
 * awk over `ls-files -o` paths, one a line, that finds the folders too
 * large to stage. The first program counts the paths under every folder
 * that holds them, at every depth, printing those over the limit as
 * `<depth> <count> <folder>/`. Sorted deepest first, the second takes each
 * folder whose count, less what folders already skipped below it hold, is
 * still over the limit, and prints it as `<folder>/`.
 */
const SKIP_COUNT = `LC_ALL=C awk -F/ '{p=""; for(k=1;k<NF;k++){p=p $k "/"; c[p]++}} `
  + `END{for(d in c) if(c[d]>${MAX_UNTRACKED_FOLDER_FILES}){x=d; print gsub("/","",x), c[d], d}}' | sort -k1,1nr `
  + `| LC_ALL=C awk '{d=$0; sub(/^[0-9]+ [0-9]+ /,"",d); e=$2-s[d]; if(e>${MAX_UNTRACKED_FOLDER_FILES}){`
  + `print d; p=d; while(sub("[^/]*/$","",p)&&p!="")s[p]+=e}}'`

/**
 * Stages the working tree but the folders and files it is given as the
 * agent's tree (`$1`) has them: their entries in the private index go back
 * to that tree, dropping any untracked file an earlier run staged, and only
 * their tracked files' edits are staged.
 */
const ADD_SKIPPING = 'a=$1; shift; git --literal-pathspecs reset -q "$a" -- "$@" '
  + '&& git --literal-pathspecs -c core.checkStat=minimal diff-files -z --name-only -- "$@" | git update-index -z --remove --stdin '
  + '&& for d; do shift; set -- "$@" ":(exclude,literal)$d"; done '
  + '&& { git -c core.checkStat=minimal add -A --ignore-errors -- . "$@" || [ $? -eq 1 ]; }'

/** Past this many KiB, the scratch object directory starts over: a pod's
 *  scratch is held in its memory. */
export const SCRATCH_OBJECTS_CAP_KB = 256 * 1024

/**
 * Shell that points git's object writes at `<index>.objects` in scratch,
 * reading the checkout's own store (and so, through its alternates, the
 * main clone's) as an alternate. Staging a file then writes its blob to
 * pod-local scratch rather than the checkout's network filesystem, and
 * polls leave no loose objects in the checkout. Anything that reads a
 * reading's trees needs it too.
 */
function scratchObjects(indexFile: string): string {
  return `ob=$(cd "$(git rev-parse --git-path objects)" && pwd -P) && mkdir -p ${indexFile}.objects || exit 6; `
    + `export GIT_OBJECT_DIRECTORY=${indexFile}.objects GIT_ALTERNATE_OBJECT_DIRECTORIES="$ob"; `
}

/**
 * Shell that sets `cf` to a hash of what decides git's diff output besides
 * the two trees: `diff.*` and `submodule.*` config, `core.bigFileThreshold`
 * (a blob over it diffs as binary), `core.abbrev` (the body's `index`
 * lines), `.gitmodules` (a submodule's `ignore` hides it) and every
 * attributes source (`.gitattributes` files, `info/attributes`,
 * `core.attributesFile`), since an attribute can make another file binary
 * or run it through a textconv. The `.gitattributes` files and
 * `.gitmodules` come from the tree `$t`, which the fill reads attributes
 * from too (`GIT_ATTR_SOURCE`), so one the working tree holds but staging
 * left out counts for neither. A textconv program's own output is taken to
 * depend only on the blob.
 */
const SETTINGS_SH = 'cf=$({ git config --get-regexp \'^(diff|submodule)\\.|^core\\.(bigfilethreshold|abbrev)$\'; '
  + 'git ls-tree -r "$t" | grep -E \'\t((.*/)?\\.gitattributes|\\.gitmodules)$\'; cat "$(git rev-parse --git-path info/attributes)" '
  + '"$(git config --path core.attributesFile || echo "${XDG_CONFIG_HOME:-$HOME/.config}/git/attributes")"; } 2>/dev/null '
  + '| git hash-object --stdin) || exit 6; '

/**
 * Force-adds its arguments that still exist (a link counts, even broken),
 * in one `git add`, and nothing when none do. The names come from the
 * agent's index, so they are literal: `--` alone still lets a name like
 * `:(glob)**` or `*` match every ignored file, credentials included.
 */
const FORCE_ADD = 'for p; do shift; { [ -e "$p" ] || [ -L "$p" ]; } && set -- "$@" "$p"; done; '
  + '[ $# -eq 0 ] || exec git --literal-pathspecs add -f -- "$@"'

/**
 * Shell that picks the ref HEAD is compared against, for the changes script
 * and the Commits pane's log (`checkoutLog`) alike: `$1`, a branch the user
 * picked, tried as `origin/<name>` and then as itself (`HEAD` only as
 * itself), else `$2`, the default ref as given. A candidate counts only if
 * it shares history with
 * HEAD. Sets `ref` to the one found and `base` to its merge base with HEAD;
 * with none, `ref` is empty, and a picked `$1` exits
 * CHANGES_BASE_UNRESOLVED. So does a picked `$1` with a leading dash, which
 * git would read as an option.
 */
export const RESOLVE_BASE_SH = 'ref=; '
  + `case $1 in -*) exit ${CHANGES_BASE_UNRESOLVED};; esac; `
  + 'if [ -n "$1" ]; then '
  + 'for r in "origin/$1" "$1"; do [ "$1:$r" != HEAD:origin/HEAD ] || continue; '
  + 'base=$(git merge-base "$r" HEAD 2>/dev/null) && { ref=$r; break; }; done; '
  + `[ -n "$ref" ] || exit ${CHANGES_BASE_UNRESOLVED}; `
  + 'elif [ -n "$2" ]; then base=$(git merge-base "$2" HEAD 2>/dev/null) && ref=$2; fi; '

/**
 * Shell that ends a run whose output is in `$o` and whose stderr is in
 * `$o.err`, exiting `$r`. Up to `OUTPUT_PAGE_BYTES` the output is printed;
 * past that, only `PAGED <pid> <bytes>`, and the file stays for the server
 * to page through (`execPaged`) until the next scan clears it. Only the end
 * of stderr is passed on, since a warning per file could pass the cap too.
 */
const PRINT_OUTPUT = 'tail -c 4096 $o.err >&2; rm -f $o.err; '
  + `if [ $(wc -c < $o) -gt ${OUTPUT_PAGE_BYTES} ]; then printf "PAGED %s %s\\n" $$ $(wc -c < $o); `
  + 'else cat $o; rm -f $o; fi; exit $r'

/**
 * The scan. Resolves the diff base, stages the working tree into the
 * private index, and prints the raw diff of each pair the server does not
 * already hold, then the listing (see the module comment).
 *
 * Args (see runScan):
 *  - `$1`: a base branch the user picked. Tries `origin/<$1>`, then local
 *    `<$1>`. If neither resolves, exits `CHANGES_BASE_UNRESOLVED` rather than
 *    diffing against the wrong base.
 *  - `$2`: the ref compared against when `$1` is empty (`forkBase`), used
 *    as given.
 *  - `$3`: empty, `paths` or `full`: which listing to print.
 *  - `$4`, `$5`: the key of the paths the server's listing holds
 *    (`LISTED`), and the hash of its ignored entries and untracked folders,
 *    or empty.
 *  - `$6`: the names of the pairs the server holds (`pairName`).
 *  - `$7`: `load` to print the entry file back.
 *  - `$8`: `A` or `R` to append its stdin to the entry file, or replace the
 *    file with it.
 *
 * `REF` names the ref the base was found on and how far HEAD is behind and
 * ahead of it, for the status bar. `TREES` names HEAD, the agent's tree and
 * the working tree's, and `SETTINGS` is `SETTINGS_SH`'s hash. A raw diff is
 * a function of its two trees and those settings, so the server names
 * each pair it holds with both, and an idle poll prints no pair.
 *
 * The listing's paths come from the private index after `add -A`, so they
 * cost no second walk: every file git does not ignore, links marked by
 * their mode. They are keyed by the working tree they were read at and the
 * large files added with intent to add, which no tree has, and printed only
 * when that list changed or a path was added, deleted or retyped. Ignored
 * entries and untracked folders do walk the tree, so only `full` reads
 * them, and they are printed only when their hash (`EXTRAS`) differs from
 * the held one. Conflicts come from the agent's index.
 *
 * With no fork point, a HEAD that shares history with some origin branch
 * is diffed against itself and prints `FORK 0`: only uncommitted work
 * appears, and callers must not present that as "nothing changed". A HEAD
 * that shares none (an orphan branch's commits, or none yet) is diffed
 * against the empty tree, so all of it counts as added.
 *
 * The output goes to a file of this run's own, printed or paged as
 * `PRINT_OUTPUT` says.
 */
function scanScript(workspaceDir: string, i: string): string {
  return `cd ${workspaceDir} 2>/dev/null || exit 3; `
  // The run waits and retries only until 10 seconds after it starts, half
  // the server's shorter exec timeout, so the work after either still fits.
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
  + `rm -f ${i}.out.* ${i}.lock ${i}.seed.*; o=${i}.out.$$; `
  // The entry file, written whole through a copy when replaced.
  + `case $8 in A) cat >> ${i}.entries;; R) cat > ${i}.entries.new && mv ${i}.entries.new ${i}.entries;; esac; `
  + 'run() ( '
  // Scratch objects past their cap start over with the private index,
  // which names them, and so do they after a fill found one gone.
  + `kb=$(du -sk ${i}.objects 2>/dev/null); { [ "0\${kb%%[!0-9]*}" -lt ${SCRATCH_OBJECTS_CAP_KB} ] && [ ! -e ${i}.reseed ]; } `
  + `|| rm -rf ${i} ${i}.objects ${i}.reseed; `
  + scratchObjects(i)
  // An unborn HEAD (a new orphan branch) reads as the empty tree.
  + 'e=$(git hash-object -t tree /dev/null) || exit 6; head=$(git rev-parse -q --verify HEAD) || head=$e; '
  + 'fork=1; '
  + 'unforked() { if git merge-base "$head" $(git for-each-ref --format="%(objectname)" refs/remotes/origin) '
  + '>/dev/null 2>&1; then base=$head; fork=0; else base=$e; fi; }; '
  + `${RESOLVE_BASE_SH}[ -n "$ref" ] || unforked; `
  + 'printf "BASE %s\\n" "$base"; '
  + 'printf "FORK %s\\n" "$fork"; '
  + '[ -z "$ref" ] || { n=$(git rev-list --left-right --count "$ref...HEAD" --) && printf "REF %s %s\\n" "$ref" "$n"; }; '
  // An entry file past its bound is not printed, and the server replaces it.
  + `[ "$7" != load ] || [ "$(wc -c < ${i}.entries 2>/dev/null || echo 0)" -gt ${MAX_ENTRY_FILE_BYTES} ] `
  + `|| { printf "${M_ENTRIES}\\n"; cat ${i}.entries 2>/dev/null; printf "${END}\\n"; }; `
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
  // The folders and files too large to stage, from the untracked files no
  // ignore pattern covers. Listed against the agent's index, since the
  // private index holds what earlier runs staged. A large file is still
  // added with intent to add, so the listing names it, though no tree has it.
  + `{ [ ! -f ${i}.agent ] || GIT_INDEX_FILE=${i}.agent git ls-files -z -o --exclude-standard; } | tr '\\0' '\\n' > ${i}.new; `
  + `< ${i}.new ${SKIP_COUNT} | tr '\\n' '\\0' > ${i}.skip; sed 's|^|./|' ${i}.new | tr '\\n' '\\0' `
  + `| xargs -0 sh -c '[ $# -eq 0 ] || exec find "$@" -prune -type f -size +${MAX_UNTRACKED_FILE_BYTES}c' yaac-big `
  + `| sed 's|^\\./||' | tr '\\n' '\\0' > ${i}.big || exit 6; `
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
  + `stage() { if [ -s ${i}.skip ] || [ -s ${i}.big ]; then cat ${i}.skip ${i}.big | xargs -0 sh -c ${shSingleQuote(ADD_SKIPPING)} yaac-add "$agent" `
  + `&& { [ ! -s ${i}.big ] || xargs -0 git --literal-pathspecs add -N -- < ${i}.big; }; `
  + 'else git -c core.checkStat=minimal add -A --ignore-errors || [ $? -eq 1 ]; fi '
  + `&& { [ ! -f ${i}.agent ] || GIT_INDEX_FILE=${i}.agent git ls-files -z -c -i --exclude-standard `
  + `| xargs -0 sh -c ${shSingleQuote(FORCE_ADD)} yaac-force-add; }; }; `
  + `until stage; do git ls-files -s >/dev/null 2>&1 || { rm -f ${i}; seed; }; `
  + '[ $(date +%s) -lt $d ] || exit 5; sleep 0.2; done; '
  + 'work=$(git write-tree) || exit 5; '
  + 'printf "TREES %s %s %s\\n" "$head" "$agent" "$work"; '
  + `t=$work; ${SETTINGS_SH}printf "SETTINGS %s\\n" "$cf"; `
  // `raw <a> <b> [!]`: the pair's raw diff, unless the server holds it;
  // `!` reads it without rename pairing.
  + `held=" $6 "; raw() { case $held in *" $1..$2$3:$cf "*) return 0;; esac; printf "${M_RAW} %s\\n" "$1..$2$3:$cf" `
  + '&& git diff --raw --no-abbrev ${3:+--no-renames} "$1" "$2"; }; '
  + 'raw "$base" "$head" && raw "$head" "$agent" && raw "$agent" "$work" ! && raw "$base" "$work" || exit 6; '
  // The listing's paths are a function of the working tree's paths and
  // modes, so an edit leaves them as held. `ls-files` lists every gitlink,
  // so this must see one even when `.gitmodules` says `ignore = all`.
  + `[ -z "$3" ] || { lk="$work $(git hash-object --no-filters ${i}.big)" || exit 6; printf "LISTED %s\\n" "$lk"; `
  + '{ [ "${4#* }" = "${lk#* }" ] && git diff-tree --quiet -r --ignore-submodules=none --diff-filter=ADT "${4% *}" "$work"; } '
  + `|| { printf "${M_PATHS}\\n"; git ls-files -z -s || exit 6; printf '${nulEnd}'; }; `
  + `printf "${M_CONFLICTED}\\n"; { [ ! -f ${i}.agent ] || GIT_INDEX_FILE=${i}.agent git ls-files -z -u; } || exit 6; printf '${nulEnd}'; }; `
  + `[ "$3" != full ] || { { printf "${M_IGNORED}\\n"; git ls-files -z --others --ignored --exclude-standard --directory `
  + `&& printf '${nulEnd}${M_DIRS}\\n' && git ls-files -z --others --exclude-standard --directory && printf '${nulEnd}'; } `
  + `> ${i}.extras && xh=$(git hash-object --no-filters ${i}.extras) || exit 6; `
  + `printf "EXTRAS %s\\n" "$xh"; [ "$xh" = "$5" ] || cat ${i}.extras || exit 6; }; `
  + `printf "${M_SKIPPED}\\n"; cat ${i}.skip ${i}.big || exit 6; printf '${nulEnd}'; `
  + `printf "\\n${M_OK}\\n" ); run "$@" > $o 2> $o.err; r=$?; `
  // The private index can name a blob that is gone: the agent added a
  // file, reset it and pruned. No stat check notices, so the run starts
  // over from a fresh seed, whose staging hashes the file again.
  + `[ $r -eq 0 ] || ! grep -qE '^fatal: unable to read [0-9a-f]{40}' $o.err || { rm -rf ${i} ${i}.objects; run "$@" > $o 2> $o.err; r=$?; }; `
  + PRINT_OUTPUT
}

/**
 * The fill: one pair's diff, read from its two trees (`$1`, `$2`), with
 * rename pairing unless `$3` is `!`, at the paths after `$8`, or the whole
 * pair when none follow. Attributes come from tree `$8`, the one the
 * settings hashed them from (`GIT_ATTR_SOURCE`, which a git before 2.40
 * ignores). With `n` in `$4`, the raw lines and numstat rows, which git
 * prints in the same order; with `d`, the body, capped by `$5`, `$6` and
 * `$7` as `capped` says, with the total cap's cut marked when the numstat
 * was read too. A blob it cannot read leaves a mark that has the next scan
 * seed its index afresh (see scanScript), and exits `CHANGES_READING_GONE`,
 * as a gone tree does.
 */
function fillScript(workspaceDir: string, i: string): string {
  const e = `${i}.fill.$$`
  const gone = `{ ! grep -qE '^fatal: unable to read [0-9a-f]{40}' ${e} || { : > ${i}.reseed; exit ${CHANGES_READING_GONE}; }; }`
  return `cd ${workspaceDir} 2>/dev/null || exit 3; ${scratchObjects(i)}`
    + `git cat-file -e "$1^{tree}" && git cat-file -e "$2^{tree}" || exit ${CHANGES_READING_GONE}; `
    + 'a=$1; b=$2; r=${3:+--no-renames}; w=$4; s=$5; p=$6; t=$7; export GIT_ATTR_SOURCE=$8; z=; shift 8; '
    + `trap 'rm -f ${e} ${e}.err' EXIT; printf "${M_PAIR}\\n"; case $w in *n*) z=${M_TOTAL}; `
    + `git --literal-pathspecs diff --raw --numstat --no-abbrev $r "$a" "$b" "$@" 2> ${e} || { ${gone}; cat ${e} >&2; exit 6; };; esac; `
    + `case $w in *d*) ${cappedFn(`${e}.err`, e)}printf "${M_BODY}\\n"; `
    + `capped git --literal-pathspecs diff ${BODY_FLAGS} $r "$a" "$b" "$@" || { ${gone}; printf "${M_NODIFF}\\n"; };; esac`
}

/** Single-quote a value for the one shell pass a driver's `exec` applies,
 *  so it stays one literal argv token. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Map a git name-status letter to our ChangeStatus. */
function statusFromCode(code: string): ChangeStatus {
  switch (code[0]) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'typechange'
    default: return 'modified' // 'M' and anything unexpected
  }
}

/** One file's line of a raw diff. */
interface RawLine {
  /** The line as git printed it, which keys the file's entry. */
  line: string
  /** The status letter, with a rename's or copy's score. */
  status: string
  /** As git prints it, quoted when unusual; the new path of a rename. */
  path: string
  oldPath?: string
}

/** `:<mode> <mode> <blob> <blob> <status>\t<path>[\t<path>]`. */
function parseRaw(line: string): RawLine {
  const [head, ...paths] = line.split('\t')
  const status = head.slice(head.lastIndexOf(' ') + 1)
  return paths.length > 1 ? { line, status, path: paths[1], oldPath: paths[0] } : { line, status, path: paths[0] ?? '' }
}

/**
 * Names a pair's raw diff: its two trees, `!` when read without rename
 * pairing, and the settings it was read under, as the scan names it.
 */
function pairName(a: string, b: string, settings: string, renames = true): string {
  return `${a}..${b}${renames ? '' : '!'}:${settings}`
}

type Counts = LineCounts & { binary: boolean }

/** A file's numstat row and, once read, its body part, as one raw line
 *  gives them under one set of diff settings. */
interface Entry {
  counts: Counts
  part?: string
  /** Its line in the entry file. */
  json: string
}

/** The listing the server holds: the paths, under the key the scan read
 *  them at, and the ignored entries and untracked folders, under their
 *  hash. */
interface HeldListing {
  key: string
  paths: string[]
  links: string[]
  extras?: { hash: string; ignored: string[]; untrackedDirs: string[] }
}

/**
 * What the server holds of one workspace's changes. Raw diffs are kept per
 * pair, but only the pairs of each base's latest reading (`readings`), and
 * entries only while a held raw diff names them, so an agent rewriting one
 * file every few seconds leaves one entry for it. Nothing in the entries
 * belongs to a base: a file the same under two bases is read once. They
 * are never shared between workspaces, though: each is the output of a
 * script the workspace's agent can shape.
 */
interface Held {
  raws: Map<string, { settings: string; lines: RawLine[] }>
  readings: Map<string, { pairs: string[]; usedAt: number }>
  /** By `entryKey`. */
  entries: Map<string, Entry>
  listing?: HeldListing
  /**
   * The entry file in the workspace's scratch, which carries the entries
   * across a server restart: whether this server has read it back, how
   * many bytes it holds (Infinity when that is unknown and it should be
   * replaced) and the entries filled since it was last written.
   */
  file: { loaded: boolean; bytes: number; unsaved: Set<string> }
  /** The workspace's last read succeeded, so its private index is warm. */
  warm: boolean
}

const heldChanges = new Map<string, Held>()

/** A reading no read has used for this long is dropped; with none left,
 *  so is everything the workspace held. */
const HELD_IDLE_MS = 5 * 60_000

const entryKey = (settings: string, line: string): string => `${settings} ${line}`

/** The workspace's held changes, after dropping what has gone idle. */
function heldFor(jobName: string): Held {
  const now = Date.now()
  for (const [name, h] of heldChanges) {
    for (const [k, r] of h.readings) if (now - r.usedAt > HELD_IDLE_MS) h.readings.delete(k)
    if (h.readings.size === 0) heldChanges.delete(name)
  }
  let held = heldChanges.get(jobName)
  if (!held) {
    held = { raws: new Map(), readings: new Map(), entries: new Map(), file: { loaded: false, bytes: 0, unsaved: new Set() }, warm: false }
    heldChanges.set(jobName, held)
  }
  return held
}

/** Drop the raw diffs no reading names and the entries no raw diff does. */
function prune(held: Held): void {
  const pairs = new Set([...held.readings.values()].flatMap((r) => r.pairs))
  for (const name of held.raws.keys()) if (!pairs.has(name)) held.raws.delete(name)
  const live = new Set([...held.raws.values()].flatMap(({ settings, lines }) => lines.map((l) => entryKey(settings, l.line))))
  for (const key of held.entries.keys()) {
    if (!live.has(key)) {
      held.entries.delete(key)
      held.file.unsaved.delete(key)
    }
  }
}

/** Drop what the server holds of a workspace's changes, on teardown. */
export function forgetWorkspaceChanges(jobName: string): void {
  heldChanges.delete(jobName)
}

/**
 * What the next scan writes to the entry file, on its stdin: the entries
 * filled since the last write, appended, or once the file would pass twice
 * the size of the live entries, every live entry in its place. A file this
 * server has not read back is only appended to.
 */
function entryFileWrite(held: Held): { mode: 'A' | 'R' | ''; text: string; keys: string[] } {
  const { file, entries } = held
  const lines = (keys: string[]): string => keys.map((k) => `${entries.get(k)!.json}\n`).join('')
  const unsaved = [...file.unsaved]
  const live = [...entries.values()].reduce((n, e) => n + e.json.length + 1, 0)
  const text = lines(unsaved)
  if (file.loaded && file.bytes + text.length > 2 * live) {
    const keys = [...entries.keys()]
    return { mode: 'R', text: lines(keys), keys }
  }
  return { mode: unsaved.length ? 'A' : '', text, keys: unsaved }
}

/**
 * Take back the entries a scan printed from the file, where a later line
 * for a key replaces an earlier one (a file's counts, then its part). A
 * line cut short by a killed write, or one that is not an entry, is
 * dropped, and the file replaced at the next write, so no append lands on
 * the end of it. So is a file the scan did not print (`text` undefined),
 * being past its bound.
 */
function loadEntries(held: Held, text: string | undefined): void {
  if (text === undefined) {
    held.file = { loaded: true, bytes: Infinity, unsaved: held.file.unsaved }
    return
  }
  let whole = text === '' || text.endsWith('\n')
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const { k, a, d, b, p } = JSON.parse(line) as Record<string, unknown>
      if (typeof k !== 'string' || !Number.isSafeInteger(a) || !Number.isSafeInteger(d) || (p !== undefined && typeof p !== 'string')) {
        throw new Error('not an entry')
      }
      held.entries.set(k, { counts: { additions: a as number, deletions: d as number, binary: b === 1 }, ...p !== undefined ? { part: p } : {}, json: line })
    } catch {
      whole = false
    }
  }
  held.file = { loaded: true, bytes: whole ? text.length : Infinity, unsaved: held.file.unsaved }
}

/** A scan's output, parsed. */
interface Scan {
  base: string
  baseResolved: boolean
  head: string
  agent: string
  work: string
  settings: string
  ref: ChangesReading['ref']
  /** The pairs it printed. */
  raws: Map<string, RawLine[]>
  entries?: string
  /** The key of the listing's paths (see scanScript). */
  listed: string
  paths?: string[]
  links?: string[]
  conflicted?: string[]
  extras?: { hash: string; ignored?: string[]; untrackedDirs?: string[] }
  skipped: string[]
}

/**
 * Parse a scan's output, a section at a time. Throws when the `@@OK@@` line
 * is missing, since the run then failed partway and an empty file list
 * would falsely read as "No changes".
 */
function parseScan(out: string): Scan {
  if (!out.endsWith(`\n${M_OK}\n`)) {
    throw new Error('workspace changes: script produced no completion marker (partial or failed run)')
  }
  const scan: Scan = {
    base: '', baseResolved: true, head: '', agent: '', work: '', settings: '', ref: null, raws: new Map(), listed: '', skipped: [],
  }
  let at = 0
  const line = (): string => {
    const nl = out.indexOf('\n', at)
    const l = out.slice(at, nl)
    at = nl + 1
    return l
  }
  /** A NUL-separated section's entries, up to its `END`. */
  const nul = (): string[] => {
    const e = out.indexOf(`\0${END}\0`, at)
    const list = out.slice(at, Math.max(at, e)).split('\0').filter(Boolean)
    at = Math.max(at, e) + END.length + 2
    return list
  }
  while (at < out.length) {
    const l = line()
    const [word, ...rest] = l.split(' ')
    switch (word) {
      case 'BASE': scan.base = rest[0]; break
      // FORK 0: no fork point, diffed against HEAD, so commits are missing.
      case 'FORK': scan.baseResolved = rest[0] !== '0'; break
      case 'TREES': [scan.head, scan.agent, scan.work] = rest; break
      // A comparison's newer end, which stands where the working tree does.
      case 'TO': scan.work = rest[0]; break
      case 'SETTINGS': scan.settings = rest[0]; break
      // `REF <ref> <behind>\t<ahead>`: rev-list counts the left side first.
      case 'REF': {
        const m = /^(\S+) (\d+)\s+(\d+)$/.exec(rest.join(' '))
        if (m) scan.ref = { name: m[1], behind: Number(m[2]), ahead: Number(m[3]) }
        break
      }
      case M_RAW: {
        const lines: RawLine[] = []
        while (out.startsWith(':', at)) lines.push(parseRaw(line()))
        scan.raws.set(rest[0], lines)
        break
      }
      case M_ENTRIES: {
        const e = out.indexOf(`${END}\n`, at)
        scan.entries = out.slice(at, e)
        at = e + END.length + 1
        break
      }
      case M_PATHS: {
        // `<mode> <object> <stage>\t<path>`; a link's mode is 120000.
        const entries = nul().map((e) => ({ mode: e.slice(0, 6), path: e.slice(e.indexOf('\t') + 1) }))
        scan.paths = entries.map((e) => e.path)
        scan.links = entries.filter((e) => e.mode === '120000').map((e) => e.path)
        break
      }
      // One entry per conflict stage.
      case M_CONFLICTED: scan.conflicted = [...new Set(nul().map((e) => e.slice(e.indexOf('\t') + 1)))]; break
      case 'LISTED': scan.listed = rest.join(' '); break
      case 'EXTRAS': scan.extras = { hash: rest[0] }; break
      case M_IGNORED: scan.extras!.ignored = nul(); break
      case M_DIRS: scan.extras!.untrackedDirs = nul().filter((d) => d.endsWith('/')).map((d) => d.slice(0, -1)); break
      case M_SKIPPED: {
        // Anything inside a skipped folder is named by the folder alone.
        const all = nul()
        scan.skipped = all.filter((d) => !all.some((o) => o !== d && o.endsWith('/') && d.startsWith(o)))
        break
      }
    }
  }
  return scan
}

/** A tree pair a read needs, and which of its lines to fill. */
interface Need {
  a: string
  b: string
  renames: boolean
  name: string
  settings: string
  /** The lines to read, or `all` for the whole pair. */
  lines: RawLine[] | 'all'
  body: boolean
}

/**
 * A unified diff split into its files' parts, in their raw lines' order.
 * git prints one `diff --git` header a file, but two for a typechange (a
 * deletion, then a creation), so a typechange the cap left one part of
 * has none.
 */
function chunksOf(lines: RawLine[], text: string): Map<RawLine, string> {
  const parts = text ? text.split(/(?=^diff --git )/m) : []
  const chunks = new Map<RawLine, string>()
  let k = 0
  for (const l of lines) {
    const n = l.status[0] === 'T' ? 2 : 1
    if (k + n > parts.length) break
    chunks.set(l, parts.slice(k, k + n).join(''))
    k += n
  }
  return chunks
}

/** Escapes git's C-style quoting of a path uses, besides octal bytes. */
const QUOTED: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/** The bytes of a path as git prints it, unquoted. */
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

/** Whether `text` ends in a line holding just `marker`. */
const endsWithLine = (text: string, marker: string): boolean => `\n${text}`.endsWith(`\n${marker}\n`)

/** Paths as git takes them on its command line: unquoted, and a rename's
 *  old path beside its new one, so the pair is found again. */
function pathArgs(files: { path: string; oldPath?: string }[]): string[] {
  return files.flatMap((f) => [f.path, ...f.oldPath ? [f.oldPath] : []]).map((p) => pathBytes(p).toString())
}

/**
 * Read what `needs` lack into the held entries, one exec for every pair,
 * with attributes from tree `attrs`.
 * A fill by path is checked against the lines it asked for: git pairs
 * renames among the paths it is given alone, so a subset could in
 * principle pair differently (a rename limit the whole pair passed), and
 * then the whole pair is read instead. A part the total cap cut is not
 * kept, nor, as none is printed, any after it; they lie past the answer's
 * cap. Returns whether a body failed.
 */
async function fill(
  jobName: string, held: Held, needs: Need[], attrs: string, opts: { timeout: number; signal?: AbortSignal },
): Promise<boolean> {
  if (needs.length === 0) return false
  const { workspaceDir, scratchDir } = workspaceDriver().workspacePaths(jobName)
  const indexFile = indexFileIn(scratchDir)
  const script = shSingleQuote(fillScript(workspaceDir, indexFile))
  const runs = needs.map((n) => `sh -c ${script} yaac-fill `
    + [n.a, n.b, n.renames ? '' : '!', n.body ? 'nd' : 'n', '0', String(MAX_FILE_DIFF_BYTES), String(WORKSPACE_DIFF_CAP_BYTES), attrs,
      ...n.lines === 'all' ? [] : ['--', ...pathArgs(n.lines)]].map(shSingleQuote).join(' ')).join(' && ')
  const stdout = await execPaged(jobName, indexFile, `o=${indexFile}.out.$$; { ${runs}; } > $o 2> $o.err; r=$?; ${PRINT_OUTPUT}`, {
    ...opts, maxAttempts: 2,
  })
  const sections = stdout.split(new RegExp(`^${M_PAIR}\n`, 'm')).slice(1)
  let failed = false
  const again: Need[] = []
  for (const [k, need] of needs.entries()) {
    const section = sections[k] ?? ''
    const b = section.search(new RegExp(`^${M_BODY}\n`, 'm'))
    const stat = (b === -1 ? section : section.slice(0, b)).split('\n').filter(Boolean)
    const lines = stat.filter((l) => l.startsWith(':')).map(parseRaw)
    const rows = stat.filter((l) => !l.startsWith(':'))
    const known = new Set(held.raws.get(need.name)?.lines.map((l) => l.line))
    const got = new Set(lines.map((l) => l.line))
    const wanted = need.lines === 'all' ? [...known] : need.lines.map((l) => l.line)
    if (rows.length !== lines.length || !wanted.every((l) => got.has(l)) || !lines.every((l) => known.has(l.line))) {
      if (need.lines === 'all') throw new Error('workspace changes: a pair read whole did not match its raw diff')
      again.push({ ...need, lines: 'all' })
      continue
    }
    let body = b === -1 ? undefined : section.slice(b + M_BODY.length + 1)
    if (body !== undefined && endsWithLine(body, M_NODIFF)) {
      failed = true
      body = undefined
    }
    const cut = body !== undefined && endsWithLine(body, M_TOTAL)
    const chunks = chunksOf(lines, (cut ? body!.slice(0, -M_TOTAL.length - 1) : body) ?? '')
    if (cut) chunks.delete([...chunks.keys()].at(-1)!)
    for (const [n, l] of lines.entries()) {
      const [add = '', del = ''] = rows[n].split('\t')
      const binary = add === '-' || del === '-'
      const key = entryKey(need.settings, l.line)
      const counts = { additions: binary ? 0 : Number(add) || 0, deletions: binary ? 0 : Number(del) || 0, binary }
      const old = held.entries.get(key)
      const part = chunks.get(l) ?? old?.part
      if (old && old.part === part && JSON.stringify(old.counts) === JSON.stringify(counts)) continue
      const json = JSON.stringify({ k: key, a: counts.additions, d: counts.deletions, b: binary ? 1 : 0, ...part !== undefined ? { p: part } : {} })
      held.entries.set(key, { counts, ...part !== undefined ? { part } : {}, json })
      held.file.unsaved.add(key)
    }
  }
  return (await fill(jobName, held, again, attrs, opts)) || failed
}

/**
 * What a pair lacks: the lines with no entry (the untracked files of the
 * unstaged pair need none), and, when a body is wanted, those with no part
 * before the answer's cap. Parts not yet read count as empty there, so
 * every one that could fall inside the cap is read.
 */
function needOf(held: Held, name: string, pair: [string, string, boolean], body: boolean, skip?: (l: RawLine) => boolean): Need | null {
  const { settings, lines } = held.raws.get(name)!
  const get = (l: RawLine): Entry | undefined => held.entries.get(entryKey(settings, l.line))
  const want = new Set(lines.filter((l) => !skip?.(l) && !get(l)))
  let bytes = 0
  for (const l of body ? lines : []) {
    if (bytes > MAX_DIFF_BYTES) break
    const part = get(l)?.part
    if (part === undefined) want.add(l)
    else bytes += Buffer.byteLength(part)
  }
  if (want.size === 0) return null
  const wanted = lines.filter((l) => want.has(l))
  return {
    a: pair[0], b: pair[1], renames: pair[2], name, settings, body: body && wanted.some((l) => get(l)?.part === undefined),
    lines: wanted.length > MAX_FILL_PATHS ? 'all' : wanted,
  }
}

const NO_COUNTS: Counts = { additions: 0, deletions: 0, binary: false }

/** A raw line as one of an answer's files. */
function changeOf(l: RawLine, { additions, deletions, binary }: Counts, stages: WorkspaceChange['stages']): WorkspaceChange {
  return { path: l.path, status: statusFromCode(l.status), additions, deletions, binary, stages, ...l.oldPath ? { oldPath: l.oldPath } : {} }
}

/**
 * An answer's body: the parts of `lines` in file order, stopping at the
 * first file whose part is missing, or once past the cap, then cut to it.
 * It is `truncated` when it stopped early, holds a part that was cut, or
 * passed the cap, measured in bytes as the fill's caps are; a body that
 * failed is shown as cut short to nothing.
 */
function bodyOf(lines: RawLine[], entry: (l: RawLine) => Entry | undefined, failed: boolean): { diff: string; truncated: boolean } {
  let text = ''
  let bytes = 0
  let whole = !failed
  for (const [n, l] of (failed ? [] : lines).entries()) {
    const part = entry(l)?.part
    if (part === undefined) {
      whole = false
      break
    }
    text += part
    bytes += Buffer.byteLength(part)
    if (part.endsWith(`\n${DIFF_CUT_LINE}\n`)) whole = false
    if (bytes > MAX_DIFF_BYTES && n < lines.length - 1) {
      whole = false
      break
    }
  }
  return { diff: cutDiff(text, MAX_DIFF_BYTES), truncated: !whole || bytes > MAX_DIFF_BYTES }
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
 * A read's exec timeout: `warm` after a read of the workspace succeeded,
 * `cold` otherwise. A private index that is missing, freshly seeded, or
 * left behind by a run killed mid-`add -A` (git writes the index only when
 * `add -A` finishes) makes staging hash every changed file, which takes
 * 20 to 45 seconds for 20,000 changes under gVisor. A run cut off
 * there saves nothing, so every later run would pay it again; the cold
 * timeout lets one finish and leave the index warm. A checkout whose cold
 * staging takes longer still never warms, and every read times out.
 */
const READ_TIMEOUT_MS = { warm: 20_000, cold: 120_000 }

const indexFileIn = (scratchDir: string): string => `${scratchDir}/yaac-changes.idx`

/**
 * Run `cmd`, fetching an output it left in a file (`PRINT_OUTPUT`) in
 * pages, one exec each, as base64 since a page may end inside a character.
 */
async function execPaged(
  jobName: string, indexFile: string, cmd: string, opts: { timeout: number; maxAttempts: number; signal?: AbortSignal; stdin?: string },
): Promise<string> {
  const driver = workspaceDriver()
  const { stdin: _stdin, ...pageOpts } = opts
  const { stdout } = await driver.exec(jobName, cmd, opts)
  const paged = /^PAGED (\d+) (\d+)\n$/.exec(stdout)
  if (!paged) return stdout
  const file = shSingleQuote(`${indexFile}.out.${paged[1]}`)
  const pages: Buffer[] = []
  const size = Number(paged[2])
  if (size > MAX_OUTPUT_PAGES * OUTPUT_PAGE_BYTES) throw new Error(`workspace changes: the run's output is ${size} bytes`)
  let got = 0
  while (got < size) {
    const page = Buffer.from((await driver.exec(
      jobName, `tail -c +${got + 1} ${file} | head -c ${OUTPUT_PAGE_BYTES} | base64`, pageOpts,
    )).stdout, 'base64')
    if (page.length === 0) throw new Error('workspace changes: the run\'s output file ended early')
    pages.push(page)
    got += page.length
  }
  if (got !== size) throw new Error('workspace changes: the run\'s output file is not the size it printed')
  return Buffer.concat(pages).toString('utf8')
}

/**
 * Run the scan, writing the entry file through its stdin and reading the
 * file back when this server has not.
 */
async function runScan(
  jobName: string, held: Held, req: ChangesRequest, opts: { timeout: number; maxAttempts: number; signal: AbortSignal },
): Promise<Scan> {
  const { workspaceDir, scratchDir } = workspaceDriver().workspacePaths(jobName)
  const indexFile = indexFileIn(scratchDir)
  const write = entryFileWrite(held)
  const cmd = `sh -c ${shSingleQuote(scanScript(workspaceDir, indexFile))} yaac-changes `
    + [req.base, req.defaultBase, req.listing, held.listing?.key, held.listing?.extras?.hash, [...held.raws.keys()].join(' '),
      held.file.loaded ? '' : 'load', write.mode].map((a) => shSingleQuote((a ?? '').trim())).join(' ')
  // Whether a failed run wrote the file is unknown, so the next replaces it.
  const stdout = await execPaged(jobName, indexFile, cmd, { ...opts, ...write.mode ? { stdin: write.text } : {} }).catch((err: unknown) => {
    held.file.bytes = Infinity
    throw err
  })
  held.file.bytes = write.mode === 'R' ? write.text.length : held.file.bytes + write.text.length
  // A comparison may have filled more while the scan ran.
  for (const key of write.keys) held.file.unsaved.delete(key)
  const scan = parseScan(stdout)
  if (!held.file.loaded) loadEntries(held, scan.entries)
  for (const [name, lines] of scan.raws) held.raws.set(name, { settings: scan.settings, lines })
  return scan
}

/**
 * A running workspace's diff, and its listing when asked, read inside it.
 * Rejects with `WorkspaceExecError` on failure (`CHANGES_BASE_UNRESOLVED`
 * when a named base has no fork point); a transport failure passes through
 * untranslated, and so does an abort of `signal`, the caller leaving (see
 * `runChangesRead`). The private index sits at a stable path in the scratch
 * dir, so git's stat cache survives between polls.
 *
 * The scan prints only the pairs the server lacks, the fill reads only the
 * entries it lacks, and the answer is assembled from what is held: `files`
 * are the base diff's lines in git's order, each stage is looked up in its
 * own pair, and the body is the parts in order up to the cap. A fill that
 * finds a blob gone has the read run once more, its scan seeding the index
 * afresh.
 */
export function readWorkspaceChanges(
  jobName: string, request: ChangesRequest, signal?: AbortSignal,
): Promise<ChangesReading> {
  return runChangesRead(jobName, request, async (req, abandoned) => {
    const started = Date.now()
    const held = heldFor(jobName)
    const opts = { timeout: READ_TIMEOUT_MS[held.warm ? 'warm' : 'cold'], maxAttempts: 2, signal: abandoned }
    for (let attempt = 0; ; attempt++) {
      try {
        const reading = await readOnce(jobName, held, req, opts)
        held.warm = true
        return { ...reading, readMs: Date.now() - started }
      } catch (err) {
        // A failed read (most often a timeout) may have left the index
        // cold, so the next gets the cold timeout. An abandoned one says
        // nothing of it.
        if (!abandoned.aborted) held.warm = false
        if (attempt > 0 || (err as { code?: unknown }).code !== CHANGES_READING_GONE || abandoned.aborted) throw err
      }
    }
  }, signal)
}

/** One scan and fill, assembled into an answer (see readWorkspaceChanges). */
async function readOnce(
  jobName: string, held: Held, req: ChangesRequest, opts: { timeout: number; maxAttempts: number; signal: AbortSignal },
): Promise<Omit<ChangesReading, 'readMs'>> {
  const scan = await runScan(jobName, held, req, opts)
  const { base, head, agent, work, settings } = scan
  const pairs = {
    committed: [base, head, true],
    staged: [head, agent, true],
    unstaged: [agent, work, false],
    base: [base, work, true],
  } satisfies Record<string, [string, string, boolean]>
  const names = Object.fromEntries(Object.entries(pairs).map(([k, [a, b, renames]]) => [k, pairName(a, b, settings, renames)])) as
    Record<keyof typeof pairs, string>
  if (Object.values(names).some((n) => !held.raws.has(n))) {
    throw new Error('workspace changes: the scan reused a raw diff this server does not hold')
  }
  held.readings.set(`${(req.base ?? '').trim()}\0${(req.defaultBase ?? '').trim()}`, { pairs: Object.values(names), usedAt: Date.now() })
  const needs = [
    needOf(held, names.committed, pairs.committed, false),
    needOf(held, names.staged, pairs.staged, false),
    needOf(held, names.unstaged, pairs.unstaged, false, (l) => l.status === 'A'),
    needOf(held, names.base, pairs.base, req.diff),
  ].filter((n) => n !== null)
  const failed = await fill(jobName, held, needs, work, opts)

  const lines = (name: string): RawLine[] => held.raws.get(name)!.lines
  const entry = (l: RawLine): Entry | undefined => held.entries.get(entryKey(settings, l.line))
  const counts = (l: RawLine): Counts => entry(l)?.counts ?? NO_COUNTS
  const byStage: [ChangeStage, Map<string, Counts>][] = [
    ['committed', new Map(lines(names.committed).map((l) => [l.path, counts(l)]))],
    ['staged', new Map(lines(names.staged).map((l) => [l.path, counts(l)]))],
    ['modified', new Map(lines(names.unstaged).filter((l) => l.status !== 'A').map((l) => [l.path, counts(l)]))],
  ]
  const untracked = new Set(lines(names.unstaged).filter((l) => l.status === 'A').map((l) => l.path))
  const files = lines(names.base).map((l) => {
    const c = counts(l)
    const stages: WorkspaceChange['stages'] = {}
    for (const [stage, byPath] of byStage) {
      const s = byPath.get(l.path)
      if (s) stages[stage] = { additions: s.additions, deletions: s.deletions }
    }
    if (untracked.has(l.path)) stages.untracked = { additions: c.additions, deletions: c.deletions }
    return changeOf(l, c, stages)
  })

  let listing: ChangesReading['listing']
  if (req.listing) {
    const { paths, links } = scan.paths ? { paths: scan.paths, links: scan.links! } : held.listing ?? {}
    let extras = held.listing?.extras
    if (scan.extras?.ignored) extras = { hash: scan.extras.hash, ignored: scan.extras.ignored, untrackedDirs: scan.extras.untrackedDirs ?? [] }
    else if (scan.extras && extras?.hash !== scan.extras.hash) extras = undefined
    if (!paths || !links || (req.listing === 'full' && !extras)) {
      throw new Error('workspace changes: the scan reused a listing this server does not hold')
    }
    held.listing = { key: scan.listed, paths, links, ...extras ? { extras } : {} }
    listing = {
      paths, links, conflicted: scan.conflicted ?? [],
      ...req.listing === 'full' && extras ? { ignored: extras.ignored, untrackedDirs: extras.untrackedDirs } : {},
    }
  }
  prune(held)
  return {
    changes: {
      base, work, baseResolved: scan.baseResolved, files,
      ...req.diff ? bodyOf(lines(names.base), entry, failed) : { truncated: false },
      ...scan.skipped.length ? { skipped: scan.skipped } : {},
    },
    ref: scan.ref,
    ...listing ? { listing } : {},
  }
}

/** Field separator of the compare script's commit record. */
const FS = '\x1f'

/**
 * The diff between two refs (`WorkspaceComparison`), as the Changes pane
 * shows a range or a single commit. Both ends are commits, so there is
 * nothing to stage: the script resolves them and prints the one raw diff
 * unless the server holds it, the fill reads what the entries lack, and the
 * answer is assembled as a changes read's is, from the same entries. Each ref is tried as `origin/<name>` and then
 * as itself (`HEAD` only as itself), like a picked base. With `from`, the
 * diff runs from its merge base with `to`, so two branches compare as
 * GitHub compares them; without, from `to`'s first parent, or the empty
 * tree for a root commit, and `to`'s commit comes along. A ref that does
 * not resolve, or a pair with no common history, exits
 * CHANGES_BASE_UNRESOLVED. The rest of the body is read through
 * `readChangeDiffs`.
 */
export async function readComparison(jobName: string, { from, to }: { from?: string; to: string }): Promise<WorkspaceComparison> {
  const { workspaceDir, scratchDir } = workspaceDriver().workspacePaths(jobName)
  const indexFile = indexFileIn(scratchDir)
  const held = heldFor(jobName)
  const script = `cd ${workspaceDir} 2>/dev/null || exit 3; ${scratchObjects(indexFile)}`
    + 'res() { case $1 in -*|"") return 1;; esac; for c in "origin/$1" "$1"; do '
    + '[ "$1:$c" != HEAD:origin/HEAD ] || continue; git rev-parse -q --verify "$c^{commit}" && return; done; return 1; }; '
    + `to=$(res "$2") || exit ${CHANGES_BASE_UNRESOLVED}; `
    + `if [ -n "$1" ]; then from=$(res "$1") && base=$(git merge-base "$from" "$to") || exit ${CHANGES_BASE_UNRESOLVED}; `
    + 'else base=$(git rev-parse -q --verify "$to^1") || base=$(git hash-object -t tree /dev/null) || exit 6; '
    // A message holds no NUL, so the record ends at the first one.
    + `git log -1 -z --format="%H${FS}%P${FS}%an${FS}%at${FS}%B" "$to" || exit 6; fi; `
    + `t=$to; ${SETTINGS_SH}printf "\\nBASE %s\\nTO %s\\nSETTINGS %s\\n" "$base" "$to" "$cf"; `
    + `case " $3 " in *" $base..$to:$cf "*) ;; *) printf "${M_RAW} %s\\n" "$base..$to:$cf"; `
    + 'git diff --raw --no-abbrev "$base" "$to" || exit 6;; esac; '
    + `printf "\\n${M_OK}\\n"`
  const run = `sh -c ${shSingleQuote(script)} yaac-compare ${[from ?? '', to, [...held.raws.keys()].join(' ')].map(shSingleQuote).join(' ')}`
  const opts = { timeout: 20_000, maxAttempts: 2 }
  const stdout = await execPaged(jobName, indexFile, `o=${indexFile}.out.$$; ${run} > $o 2> $o.err; r=$?; ${PRINT_OUTPUT}`, opts)
  const nul = from ? -1 : stdout.indexOf('\0')
  const scan = parseScan(stdout.slice(nul + 1))
  for (const [name, lines] of scan.raws) held.raws.set(name, { settings: scan.settings, lines })
  const name = pairName(scan.base, scan.work, scan.settings)
  if (!held.raws.has(name)) throw new Error('workspace compare: the run reused a raw diff this server does not hold')
  held.readings.set(`${from ?? ''}...${to}`, { pairs: [name], usedAt: Date.now() })
  const need = needOf(held, name, [scan.base, scan.work, true], true)
  const failed = await fill(jobName, held, need ? [need] : [], scan.work, opts)
  const { lines } = held.raws.get(name)!
  const entry = (l: RawLine): Entry | undefined => held.entries.get(entryKey(scan.settings, l.line))
  let commit: CommitDetail | undefined
  if (nul !== -1) {
    // The message is last, so a separator in it stays part of it.
    const [sha = '', parents = '', author = '', time = '', ...message] = stdout.slice(0, nul).split(FS)
    commit = { sha, parents: parents ? parents.split(' ') : [], author, time: Number(time), message: message.join(FS).trimEnd() }
  }
  const files = lines.map((l) => {
    const counts = entry(l)?.counts ?? NO_COUNTS
    return changeOf(l, counts, { committed: { additions: counts.additions, deletions: counts.deletions } })
  })
  prune(held)
  return { base: scan.base, work: scan.work, baseResolved: true, files, ...bodyOf(lines, entry, failed), ...commit ? { commit } : {} }
}

/**
 * More of a diff the changes poll left out, for the Changes pane: the parts
 * of `files` in the diff from `base` to the working tree `work`, both as a
 * reading answered them, so the parts match that reading's. A renamed
 * file's old path is diffed too, so the pair is found again. The answer is
 * capped as the poll's body is, but with `skip`, it is the one file's part
 * after the first `skip` lines, up to the whole cap, for a reader scrolling
 * down a file whose part was cut.
 *
 * It is the fill (see fillScript), reading only a body. The trees stay in
 * the scratch objects until those pass their cap or the pod restarts; a run
 * that finds either gone fails with `CHANGES_READING_GONE`.
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
  // Paths are named as name-status prints them, quoted when unusual. git
  // fails the whole run on one outside the checkout.
  const paths = pathArgs(files)
  const bad = paths.find((f) => f.includes('\0') || f.startsWith('/') || f.split('/').includes('..'))
  if (bad !== undefined) throw new ServerError('VALIDATION', `${JSON.stringify(bad)} is not a path in the checkout`)
  const { stdout } = await driver.exec(jobName, `sh -c ${shSingleQuote(fillScript(workspaceDir, indexFileIn(scratchDir)))} yaac-diff `
    + [base, work, '', 'd', String(skip ?? 0), String(p), String(t), work, '--', ...paths].map(shSingleQuote).join(' '), { timeout: 20_000 })
  const body = stdout.slice(stdout.indexOf(`${M_BODY}\n`) + M_BODY.length + 1)
  if (endsWithLine(body, M_NODIFF)) throw new Error('workspace changes: git could not diff those files')
  return body
}
