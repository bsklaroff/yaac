import fs from 'node:fs/promises'
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
  /**
   * Legacy: the data-dir hash an install from before install ids named and
   * labelled its cluster objects with, read back from the cluster by `yaac
   * cluster install`. Set while anything is still named after it
   * (docs/legacy-compat-shims.md).
   */
  legacyDataDirHash?: string
  /**
   * Legacy: the install's names and node path still carry
   * `legacyDataDirHash`. Once dropped it is never set again, so a re-run
   * never goes back to the hash's names.
   */
  legacyNames?: boolean
}

const INSTALL_KEYS = [
  'driver', 'installId', 'clusterUid', 'kubeContext', 'byo', 'origin', 'legacyDataDirHash', 'legacyNames',
] as const

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
    // It ends up in a root `rm -rf` path, so anything but the hash's shape
    // is dropped.
    legacyDataDirHash: typeof raw.legacyDataDirHash === 'string' && /^[0-9a-f]{16}$/.test(raw.legacyDataDirHash)
      ? raw.legacyDataDirHash
      : undefined,
    legacyNames: raw.legacyNames === true ? true : undefined,
  }
  for (const key of INSTALL_KEYS) if (out[key] === undefined) delete out[key]
  return out
}

export function installRecordPath(dataDir = getDataDir()): string {
  return path.join(dataDir, 'install.json')
}

/** Null for an absent or malformed record. */
export async function readInstallRecord(dataDir = getDataDir()): Promise<InstallRecord | null> {
  if (dataDir === clientDataDir()) await retireServerJsonRecord()
  const raw = await readJsonFile(installRecordPath(dataDir))
  return raw === 'absent' || raw === null ? null : installFields(raw)
}

/**
 * Legacy: older installs kept the client data dir's record in the client
 * tier's `server.json`, beside the selection. Move it out: into
 * `install.json` when that is missing or torn (an existing one wins, being
 * what the record was copied from), and out of `server.json`, which is
 * deleted when all that is left is an empty selection
 * (docs/legacy-compat-shims.md). Runs from `readServerConfig` and from
 * `readInstallRecord` for the client data dir, so the first command of any
 * kind cleans the file.
 */
export async function retireServerJsonRecord(): Promise<void> {
  const file = clientLocalPath('server.json')
  const raw = await readJsonFile(file)
  if (raw === 'absent' || raw === null || !INSTALL_KEYS.some((key) => key in raw)) return
  const record = installFields(raw)
  const target = installRecordPath(clientDataDir())
  const existing = await readJsonFile(target)
  if (Object.keys(record).length > 0 && (existing === 'absent' || existing === null)) {
    await writeJsonFile(target, record, { exclusive: existing === 'absent' })
  }
  const selection = Object.fromEntries(Object.entries(raw).filter(([key]) => !(INSTALL_KEYS as readonly string[]).includes(key)))
  const empty = (selection.url ?? '') === '' && (!Array.isArray(selection.saved) || selection.saved.length === 0)
  if (empty) await fs.rm(file, { force: true })
  else await writeJsonFile(file, selection)
}

/**
 * Merge `patch` into this data dir's record; an `undefined` value drops the
 * field. `yaac cluster install` calls this before changing anything, so a
 * rerun after a failure recognizes what the failed run created.
 */
export async function recordInstall(patch: InstallRecord): Promise<void> {
  const record = installFields({ ...await readInstallRecord(), ...patch })
  await writeJsonFile(installRecordPath(), record)
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
 * beside the containerless `~/.yaac-server`, so the two can run side by side; a
 * `~/.yaac` that is already a cluster install keeps it
 * (docs/legacy-compat-shims.md).
 */
export async function clusterDataDir(): Promise<string> {
  const client = clientDataDir()
  if (client !== path.join(os.homedir(), '.yaac')) return client
  if ((await readInstallRecord(client))?.driver === 'k8s') return client
  return path.join(os.homedir(), '.yaac-cluster')
}
