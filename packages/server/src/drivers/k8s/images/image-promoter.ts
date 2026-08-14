import { containerExec } from '#drivers/k8s/substrate'
import { projectRegistryHost } from '#drivers/k8s/cluster'
import { shellQuote } from '#lib/shell'
import { ensureNodeImageStore } from './store-writer'
import { serverLog } from '#log'

/**
 * The PUSH half of the cross-worktree image cache for nested worktrees: a
 * worktree salvages the images its in-pod engine built or pulled into the
 * project's own in-cluster registry. The registry is the source of truth
 * and the only thing that travels between nodes; what a later worktree
 * READS is a per-node materialization of it, mounted read-only
 * (store-writer.ts), so nothing here pins a worktree to the node its
 * predecessor ran on.
 *
 * WHY THE PUSH RUNS INSIDE THE SANDBOX (measured, 2026-07): the salvage's
 * one hard constraint is that no layer may be extracted FILE-BY-FILE
 * through the gVisor gofer — that costs ~2ms/file, and a node_modules-heavy
 * chain is >100k files (a 4GB salvage took 16+ minutes). The registry path
 * never touches the gofer: the engine's graphroot is a sentry-INTERNAL
 * tmpfs (NESTED_GRAPHROOT_ANNOTATIONS), so `podman push` reads layers at
 * native speed, compresses them in-sandbox, and streams them out over
 * netstack as bulk blob uploads. Same shape the trust-split writer pods
 * already push their products with (docs/trust-split-builds.md), which is
 * why the salvage needs no node-side writer at all.
 *
 * What travels:
 *  - every NAMED image, under its own name (`<registry>/<repo>:<tag>`), so
 *    the read side can restore the name a worktree referred to it by —
 *    canonicalized first, see LOCAL_REGISTRY_PREFIX;
 *  - each named image's ANCESTOR chain, under `<repo>:yaac-cache-<tag>-<n>`
 *    in the SAME repo (so its blobs are already there and only manifests
 *    are uploaded). Those intermediates are what `docker build` matches
 *    step-by-step, so without them only a byte-identical rebuild would hit.
 *    Tagging them per named image keeps the tag set BOUNDED: a rebuilt
 *    `app:v1` overwrites the same `yaac-cache-v1-<n>` tags.
 *
 * The read side untags the cache tags after pulling them into a store
 * generation, leaving the intermediates dangling exactly as a local
 * `--layers` build would.
 *
 * Destinations carry NO content hash — they are name-for-name, and the
 * chain tags are slots keyed by (repo, tag, depth). That is what bounds
 * the tag set, and it means concurrent worktrees of one project are
 * last-salvage-wins on a shared name. Nothing corrupts (layers are content-addressed blobs
 * and a manifest PUT is atomic), and a chain left interleaved between two
 * worktrees costs a wasted pull, never a wrong cache hit: buildah matches a
 * candidate on layer parentage AND history, so a foreign intermediate
 * never matches. Clobbered manifests become untagged, which is what
 * reconcileProjectRegistryGc reclaims.
 *
 * Self-gating: every leg runs through sudoExecCommand, which does nothing
 * in a pod that carries no engine, so a non-nested worktree costs a single
 * cheap exec that reports nothing — and the reconcile loop skips even that
 * (worktrees/salvage-reconcile.ts).
 */

/**
 * Tag prefix for an ancestor-chain entry. Never a name a user's image
 * carries: the read side untags exactly these so they stay dangling
 * cache entries.
 */
export const CACHE_TAG_PREFIX = 'yaac-cache-'

/**
 * What a consumer counts as a generation, in the two halves the
 * registry's retention pass (buildRegistryRetentionScript) uses: a
 * yaac-built repo, optionally under a push prefix, carrying a content-hash
 * tag. Both must be mirrored — the repo glob is what keeps a worktree's own
 * repo out of a policy only yaac's chain is subject to, and the tag shape
 * is what tells a generation from a hand-written `v1` or `latest`.
 *
 * The prefixed globs are for repos a registry ALREADY holds: salvage
 * canonicalizes new pushes onto the bare name (LOCAL_REGISTRY_PREFIX), so
 * they only match until the GC drops the legacy subtree. Matching
 * retention exactly is worth more than trimming them — one of the two
 * ceases to be reachable here anyway, since the repo-charset gate in the
 * walk already skips any repo carrying a `:`.
 *
 * Kept as sh fragments because that is where both passes use them; a
 * generation is a shape, not a value, so there is nothing to share but
 * these two strings.
 */
const GENERATION_REPO_GLOBS = 'yaac-*|localhost/yaac-*|localhost:*/yaac-*'
const GENERATION_TAG_RE = '[0-9a-f]{16}'

