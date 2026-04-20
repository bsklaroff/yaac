import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeBuildId, writeBuildId } from '@/lib/build-id'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')
const distDir = path.join(repoRoot, 'dist')

async function main(): Promise<void> {
  const id = await computeBuildId(distDir)
  await writeBuildId(distDir, id)
  console.log(`wrote ${path.join(distDir, '.build-id')} = ${id}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
