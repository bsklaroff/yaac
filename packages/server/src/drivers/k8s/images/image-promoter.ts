import { containerExec } from '#drivers/k8s/substrate'
import { projectRegistryHost } from '#drivers/k8s/cluster'
import { shellQuote } from '#lib/shell'
import { ensureNodeImageStore } from './store-writer'
import { serverLog } from '#log'

/**
 * The push half of the nested-workspace image cache
 * (docs/nested-containers.md "Salvage"): a workspace pushes the images its
 * in-pod engine built or pulled to the project's in-cluster registry. Later
 * workspaces read them from a per-node copy (store-writer.ts).
 *
 * The push runs inside the sandbox. Extracting layers file by file through
 * the gVisor gofer is far too slow (~2ms per file), while the engine's
 * graphroot is a sentry-internal tmpfs, so `podman push` reads it at native
 * speed and uploads blobs over the network.
 *
 * What is pushed:
 *  - every named image, under its own (canonicalized) name;
 *  - each named image's ancestor chain, as `<repo>:yaac-cache-<tag>-<n>`
 *    in the same repo, so `docker build` can match cached steps. Keying
 *    slots by (repo, tag, depth) bounds the tag set.
 *
 * Concurrent workspaces of one project overwrite each other's names (last
 * push wins). That can waste a pull but never cause a wrong cache hit:
 * buildah matches on layer parentage and history. Overwritten manifests
 * are reclaimed by `reconcileProjectRegistryGc`.
 *
 * In a pod with no engine every step is a no-op, and the reconcile loop
 * skips non-nested pods anyway (workspaces/salvage-reconcile.ts).
 *
 * This module and store-writer.ts import each other. That is safe only
 * because neither calls into the other at module load; keep it that way.
 */

/** Tag prefix for ancestor-chain slots; the read side leaves these
 *  untagged, like a local `--layers` build's intermediates. */
export const CACHE_TAG_PREFIX = 'yaac-cache-'

/**
 * What counts as a yaac content-hash generation: a `yaac-*` repo with a
 * 16-hex tag. Must match the registry retention pass
 * (buildRegistryRetentionScript). Shell fragments, since both uses are
 * shell.
 */
const GENERATION_REPO_GLOBS = 'yaac-*'
const GENERATION_TAG_RE = '[0-9a-f]{16}'

/**
 * In-pod ledger of `<image id> <destination>` pairs already pushed, so each
 * salvage skips them. Keyed on the id too, since a rebuilt `app:v1` is a
 * new image under the same destination. Lives in the graphroot and dies
 * with the pod.
 */
const PUSHED_LEDGER = '/var/lib/containers/.yaac-pushed-refs'

/** Depth cap on one ancestor walk, against cyclic or absurd chains. */
const MAX_CHAIN_DEPTH = 64

/**
 * Newest content-hash generations per repo that the node image store
 * pulls (the registry keeps more). Two, so a workspace on an older branch
 * still finds its own.
 */
export const CACHED_GENERATIONS_KEPT = 2

const IMAGE_ID = /^[0-9a-f]{64}$/
/**
 * Conservative image-ref shape (`host[:port]/path…:tag`). Refs come from
 * the agent-influenced workspace engine, so anything else is dropped
 * rather than put in a push command. `:port` is accepted only so refs into
 * this registry can be recognized and skipped (planSalvagePushes).
 */
const IMAGE_REF =
  /^[a-z0-9][a-z0-9._-]*(:[0-9]{1,5})?(\/[a-z0-9][a-z0-9._-]*){0,12}:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/
/** Bound on a whole ref, so nothing unreasonable reaches a command line. */
const IMAGE_REF_MAX = 255

/**
 * Podman's prefix for unqualified local names (`podman tag x foo:v1` reads
 * back as `localhost/foo:v1`), stripped once before a ref becomes a
 * destination. Without this, images the server pushes under the bare name
 * would also be salvaged under `localhost/<repo>`, and the store's
 * restore-then-salvage cycle would create duplicates on its own.
 *
 * A ref still prefixed after one strip (`localhost/localhost/…`) is dropped
 * by the planner. Real upstream hosts (`docker.io/…`) are left alone.
 */
const LOCAL_REGISTRY_PREFIX = 'localhost/'