/**
 * Ledger of `<image id> <destination ref>` pairs this pod has already put
 * in the registry — written by the push, read by the survey. Without it
 * every 10-minute salvage would re-compress what the last one sent. Lives
 * in the graphroot, so it dies with the pod exactly like the storage it
 * describes. It says nothing about what the NODE STORE provided: that is
 * a property of the image, not of this pod's history, and the survey
 * reports it per image (EngineImage.readOnly).
 *
 * The ID is half the key on purpose: a rebuilt `app:v1` is a NEW image
 * under a destination the ledger already lists, and skipping it would lose
 * exactly the work salvage exists to keep. Only an id/dest pair that has
 * already travelled is skipped.
 */
const PUSHED_LEDGER = '/var/lib/containers/.yaac-pushed-refs'

/**
 * Depth cap on one ancestor walk. Dockerfiles run to tens of steps; this
 * only bounds a cyclic/absurd parent chain from generating unbounded work.
 */
export const MAX_CHAIN_DEPTH = 64

/**
 * Content-hash generations a CONSUMER of this registry takes per repo,
 * newest first — what the node image store spends its disk on.
 *
 * A repo carries up to REGISTRY_GENERATIONS_KEPT generations (as wide as
 * the concurrently-live fleet), and the catalog walk has no inherent
 * reason to reach the current one first, so without this a node would
 * warm generations no build will ever cache-hit. Two, not one: a worktree
 * on a branch that has since moved still wants its own generation, and the
 * second slot is what keeps the newest push from evicting it.
 */
export const CACHED_GENERATIONS_KEPT = 2

const IMAGE_ID = /^[0-9a-f]{64}$/
/**
 * Conservative image-ref shape (`host[:port]/path…:tag`, the
 * podman-normalized form). Refs come from the worktree engine —
 * agent-influenced — so anything outside this set is dropped rather than
 * quoted into a push command. The optional `:port` is recognized so that
 * refs pointing INTO this registry parse and can be filtered by name;
 * they are never pushable (see planSalvagePushes).
 */
const IMAGE_REF =
  /^[a-z0-9][a-z0-9._-]*(:[0-9]{1,5})?(\/[a-z0-9][a-z0-9._-]*){0,12}:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/
/** Bound on a whole ref, so nothing unreasonable reaches a command line. */
const IMAGE_REF_MAX = 255

/**
 * Podman's local-registry prefix, stripped before a ref becomes a
 * destination. Every name the engine holds that is not registry-qualified
 * is stored under it — `podman tag x foo:v1` reads back as
 * `localhost/foo:v1` — while everything the SERVER pushes into this same
 * registry (`registryRef`, and inside a nested worktree that is this very
 * registry) uses the bare tag. Same image, two repo paths, and the ledger
 * keys on the destination string, so leaving the prefix on puts every
 * image the two sides share in the catalog twice: `<repo>` and
 * `localhost/<repo>`. That is not free — the copies share no LAYER blobs,
 * since the salvage compresses at level 1 where the host push writes
 * gzip's default level (SALVAGE_COMPRESSION_LEVEL) — and it costs every
 * later store generation a second pull and a second ledger line for bytes
 * it already has.
 *
 * Stripping it round-trips losslessly: the store builder restores the bare
 * name, podman puts the prefix straight back, and the next survey's ref
 * canonicalizes onto the destination already in the ledger — which is what
 * stops the image travelling again. Without that the restore→salvage cycle
 * MANUFACTURES the alias on its own, with no second producer needed.
 *
 * Anchored on the slash, and applied exactly once. `localhost:5000/foo:v1`
 * is a registry-qualified ref that keeps its host (and is dropped as a
 * destination anyway, see planSalvagePushes), and `localhost-mirror/foo`
 * is reported by podman as `localhost/localhost-mirror/foo` — one strip
 * hands back the name its author gave. A ref still carrying the prefix
 * after the strip was `localhost/localhost/…` in the engine; stripping
 * again would rename it, so the planner drops it instead.
 *
 * Only this prefix: `docker.io/…`, `quay.io/…` and friends are real
 * upstream refs whose host is part of the name a worktree pulls them by.
 */
const LOCAL_REGISTRY_PREFIX = 'localhost/'

/** The one destination name a ref maps to (see LOCAL_REGISTRY_PREFIX). */
function canonicalRef(ref: string): string {
  return ref.startsWith(LOCAL_REGISTRY_PREFIX) ? ref.slice(LOCAL_REGISTRY_PREFIX.length) : ref
}

export interface EngineImage {
  id: string
  /** Parent image id, or null for a chain root. */
  parent: string | null
  /** Every `repo:tag` the engine knows this image by, canonicalized
   *  (dangling: empty). */
  refs: string[]
  /**
   * True when the engine holds this image ONLY in the read-only node image
   * store — i.e. it arrived from this very registry (store-writer.ts
   * materializes nothing else), so pushing it back would re-compress the
   * project's whole working set inside the sandbox for bytes the registry
   * already has. An id the worktree ALSO holds writably (it rebuilt or
   * re-tagged it) is not read-only here: that name is new and does travel.
   */
  readOnly: boolean
}

