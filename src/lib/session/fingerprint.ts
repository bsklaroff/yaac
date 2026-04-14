import crypto from 'node:crypto'
import { resolveImageTag } from '@/lib/container/image-builder'
import { resolveProxyImageTag } from '@/lib/container/proxy-client'
import { resolveProjectConfig, hashConfig } from '@/lib/project/config'
import { getRemoteHeadCommit } from '@/lib/git'
import { repoDir } from '@/lib/project/paths'
import type { YaacConfig } from '@/types'

export interface FingerprintInputs {
  imageTag: string
  proxyImageTag: string
  configHash: string
  remoteHead: string
}

export function computeFingerprint(inputs: FingerprintInputs): string {
  const payload = `${inputs.imageTag}\n${inputs.proxyImageTag}\n${inputs.configHash}\n${inputs.remoteHead}`
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

export async function resolveSessionFingerprint(
  projectSlug: string,
): Promise<{ fingerprint: string; inputs: FingerprintInputs }> {
  const config: YaacConfig = await resolveProjectConfig(projectSlug) ?? {}

  const [imageTag, proxyImageTag, remoteHead] = await Promise.all([
    resolveImageTag(projectSlug, undefined, config.nestedContainers ?? false),
    resolveProxyImageTag(),
    getRemoteHeadCommit(repoDir(projectSlug)),
  ])

  const inputs: FingerprintInputs = {
    imageTag,
    proxyImageTag,
    configHash: hashConfig(config),
    remoteHead,
  }

  return { fingerprint: computeFingerprint(inputs), inputs }
}
