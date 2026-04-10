import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileHash, contextHash, ensureImageByTag } from '@/lib/image-builder'
import { DOCKERFILES_DIR, PROXY_DIR, SSH_AGENT_DIR } from '@/lib/paths'

const execFileAsync = promisify(execFile)

/**
 * Pre-build all container images used by e2e tests.
 *
 * Each image is tagged with a content hash of its source files
 * (e.g. yaac-test-base:<hash>). This means the tag itself encodes
 * whether the image is up to date — no label inspection needed.
 * Test code computes the same hash to derive the expected tag.
 */
export async function setup(): Promise<void> {
  // Skip when podman is unavailable — tests that need it will fail on their own
  try {
    await execFileAsync('podman', ['info', '--format', 'json'])
  } catch {
    return
  }

  // --- Base image (Dockerfile.default) ---
  const baseDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
  const baseHash = await fileHash(baseDockerfile)
  const baseTag = `yaac-test-base:${baseHash}`
  await ensureImageByTag(baseTag, baseDockerfile, DOCKERFILES_DIR)

  // --- Nestable layer (Dockerfile.nestable, layered on base) ---
  const nestDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.nestable')
  const nestContentHash = await fileHash(nestDockerfile)
  const nestHash = crypto.createHash('sha256').update(`${baseHash}:${nestContentHash}`).digest('hex').slice(0, 16)
  const nestTag = `yaac-test-base-nestable:${nestHash}`
  await ensureImageByTag(nestTag, nestDockerfile, DOCKERFILES_DIR, { BASE_IMAGE: baseTag })

  // --- Proxy sidecar (podman/proxy-sidecar/) ---
  const proxyHash = await contextHash(PROXY_DIR)
  const proxyTag = `yaac-test-proxy:${proxyHash}`
  await ensureImageByTag(proxyTag, path.join(PROXY_DIR, 'Dockerfile'), PROXY_DIR)

  // --- SSH agent sidecar (podman/ssh-agent-sidecar/) ---
  const sshHash = await contextHash(SSH_AGENT_DIR)
  const sshTag = `yaac-test-ssh-agent:${sshHash}`
  await ensureImageByTag(sshTag, path.join(SSH_AGENT_DIR, 'Dockerfile'), SSH_AGENT_DIR)
}