export interface SurveyReport {
  images: EngineImage[]
  /** `<id> <dest>` pairs this pod already pushed or pulled (the ledger). */
  have: Set<string>
}

/** Stale chain slots to drop for one name: everything past `depth`. */
export interface ChainRetire {
  repo: string
  tag: string
  depth: number
}

/** What one salvage hands the worktree pod. */
export interface SalvagePlan {
  pairs: PushPair[]
  retire: ChainRetire[]
}

/** One `podman push <id> <dest>` the push exec is asked to run. */
export interface PushPair {
  id: string
  dest: string
}

/** A ref the engine reported, validated for shape and length. */
function validRef(ref: string): boolean {
  return ref.length <= IMAGE_REF_MAX && IMAGE_REF.test(ref)
}

/**
 * Parse the survey report: `have <id> <dest>` lines from the ledger and
 * `img <id>|<parent>|<ref>,<ref>,` rows from `podman image inspect`.
 * Malformed ids and refs are dropped here so nothing unvalidated reaches a
 * push command.
 */
export function parseSurveyReport(stdout: string): SurveyReport {
  const images: EngineImage[] = []
  const have = new Set<string>()
  // Collected first because a `ro` line may precede or follow its `img`
  // row; the script emits all of them ahead of the inspect output today,
  // but nothing about the format promises that.
  const readOnly = new Set<string>()
  const lines = stdout.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('ro ')) continue
    const id = trimmed.slice(3).trim().replace(/^sha256:/, '')
    if (IMAGE_ID.test(id)) readOnly.add(id)
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('have ')) {
      const [rawId = '', dest = ''] = trimmed.slice(5).trim().split(/\s+/)
      const id = rawId.replace(/^sha256:/, '')
      if (IMAGE_ID.test(id) && validRef(dest)) have.add(`${id} ${dest}`)
      continue
    }
    if (!trimmed.startsWith('img ')) continue
    const [rawId = '', rawParent = '', rawRefs = ''] = trimmed.slice(4).split('|')
    const id = rawId.trim().replace(/^sha256:/, '')
    if (!IMAGE_ID.test(id)) continue
    const parent = rawParent.trim().replace(/^sha256:/, '')
    images.push({
      id,
      readOnly: readOnly.has(id),
      parent: IMAGE_ID.test(parent) ? parent : null,
      // Canonicalized before the sort, so a multi-named image's PRIMARY
      // name — the one its chain slots hang off — is the same in every
      // worktree that sees it, whichever side put the image there.
      refs: rawRefs.split(',').map((r) => r.trim()).filter(validRef).map(canonicalRef).sort(),
    })
  }
  return { images, have }
}

/**
 * The in-pod survey script (step 1), run as root via the image's
 * passwordless sudo (the engine is rootful). Prints the ledger and one row
 * per image — id, parent, and names — which is everything the plan below
 * needs. Read-only: it spawns no push when there is nothing new.
 */
export function buildSurveyScript(): string {
  return [
    'set -u',
    `[ -f ${PUSHED_LEDGER} ] && sed 's/^/have /' ${PUSHED_LEDGER}`,
    // One row per NAME, so an id can appear both writably and read-only
    // (a build that cache-hit the store then tagged its product). Only an
    // id with no writable row at all is store-provided; the awk pass is
    // what turns per-name rows into that per-id answer.
    "rows=$(podman image ls -a --no-trunc --format '{{.ID}} {{.ReadOnly}}' 2>/dev/null)",
    '[ -n "$rows" ] || exit 0',
    `ids=$(printf '%s\\n' "$rows" | awk '{ print $1 }' | sort -u)`,
    `printf '%s\\n' "$rows" | awk '{ if ($2 == "false") w[$1] = 1; all[$1] = 1 } `
    + `END { for (i in all) if (!(i in w)) print "ro " i }'`,
    // shellcheck disable=SC2086 — word splitting of $ids is the point.
    'podman image inspect --format '
    + "'img {{.Id}}|{{.Parent}}|{{range .RepoTags}}{{.}},{{end}}' $ids 2>/dev/null || true",
  ].join('\n')
}