/** The one destination name a ref maps to (see LOCAL_REGISTRY_PREFIX). */
function canonicalRef(ref: string): string {
  return ref.startsWith(LOCAL_REGISTRY_PREFIX) ? ref.slice(LOCAL_REGISTRY_PREFIX.length) : ref
}

interface EngineImage {
  id: string
  /** Parent image id, or null for a chain root. */
  parent: string | null
  /** Every `repo:tag` the engine knows this image by, canonicalized
   *  (dangling: empty). */
  refs: string[]
  /**
   * True when the image exists only in the read-only node image store, so
   * it came from this registry and is not pushed back. An id the workspace
   * also holds writably (e.g. re-tagged) is not read-only.
   */
  readOnly: boolean
}

interface SurveyReport {
  images: EngineImage[]
  /** `<id> <dest>` pairs this pod already pushed or pulled (the ledger). */
  have: Set<string>
}

/** Stale chain slots to drop for one name: everything past `depth`. */
interface ChainRetire {
  repo: string
  tag: string
  depth: number
}

/** What one salvage hands the workspace pod. */
interface SalvagePlan {
  pairs: PushPair[]
  retire: ChainRetire[]
}

/** One `podman push <id> <dest>` the push exec is asked to run. */
interface PushPair {
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
function parseSurveyReport(stdout: string): SurveyReport {
  const images: EngineImage[] = []
  const have = new Set<string>()
  // Collected first so line order does not matter.
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
      // Canonicalize before sorting so the primary name (which chain
      // slots use) is the same in every workspace.
      refs: rawRefs.split(',').map((r) => r.trim()).filter(validRef).map(canonicalRef).sort(),
    })
  }
  return { images, have }
}

/**
 * The in-pod survey script, run as root via sudo (the engine is rootful).
 * Prints the ledger, `ro <id>` for store-only images, and one row per
 * image with its id, parent and names.
 */
