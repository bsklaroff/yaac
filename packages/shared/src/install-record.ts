import os from 'node:os'
import path from 'node:path'
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the record sits at the data dir's root, outside every tier
import { clientDataDir, clientLocalPath, getDataDir } from '#paths'
import { readJsonFile, writeJsonFile } from '#json-file'
import type { DriverKind } from '#types'

/**
 * What a data dir records about the install it is (`<dataDir>/install.json`,
 * 0600), whatever server this machine's clients have selected. `yaac server
 * start` records `driver`; `yaac cluster install` records the rest. It sits
 * at the data dir's root, which no pod mounts (a pod gets the tier folders),
 * and only clients read it.
 */
export interface InstallRecord {
  /** Which substrate this data dir's install runs. */
  driver?: DriverKind
  /**
   * Random id minted by the first `yaac cluster install` and stamped on its
   * Deployment and volumes. Data-dir paths repeat across machines, so volume
   * re-adoption, foreign-Deployment refusal and byo uninstall key on this.
   */
  installId?: string
  /**
   * The uid of the install's cluster's `kube-system` namespace. Unlike a
   * context name, it cannot be reused by another cluster, so host-side
   * cluster commands refuse when the current context points elsewhere.
   */
  clusterUid?: string
  /** The kube context the install used; shown in refusal messages. */
  kubeContext?: string
  /**
   * The install is `--byo`: yaac did not create the cluster, so
   * `yaac cluster delete` refuses and nothing here execs into its nodes.
   */
  byo?: boolean
  /**
   * The origin this install's server last registered at (`yaac server
   * start`, `yaac cluster install|start`). The desktop app lets pages from
   * it, while the server runs, drive this Mac's installs; a page from any
   * other origin, loopback or not, may not.
   */
  origin?: string
}

const INSTALL_KEYS = ['driver', 'installId', 'clusterUid', 'kubeContext', 'byo', 'origin'] as const

/** The record's known fields, dropping unset and malformed ones. */
function installFields(raw: Record<string, unknown>): InstallRecord {
  const str = (v: unknown): string | undefined => typeof v === 'string' && v !== '' ? v : undefined
  const out: InstallRecord = {
    driver: raw.driver === 'k8s' || raw.driver === 'containerless' ? raw.driver : undefined,
    installId: str(raw.installId),
    clusterUid: str(raw.clusterUid),
    kubeContext: str(raw.kubeContext),
    byo: raw.byo === true ? true : undefined,
    origin: str(raw.origin),
  }
  for (const key of INSTALL_KEYS) if (out[key] === undefined) delete out[key]
  return out
}

export function installRecordPath(dataDir = getDataDir()): string {
  return path.join(dataDir, 'install.json')
}

/**
 * Null for an absent or malformed record. A malformed one (a crash
 * mid-write) is re-lifted when `server.json` still holds the record.
 */
export async function readInstallRecord(dataDir = getDataDir()): Promise<InstallRecord | null> {
  const raw = await readJsonFile(installRecordPath(dataDir))
  if (raw !== 'absent' && raw !== null) return installFields(raw)
  return liftLegacyRecord(dataDir, raw === 'absent')
}

/**
 * Legacy: an install from before `install.json` kept its record in the
 * client tier's `server.json`, beside the selection. Copy it here the first
 * time it is asked for, without overwriting a record another process wrote
 * meanwhile (docs/legacy-compat-shims.md).
 */
async function liftLegacyRecord(dataDir: string, absent: boolean): Promise<InstallRecord | null> {
  if (dataDir !== clientDataDir()) return null
  const raw = await readJsonFile(clientLocalPath('server.json'))
  if (raw === 'absent' || raw === null) return null
  const record = installFields(raw)
  if (Object.keys(record).length === 0) return null
  if (!await writeJsonFile(installRecordPath(dataDir), record, { exclusive: absent })) {
    return readInstallRecord(dataDir)
  }
  return record
}

/**
 * Legacy: an older `yaac` reads the record only from `server.json`, so the
 * client data dir's record is kept there too, or an older CLI on PATH would
 * take a cluster's `~/.yaac` for a containerless one
 * (docs/legacy-compat-shims.md). `writeServerConfig` adds it to every
 * rewrite; this covers a record changing.
 */
async function mirrorIntoServerJson(record: InstallRecord): Promise<void> {
  const file = clientLocalPath('server.json')
  const raw = await readJsonFile(file)
  const selection = raw === 'absent' || raw === null
    ? { url: '', enabled: false, saved: [] }
    : { url: raw.url ?? '', enabled: raw.enabled ?? false, saved: raw.saved ?? [] }
  await writeJsonFile(file, { ...selection, ...record })
}

/**
 * Merge `patch` into this data dir's record; an `undefined` value drops the
 * field. `yaac cluster install` calls this before changing anything, so a
 * rerun after a failure recognizes what the failed run created.
 */
export async function recordInstall(patch: InstallRecord): Promise<void> {
  const record = installFields({ ...await readInstallRecord(), ...patch })
  await writeJsonFile(installRecordPath(), record)
  if (getDataDir() === clientDataDir()) await mirrorIntoServerJson(record)
}

/**
 * The substrate this data dir's install runs. Clients use it to decide
 * which command brings up an unreachable server: `yaac server start`
 * (containerless) or `yaac cluster start` (k8s).
 */
export async function recordedDriver(): Promise<DriverKind | undefined> {
  return (await readInstallRecord())?.driver
}

/**
 * The data dir `yaac cluster …` acts on. An overridden data dir is one
 * install, so it is that dir. Otherwise a cluster gets `~/.yaac-cluster`,
 * beside the containerless `~/.yaac`, so the two can run side by side; a
 * `~/.yaac` that is already a cluster install keeps it
 * (docs/legacy-compat-shims.md).
 */
export async function clusterDataDir(): Promise<string> {
  const client = clientDataDir()
  if (client !== path.join(os.homedir(), '.yaac')) return client
  if ((await readInstallRecord(client))?.driver === 'k8s') return client
  return path.join(os.homedir(), '.yaac-cluster')
}