/**
 * Compression for salvage pushes. The format is not a tuning knob — it is
 * what decides whether this whole cache ever hits.
 *
 * A push MUST NOT change an image's MANIFEST TYPE. buildah only considers
 * a cache candidate whose manifest type equals the format the running
 * build emits, so an image that changed type on the way through the
 * registry is invisible to the build it was salvaged for. The worktree's
 * `docker` is the real Docker CLI against podman's Docker-compatible API,
 * which emits docker-schema2, while a bare `podman build` emits OCI — the
 * store holds both, and each has to come back as what it was.
 *
 * zstd forces exactly that conversion: schema2 has no zstd layer media
 * type, so a zstd push rewrites a schema2 image as OCI (silently — the
 * push succeeds and the layers are intact), and every `docker build` in
 * the next worktree then skips the entire cache. gzip has media types
 * in both schemas, so it preserves either one in place, and the image id
 * survives the round trip unchanged with it.
 *
 * Level 1 within gzip: CPU is the scarce resource here, not disk. The
 * compression runs INSIDE the worktree sandbox, competing with the agent's
 * own work under the sentry, whereas the bytes land in a node-local
 * registry — so the cheapest gzip is the right one. (For scale, measured
 * in a worktree pod on a 576MB layer of real binaries, default-level gzip
 * costs 20.6s of CPU to push and 15.2s wall to pull back.)
 *
 * The consequence to know: a level-1 blob does not dedupe against the
 * default-level blob a host-side push of the same layer writes. That
 * costs registry bytes when both producers push one image, never a wrong
 * hit — and the ledger already keeps a restored image from being pushed
 * back, which is where the two sides would otherwise meet.
 *
 * Deliberately not `--disable-compression`, which would trade the disk
 * this registry is short of for the CPU it is trying to save.
 */
export const SALVAGE_COMPRESSION = 'gzip'
export const SALVAGE_COMPRESSION_LEVEL = 1

/**
 * The push script (step 2): `id dest` pairs arrive as argv — validated by
 * the planner against IMAGE_ID / IMAGE_REF and never interpolated into the
 * script text. Each success appends its dest to the ledger, so the next
 * salvage skips it. `--tls-verify=false`: the project registry is plain
 * HTTP on 5000 (see projectRegistryConfDropIn).
 *
 * `nice -n 19` because this is background work sharing a sandbox with an
 * interactive agent: the sentry honors nice in its own scheduling, so the
 * worktree's foreground work wins the CPU, and the host sees the softened
 * priority too since the sandbox threads carry it.
 */
export function buildPushScript(): string {
  return [
    'set -u',
    'ok=0; fail=0',
    'while [ "$#" -ge 2 ]; do',
    `  if nice -n 19 podman push --tls-verify=false --compression-format ${SALVAGE_COMPRESSION} `
    + `--compression-level ${SALVAGE_COMPRESSION_LEVEL} "$1" "$2" >/dev/null 2>&1; then`,
    // id AND dest: a rebuilt tag is a new id under a dest already listed.
    `    echo "$1 $2" >> ${PUSHED_LEDGER}; ok=$((ok+1))`,
    '  else',
    '    fail=$((fail+1))',
    '  fi',
    '  shift 2',
    'done',
    'echo "pushed $ok failed $fail"',
  ].join('\n')
}

/** Manifest media types the registry must answer a HEAD/GET with. */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',')

/**
 * The retire script: drop chain slots a rebuild no longer fills.
 *
 * `repo tag depth` triples arrive as argv. A chain is always pushed as a
 * contiguous 1..depth, so anything at depth+1 belongs to a longer previous
 * generation and can never be reached again — this deletes those manifests
 * (registry:2 `DELETE /manifests/<digest>`, which needs delete enabled on
 * the Deployment) and stops at the first slot that is already empty. The
 * blobs behind them are reclaimed by the registry GC's `--delete-untagged`
 * pass. Without this, a shorter rebuild would strand its tail forever and
 * every future store generation would carry dead intermediates.
 *
 * Accepted imprecision: registry:2 can only delete a MANIFEST by digest,
 * which drops every tag in the repo pointing at it. Two names in one repo
 * share their prefix intermediates, so retiring `app:v1`'s tail can untag
 * a slot `app:v2` still fills. That costs the next generation a cold slot
 * — a rebuild, never a wrong hit — and a later worktree refills it; the pod
 * that pushed it will not, since its ledger already lists the pair.
 *
 * Failures are counted, not swallowed. The registry refuses DELETE with a
 * 405 for the whole of a blob collect's read-only window, and a salvage
 * runs detached in the same reconcile pass that starts one — so a retire
 * CAN land in it. The caller only records the shape as retired when
 * nothing failed, which is what makes the next cycle try again instead of
 * stranding those slots until the chain changes shape.
 */