function buildSurveyScript(): string {
  return [
    'set -u',
    `[ -f ${PUSHED_LEDGER} ] && sed 's/^/have /' ${PUSHED_LEDGER}`,
    // Rows are per name, so an id can be both writable and read-only; it
    // is store-only when it has no writable row.
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
 * Compression for salvage pushes. Must be gzip: a push must not change an
 * image's manifest type, because buildah only uses cache candidates of the
 * type the build emits (docker-schema2 from the Docker CLI, OCI from
 * `podman build`). Schema2 has no zstd media type, so zstd silently
 * converts it to OCI and `docker build` never hits the cache.
 *
 * Level 1 because compression runs inside the sandbox, competing with the
 * agent for CPU. These blobs do not dedupe with host-pushed default-level
 * ones, which only costs registry space.
 */
export const SALVAGE_COMPRESSION = 'gzip'
const SALVAGE_COMPRESSION_LEVEL = 1

/**
 * The push script. Validated `id dest` pairs arrive as argv, never in the
 * script text. Each success is added to the ledger. The project registry
 * is plain HTTP (projectRegistryConfDropIn). `nice -n 19` so the agent's
 * work gets the CPU first.
 */
function buildPushScript(): string {
  return [
    'set -u',
    'ok=0; fail=0',
    'while [ "$#" -ge 2 ]; do',
    `  if nice -n 19 podman push --tls-verify=false --compression-format ${SALVAGE_COMPRESSION} `
    + `--compression-level ${SALVAGE_COMPRESSION_LEVEL} "$1" "$2" >/dev/null 2>&1; then`,
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
 * The retire script: delete chain slots a shorter rebuild no longer fills.
 * `repo tag depth` triples arrive as argv. Chains are pushed as contiguous
 * 1..depth, so slots from depth+1 up are deleted (by manifest digest) until
 * the first empty one; registry GC frees the blobs.
 *
 * Deleting by digest drops every tag pointing at that manifest, so it can
 * untag a slot another name in the repo shares. That only costs a cache
 * miss.
 *
 * Failures are counted: the registry refuses DELETE during a collect's
 * read-only window, and the caller only records the retire when nothing
 * failed, so it is retried next time.
 */
function buildRetireScript(registryHost: string): string {
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
 * Shell fragment that picks what a consumer (the node image store) pulls
 * from a project registry. Sets `$repos` to the catalog and defines
 * `ranked_tags <repo>`, which prints the repo's tags in pull order. Needs
 * `$REG` and `curl`.
 *
 * In yaac-built repos only the newest CACHED_GENERATIONS_KEPT content-hash
 * generations (and their chain slots) are kept; named tags come before
 * chain slots. JSON is scraped with `tr`/`sed`, and every value is checked
 * against the ref charset before reaching podman. A config's build time is
 * the latest `created` value in it.
 */
export function rankedRegistryTagsScript(): string {
  const curl = 'curl -fsS --max-time 20'
  const arrayScrape = `tr -d ' "' | sed -e 's/.*\\[//' -e 's/\\].*//' | tr ',' '\\n'`
  return [
    // An unreachable registry must fail, not look empty, so the caller
    // retries instead of publishing an empty store.
    `catalog=$(${curl} "http://$REG/v2/_catalog?n=1000" 2>/dev/null) `
    + '|| { echo "registry-unreachable" >&2; exit 1; }',
    `repos=$(printf '%s' "$catalog" | ${arrayScrape} | grep -Ex '[a-z0-9./_-]+' || true)`,
    'ranked_tags() {',
    '  repo="$1"',
    `  tags=$(${curl} "http://$REG/v2/$repo/tags/list" 2>/dev/null | ${arrayScrape} `
    + `| grep -Ex '[A-Za-z0-9._-]+' || true)`,
    '  [ -n "$tags" ] || return 0',
    // Rank generations by build time from the image config. Match both
    // repo and tag shape, as retention does, so a workspace's own
    // 16-hex tags are not treated as generations.
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
    // An unreadable config ranks newest (`9` beats any year), so a
    // transient error never drops the generation a build needs.
    '      echo "${c:-9} $g"',
    `    done | sort -r | head -n ${CACHED_GENERATIONS_KEPT}`
    + ` | awk '{print $2}' | tr '\\n' '|' | sed 's/|$//')`,
    '  fi',
    // Keep non-generation tags plus the kept generations and their slots.
    // An empty `keep` means ranking failed, so the repo is pulled whole.
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
 * Wrap an in-pod script so it runs as root via passwordless sudo, and only
 * in a pod with a nested engine. Extra argv reaches the script as `$@`.
 *
 * The gate is `YAAC_NESTED_ENGINE=1` (set by domain/workspaces/create.ts),
 * not `command -v podman`: an image can ship podman without running an
 * engine, and podman under sudo there would create a root-owned
 * `libpod/tmp` in the user's checkout.
 */
function sudoExecCommand(script: string, argv: string[] = []): string {
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
 * name, then its ancestors as `<repo>:yaac-cache-<tag>-<n>`, plus the
 * chain depth per name for the retire step.
 *
 * The ancestor walk stops at a named ancestor (pushed on its own), at one
 * from the node image store, at MAX_CHAIN_DEPTH, or at a pair already in
 * the ledger. Only a walk that reached the chain's root yields a retire
 * entry: when it stopped at a store-provided ancestor, the registry's
 * slots above that point are still in use, and retiring them would be
 * permanent since read-only images are never pushed again.
 *
 * Refs that never become destinations: ones already in this registry, ones
 * whose repo has a `host:port`, and ones still `localhost/`-prefixed after
 * canonicalization. A workspace can overwrite a repo the server also
 * pushes (last push wins), but it could push there directly anyway.
 */
function planSalvagePushes(report: SurveyReport, registryHost: string): SalvagePlan {
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
    // Store-provided images came from this registry.
    if (img.readOnly) continue
    const refs = img.refs.filter((ref) =>
      !ref.startsWith(`${registryHost}/`)
      && !ref.startsWith(LOCAL_REGISTRY_PREFIX)
      && !ref.slice(0, ref.lastIndexOf(':')).includes(':'))
    if (refs.length === 0) continue
    for (const ref of refs) add(img.id, `${registryHost}/${ref}`)

    // Slots use the lowest-sorting name, so a rebuild refills the same slots.
    const primary = refs[0]
    const colon = primary.lastIndexOf(':')
    const repo = primary.slice(0, colon)
    const tag = primary.slice(colon + 1)
    let cursor = byId.get(img.id)?.parent ?? null
    let depth = 0
    // True when the walk reached the chain's end (see the doc above).
    let ended = true
    for (; cursor && depth < MAX_CHAIN_DEPTH; ) {
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
function parseRetireReport(stdout: string): { retired: number; failed: number } {
  const m = /retired (\d+) failed (\d+)/.exec(stdout)
  return { retired: Number(m?.[1] ?? 0), failed: Number(m?.[2] ?? 0) }
}

/** Parse the push script's trailing `pushed <n> failed <n>` line. */
function parsePushReport(stdout: string): { pushed: number; failed: number } {
  const m = /pushed (\d+) failed (\d+)/.exec(stdout)
  return { pushed: Number(m?.[1] ?? 0), failed: Number(m?.[2] ?? 0) }
}

/** In-flight salvage per workspace, so reconcile and teardown share one. */
const salvageInflight = new Map<string, Promise<boolean>>()

/** Per workspace, the chain shape whose stale slots were last retired. */
const lastRetiredShape = new Map<string, string>()

/** Test hook: forget which chain shapes have been retired. */
export function _resetSalvageMemoForTests(): void {
  lastRetiredShape.clear()
}

/**
 * Salvage a workspace's images: survey in-pod, plan, push new images to the
 * project registry, retire stale chain slots. Best-effort, so teardown is
 * never blocked. Returns true when it ran cleanly (including no-ops).
 * Concurrent calls for one workspace share a run.
 */
export async function salvageJobImages(params: {
  jobName: string
  projectId: string
  workspaceId: string
}): Promise<boolean> {
  const { workspaceId } = params
  const existing = salvageInflight.get(workspaceId)
  if (existing) return existing
  const run = salvageJobImagesUncoalesced(params).finally(() => {
    salvageInflight.delete(workspaceId)
  })
  salvageInflight.set(workspaceId, run)
  return run
}

async function salvageJobImagesUncoalesced(params: {
  jobName: string
  projectId: string
  workspaceId: string
}): Promise<boolean> {
  const { jobName, projectId, workspaceId } = params
  const registryHost = projectRegistryHost(projectId)

  let report: SurveyReport
  try {
    const { stdout } = await containerExec(jobName, sudoExecCommand(buildSurveyScript()), {
      // A busy engine can delay the survey.
      timeout: 120_000,
    })
    report = parseSurveyReport(stdout)
  } catch (err) {
    console.warn(`Image salvage survey for ${jobName} failed: ${(err as Error).message}`)
    return false
  }
  const { pairs, retire } = planSalvagePushes(report, registryHost)
  // Retire whenever the chain shape changed since the last clean retire,
  // even with nothing to push, so a crash between the steps is recovered.
  const shape = retire.map((r) => `${r.repo}:${r.tag}=${r.depth}`).sort().join(',')
  const retireNeeded = retire.length > 0 && lastRetiredShape.get(workspaceId) !== shape
  if (pairs.length === 0 && !retireNeeded) return true

  let pushed = 0
  let failed = 0
  if (pairs.length > 0) {
    try {
      const argv = pairs.flatMap(({ id, dest }) => [id, dest])
      const { stdout } = await containerExec(
        jobName,
        sudoExecCommand(buildPushScript(), argv),
        { timeout: 600_000 },
      )
      ;({ pushed, failed } = parsePushReport(stdout))
    } catch (err) {
      console.warn(`Image salvage push for ${jobName} failed: ${(err as Error).message}`)
      return false
    }
  }

  let retired = 0
  if (retireNeeded) {
    const triples = retire.flatMap(({ repo, tag, depth }) => [repo, tag, String(depth)])
    const out = await containerExec(
      jobName,
      sudoExecCommand(buildRetireScript(registryHost), triples),
      { timeout: 120_000 },
    ).catch((err: unknown) => {
      console.warn(`Chain retire for ${jobName} failed: ${(err as Error).message}`)
      return null
    })
    if (out) {
      const report = parseRetireReport(out.stdout)
      retired = report.retired
      // Record only a clean run, so failed DELETEs are retried.
      if (report.failed === 0) lastRetiredShape.set(workspaceId, shape)
    }
  }

  serverLog(
    `[server] image salvage: session=${workspaceId} planned=${pairs.length} `
    + `pushed=${pushed} failed=${failed} retired=${retired} registry=${registryHost}`,
  )

  // New content in the registry: refresh the node image store now rather
  // than waiting for its throttle.
  if (pushed > 0) void ensureNodeImageStore(projectId, { force: true })
  return true
}
