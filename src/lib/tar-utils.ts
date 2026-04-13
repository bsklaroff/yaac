import { pack } from 'tar-stream'

interface TarEntry {
  name: string
  content: string
}

export async function packTar(entries: TarEntry[]): Promise<Buffer> {
  const p = pack()
  const chunks: Buffer[] = []
  p.on('data', (chunk: Buffer) => chunks.push(chunk))

  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      p.entry({ name: entry.name }, entry.content, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  p.finalize()
  await new Promise<void>((resolve) => p.on('end', resolve))

  return Buffer.concat(chunks)
}