export function buildRetireScript(registryHost: string): string {
  const curl = 'curl -fsS --max-time 20'
  return [
    'set -u',
    'command -v curl >/dev/null 2>&1 || exit 0',
    `REG=${registryHost}`,
    'n=0; f=0',
    'while [ "$#" -ge 3 ]; do',
    '  repo="$1"; tag="$2"; depth="$3"; shift 3',
    '  i=$((depth+1))',
    `  while [ "$i" -le $((depth+${MAX_CHAIN_DEPTH})) ]; do`,
    `    slot="${CACHE_TAG_PREFIX}$tag-$i"`,
    `    dg=$(${curl} -I -H "Accept: ${MANIFEST_ACCEPT}" "http://$REG/v2/$repo/manifests/$slot" 2>/dev/null`
    + ` | tr -d '\r' | awk 'tolower($1) == "docker-content-digest:" { print $2 }')`,
    '    [ -n "$dg" ] || break',
    `    if ${curl} -X DELETE "http://$REG/v2/$repo/manifests/$dg" >/dev/null 2>&1; then`,
    '      n=$((n+1))',
    '    else',
    '      f=$((f+1))',
    '    fi',
    '    i=$((i+1))',
    '  done',
    'done',
    'echo "retired $n failed $f"',
  ].join('\n')
}

/**
 * The sh fragment that turns a project registry into the WORKING SET a
 * consumer should take: it sets `$repos` to the catalog and defines
 * `ranked_tags <repo>`, which prints that repo's tags in pull order with
 * the dead generations dropped. Requires `$REG` and `curl` in scope.
 *
 * Shared rather than duplicated because it is the mirror image of what
 * salvage writes: the `yaac-cache-` slots, the content-hash generation
 * shape, and the repo glob all come from this module, and a consumer that
 * disagreed with any of them would either miss live layers or warm dead
 * ones. The node image store (store-writer.ts) is the consumer today.
 *
 * A yaac-built repo's content-hash tags (GENERATION_REPO_GLOBS,
 * GENERATION_TAG_RE) are ranked newest-first and all but
 * CACHED_GENERATIONS_KEPT dropped, along with the chain slots of the
 * generations dropped — an old generation's intermediates cache-hit
 * nothing once its named image is gone. Within what survives, a named tag
 * comes before its chain slots, so the image a worktree actually refers to
 * is warmed before the intermediates that only accelerate a rebuild.
 *
 * Catalog/tag JSON is scraped with `tr`/`sed` rather than a JSON parser:
 * both documents are a single flat array, and every value is re-validated
 * against the ref charset before it reaches a podman command. The image
 * config, which the generation ranking reads, is not flat — its `created`
 * is scraped by taking the LATEST of every `created` in the document
 * (config plus history entries), which needs no field ordering to hold.
 */
export function rankedRegistryTagsScript(): string {
  const curl = 'curl -fsS --max-time 20'
  const arrayScrape = `tr -d ' "' | sed -e 's/.*\\[//' -e 's/\\].*//' | tr ',' '\\n'`
  return [
    // A registry that cannot be REACHED must not read as a registry that is
    // EMPTY: the difference is "retry" versus "this project has nothing to
    // warm", and a consumer that confused them would publish a no-content
    // result every time it raced the registry's maintenance rollout. The
    // fetch's own exit status is therefore the gate, while the scrape is
    // allowed to come back empty.
    `catalog=$(${curl} "http://$REG/v2/_catalog?n=1000" 2>/dev/null) `
    + '|| { echo "registry-unreachable" >&2; exit 1; }',
    `repos=$(printf '%s' "$catalog" | ${arrayScrape} | grep -Ex '[a-z0-9./_-]+' || true)`,
    'ranked_tags() {',
    '  repo="$1"',
    `  tags=$(${curl} "http://$REG/v2/$repo/tags/list" 2>/dev/null | ${arrayScrape} `
    + `| grep -Ex '[A-Za-z0-9._-]+' || true)`,
    '  [ -n "$tags" ] || return 0',
    // Keep only the newest CACHED_GENERATIONS_KEPT content-hash generations
    // and their chain slots. Ranked by the image config's own build time,
    // the same "creation order IS generation order" the registry's
    // retention pass relies on — content-hash tags are write-once, so the
    // two orders cannot diverge.
    //
    // Gated on BOTH halves of that pass's guard, repo shape and tag shape,
    // so the two agree on what a generation is. Tag shape alone would rank
    // a worktree's own `myapp:$(git rev-parse --short=16 HEAD)` as
    // generations and leave its older tags cold — this deletes nothing, so
    // that costs a warm-up, but it is a repo retention has no say over
    // either.
    `  gens=''`,
    `  keep=''`,
    '  case "$repo" in',
    `    ${GENERATION_REPO_GLOBS}) gens=$(printf '%s\\n' $tags | grep -Ex '${GENERATION_TAG_RE}' || true);;`,
    '  esac',
    '  if [ -n "$gens" ]; then',
    '    keep=$(for g in $gens; do',
    `      cfg=$(${curl} -H "Accept: ${MANIFEST_ACCEPT}" "http://$REG/v2/$repo/manifests/$g" 2>/dev/null`
    + ` | tr -d ' \\n' | sed -n 's/.*"config":{[^}]*"digest":"\\([^"]*\\)".*/\\1/p')`,
    `      c=$(${curl} "http://$REG/v2/$repo/blobs/$cfg" 2>/dev/null`
    + ` | grep -o '"created":"[^"]*"' | cut -d'"' -f4 | sort -r | head -1)`,
    // A config that would not scrape sorts NEWEST, not oldest. Ranking is
    // best-effort and one transient curl error must not cost the consumer
    // the generation its next build would have cache-hit — which sorting
    // the unrankable last does exactly, and silently. Erring the other way
    // costs at worst a slot spent on a candidate whose pull then fails,
    // which every caller already handles. `9` outranks any RFC3339 year.
    '      echo "${c:-9} $g"',
    `    done | sort -r | head -n ${CACHED_GENERATIONS_KEPT}`
    + ` | awk '{print $2}' | tr '\\n' '|' | sed 's/|$//')`,
    '  fi',
    // Everything that is not generation-shaped, plus the generations kept
    // and the chain slots belonging to them.
    //
    // Gated on a NON-EMPTY `keep`: an empty one means every ranking fetch
    // failed, and this filter would then match nothing and retire a repo's
    // whole generation set on one bad minute. Warming the repo whole is the
    // right answer to "I could not rank it".
    '  if [ -n "$keep" ]; then',
    `    tags=$(printf '%s\\n' $tags | grep -Ev '^(${GENERATION_TAG_RE}|${CACHE_TAG_PREFIX}${GENERATION_TAG_RE}-[0-9]+)$' || true; `
    + `printf '%s\\n' $tags | grep -E "^($keep)\\$|^${CACHE_TAG_PREFIX}($keep)-[0-9]+\\$" || true)`,
    '  fi',
    // Named tags first, then the chain slots that only speed up a rebuild.
    `  printf '%s\\n' $tags | grep -v "^${CACHE_TAG_PREFIX}" || true`,
    `  printf '%s\\n' $tags | grep "^${CACHE_TAG_PREFIX}" || true`,
    '}',
  ].join('\n')
}

