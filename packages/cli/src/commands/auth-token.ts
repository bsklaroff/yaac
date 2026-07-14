import { api } from '#commands/api'

/**
 * Mint a durable token for a remote client. The server returns the full
 * token exactly once — print it to stdout (script-friendly) with the
 * handling warning on stderr.
 */
export async function authTokenCreate(name: string): Promise<void> {
  const entry = await api.tokens.$post({ json: { name } })
  console.error(`Token '${entry.name}' created — store it now, it is shown only once.`)
  console.log(entry.token)
}

export async function authTokenList(): Promise<void> {
  const { tokens } = await api.tokens.$get()
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
  await api.tokens[':name'].$delete({ param: { name } })
  console.log(`Revoked token '${name}'.`)
}
