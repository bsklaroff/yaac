import { getRpcClient } from '#commands/rpc'

/**
 * Mint a durable token for a remote client. The server returns the full
 * token exactly once — print it to stdout (script-friendly) with the
 * handling warning on stderr.
 */
export async function authTokenCreate(name: string): Promise<void> {
  const client = await getRpcClient()
  const entry = await client.tokens.$post({ json: { name } }).then((r) => r.json())
  console.error(`Token '${entry.name}' created — store it now, it is shown only once.`)
  console.log(entry.token)
}

export async function authTokenList(): Promise<void> {
  const client = await getRpcClient()
  const { tokens } = await client.tokens.$get().then((r) => r.json())
  if (tokens.length === 0) {
    console.log('No tokens. Create one with: yaac auth token create <name>')
    return
  }
  for (const t of tokens) {
    console.log(
      `${t.name.padEnd(20)} ${t.kind.padEnd(9)} ${t.masked.padEnd(12)} created ${t.createdAt.slice(0, 10)}`,
    )
  }
}

export async function authTokenRevoke(name: string): Promise<void> {
  const client = await getRpcClient()
  await client.tokens[':name'].$delete({ param: { name } })
  console.log(`Revoked token '${name}'.`)
}