/**
 * Wrap an in-pod script in the gate every leg of the salvage shares: images
 * and storage belong to the rootful engine, so nothing here runs unless this
 * pod HAS one, and an image without passwordless sudo no-ops quietly. Extra
 * argv (validated push pairs) is appended after the script, reaching it as
 * `$@`.
 *
 * The engine test is the pod's own YAAC_NESTED_ENGINE — set by
 * worktree-create for exactly the pods whose init script starts an engine
 * (`domain/worktrees/create.ts`, read again by worktree-bin/yaac-worktree-init)
 * — and NOT `command -v podman`. A binary's presence never answered the
 * question being asked: an image can ship podman and run no engine, which
 * every pod built before podman left the base image does. Running it there
 * is not the harmless no-op that reading it suggests. Unconfigured rootless
 * podman under sudo resolves its runtime dir to a RELATIVE `libpod/tmp`, and
 * an exec inherits the container's workingDir — so the probe plants a
 * root-owned 0700 directory in the user's checkout, where it breaks any tool
 * that walks the repo and leaves the worktree undeletable.
 */
export function sudoExecCommand(script: string, argv: string[] = []): string {
  const args = argv.map((a) => ` ${shellQuote(a)}`).join('')
  const sudoRun = `exec sudo -n -H sh -c ${shellQuote(script)} --${args}`
  return `sh -c ${shellQuote(
    '[ "${YAAC_NESTED_ENGINE:-}" = 1 ] || exit 0; '
    + 'command -v sudo >/dev/null 2>&1 || exit 0; '
    + `sudo -n true 2>/dev/null || exit 0; ${sudoRun}`,
  )}`
}

/**
 * Turn a survey into the salvage plan: every named image under its own
 * name, then its ancestors under `<repo>:yaac-cache-<tag>-<n>`, plus the
 * chain depth each name ended up with so the retire leg can drop slots a
 * previous, longer generation left behind.
 *
 * A named image is planned before its own chain on purpose — its layers
 * land in the repo the chain entries then reuse, so the intermediates
 * upload manifests only. The walk stops at an ancestor that is itself
 * named (it gets its own push, and the restore side re-links it), at one
 * the node image store provided (see EngineImage.readOnly), at
 * MAX_CHAIN_DEPTH, and at any id/dest pair already in the ledger.
 *
 * Only a walk that ran the chain OUT yields a retire entry. The retire leg
 * exists on the premise that a chain is pushed as a contiguous 1..depth, so
 * anything past `depth` belongs to a longer previous generation and can
 * never be reached again — and a walk that stopped at a STORE-PROVIDED
 * ancestor breaks exactly that premise: the chain continues in the
 * registry above the stop, and those upper slots are the shared, rarely
 * changing prefix a cold node's cache is mostly made of. Retiring them
 * would be permanent (salvage skips read-only images, so nothing re-pushes
 * them) and would compound, since a build's cache misses cascade from the
 * first missed step. The cost of not retiring is a few stranded tags,
 * which the ranking already tolerates.
 *
 * Refs arrive already canonicalized (LOCAL_REGISTRY_PREFIX), which is what
 * keeps one image to one repo no matter which side pushed it first. Three
 * kinds never become a destination, all of them "there is no name to push
 * this under": one already inside this registry (an image the worktree
 * pulled from it by ref); one whose repo carries a `host:port`, which
 * a destination repo path cannot hold; and one still prefixed after
 * canonicalization, i.e. an engine name of `localhost/localhost/…`, whose
 * only canonical destination is a repo path the registry GC treats as a
 * stale alias and deletes.
 *
 * Canonicalizing lands a worktree's local names on the same repos the
 * server's own pushes use, so a worktree that locally tags a mirror's name
 * can now overwrite that repo. Bounded to the project's own registry and
 * already the documented semantic (last salvage wins on a shared name);
 * a worktree could always push those repos directly, so this grants no
 * authority it did not have.
 */
export function planSalvagePushes(report: SurveyReport, registryHost: string): SalvagePlan {
  const byId = new Map(report.images.map((img) => [img.id, img]))
  const named = new Set(report.images.filter((img) => img.refs.length > 0).map((img) => img.id))
  const pairs: PushPair[] = []
  const retire: ChainRetire[] = []
  const seen = new Set<string>()

  const add = (id: string, dest: string): void => {
    if (report.have.has(`${id} ${dest}`) || seen.has(dest)) return
    seen.add(dest)
    pairs.push({ id, dest })
  }

  for (const img of report.images) {
    // A store-provided image is already in this registry by construction —
    // the node store is nothing but a materialization of it — so pushing
    // it back would re-compress the project's whole working set inside the
    // sandbox for bytes that are already there.
    if (img.readOnly) continue
    const refs = img.refs.filter((ref) =>
      !ref.startsWith(`${registryHost}/`)
      && !ref.startsWith(LOCAL_REGISTRY_PREFIX)
      && !ref.slice(0, ref.lastIndexOf(':')).includes(':'))
    if (refs.length === 0) continue
    for (const ref of refs) add(img.id, `${registryHost}/${ref}`)

    // Chain slots hang off the image's primary (lowest-sorting) name, so a
    // rebuild of that name refills the same slots instead of accumulating
    // a generation.
    const primary = refs[0]
    const colon = primary.lastIndexOf(':')
    const repo = primary.slice(0, colon)
    const tag = primary.slice(colon + 1)
    let cursor = byId.get(img.id)?.parent ?? null
    let depth = 0
    // Whether the walk ended because the chain genuinely ran out — which is
    // what makes "everything past `depth` is unreachable" true, and so what
    // licenses the retire below.
    let ended = true
    for (; cursor && depth < MAX_CHAIN_DEPTH; ) {
      // Stop at an ancestor that already travelled: one with a name of its
      // own (it gets its own push, and the restore side re-links it), or
      // one the node store provided — the next worktree's store carries
      // that ancestor too, so a slot tag for it would buy nothing.
      if (named.has(cursor)) break
      if (byId.get(cursor)?.readOnly) {
        ended = false
        break
      }
      depth += 1
      add(cursor, `${registryHost}/${repo}:${CACHE_TAG_PREFIX}${tag}-${depth}`)
      cursor = byId.get(cursor)?.parent ?? null
    }
    if (ended) retire.push({ repo, tag, depth })
  }
  return { pairs, retire }
}

/** Parse the retire script's trailing `retired <n> failed <n>` line. */
export function parseRetireReport(stdout: string): { retired: number; failed: number } {
  const m = /retired (\d+) failed (\d+)/.exec(stdout)
  return { retired: Number(m?.[1] ?? 0), failed: Number(m?.[2] ?? 0) }
}

/** Parse the push script's trailing `pushed <n> failed <n>` line. */
export function parsePushReport(stdout: string): { pushed: number; failed: number } {
  const m = /pushed (\d+) failed (\d+)/.exec(stdout)
  return { pushed: Number(m?.[1] ?? 0), failed: Number(m?.[2] ?? 0) }
}

/** Per-worktree in-flight guard so the background reconciler and a teardown
 *  never run two salvages for one worktree concurrently. */
const salvageInflight = new Map<string, Promise<boolean>>()

/** Per-worktree chain shape whose stale slots have already been retired —
 *  one short string per worktree this process has salvaged. */
const lastRetiredShape = new Map<string, string>()

/** Test hook: forget which chain shapes have been retired. */
export function _resetSalvageMemoForTests(): void {
  lastRetiredShape.clear()
}

export interface SalvageOptions {
  /** Deadline for the in-pod survey exec. Default 120s — it only reads
   *  image metadata, but a busy engine serializes it behind a build. */
  surveyTimeoutMs?: number
  /** Deadline for the push exec. Default 600s — compressing and uploading
   *  a multi-GB chain is the slow leg. */
  pushTimeoutMs?: number
  /** Deadline for the stale-slot retire exec. Default 120s — a handful of
   *  HEADs and DELETEs against the registry. */
  retireTimeoutMs?: number
}

/**
 * Run one salvage for a worktree: survey in-pod, plan, push the new images
 * into the project registry. Best-effort — any failure is logged and
 * swallowed, because teardown must never be blocked on cache salvage.
 * Returns true when the salvage ran cleanly (including the no-op cases).
 * Concurrent calls for the same worktree coalesce.
 */
export async function salvageWorktreeImages(params: {
  jobName: string
  projectSlug: string
  worktreeId: string
  opts?: SalvageOptions
}): Promise<boolean> {
  const { worktreeId } = params
  const existing = salvageInflight.get(worktreeId)
  if (existing) return existing
  const run = salvageWorktreeImagesUncoalesced(params).finally(() => {
    salvageInflight.delete(worktreeId)
  })
  salvageInflight.set(worktreeId, run)
  return run
}

async function salvageWorktreeImagesUncoalesced(params: {
  jobName: string
  projectSlug: string
  worktreeId: string
  opts?: SalvageOptions
}): Promise<boolean> {
  const { jobName, projectSlug, worktreeId, opts } = params
  const registryHost = projectRegistryHost(projectSlug)

  let report: SurveyReport
  try {
    const { stdout } = await containerExec(jobName, sudoExecCommand(buildSurveyScript()), {
      timeout: opts?.surveyTimeoutMs ?? 120_000,
      maxAttempts: 1,
    })
    report = parseSurveyReport(stdout)
  } catch (err) {
    console.warn(`Image salvage survey for ${jobName} failed: ${(err as Error).message}`)
    return false
  }
  const { pairs, retire } = planSalvagePushes(report, registryHost)
  // The chain shape this pod last retired for. Retire is NOT gated behind
  // having something to push: a crash between the two legs would otherwise
  // strand the tail until some rebuild changed an id, since every later
  // salvage no-ops before reaching it. Gating on the shape instead keeps
  // the steady-state no-op cycle at one exec.
  const shape = retire.map((r) => `${r.repo}:${r.tag}=${r.depth}`).sort().join(',')
  const retireNeeded = retire.length > 0 && lastRetiredShape.get(worktreeId) !== shape
  if (pairs.length === 0 && !retireNeeded) return true

  let pushed = 0
  let failed = 0
  if (pairs.length > 0) {
    try {
      const argv = pairs.flatMap(({ id, dest }) => [id, dest])
      const { stdout } = await containerExec(
        jobName,
        sudoExecCommand(buildPushScript(), argv),
        { timeout: opts?.pushTimeoutMs ?? 600_000, maxAttempts: 1 },
      )
      ;({ pushed, failed } = parsePushReport(stdout))
    } catch (err) {
      console.warn(`Image salvage push for ${jobName} failed: ${(err as Error).message}`)
      return false
    }
  }

  // Slots a shorter rebuild left behind. Best-effort on its own: a stranded
  // tag costs future store generations a wasted pull, never correctness.
  let retired = 0
  if (retireNeeded) {
    const triples = retire.flatMap(({ repo, tag, depth }) => [repo, tag, String(depth)])
    const out = await containerExec(
      jobName,
      sudoExecCommand(buildRetireScript(registryHost), triples),
      { timeout: opts?.retireTimeoutMs ?? 120_000, maxAttempts: 1 },
    ).catch((err: unknown) => {
      console.warn(`Chain retire for ${jobName} failed: ${(err as Error).message}`)
      return null
    })
    if (out) {
      const report = parseRetireReport(out.stdout)
      retired = report.retired
      // Only a clean run counts as done. A retire that lands in this
      // project's own blob-collect window gets 405 on every DELETE, and
      // recording the shape then would strand those slots until the chain
      // changed shape on its own.
      if (report.failed === 0) lastRetiredShape.set(worktreeId, shape)
    }
  }

  serverLog(
    `[server] image salvage: session=${worktreeId} planned=${pairs.length} `
    + `pushed=${pushed} failed=${failed} retired=${retired} registry=${registryHost}`,
  )

  // A push that landed is the one moment this project's registry gained
  // content, so it is the moment worth rebuilding the node image store on —
  // otherwise the next worktree would mount a generation predating the work
  // its predecessor just salvaged, and wait out the reconcile throttle for
  // it. Detached and forced past that throttle; the store builder still
  // serializes per project.
  //
  // The relative import back into the folder's other half is call-time
  // only (store-writer reads this module's ranking fragment to decide what
  // to pull), which is what keeps the two-way edge harmless.
  if (pushed > 0) void ensureNodeImageStore(projectSlug, { force: true })
  return true
}
