import { spawn } from 'node:child_process'
import readline from 'node:readline/promises'
import { getApiClient } from '@yaac/shared/server-api'
import { seedGitIdentityFromShell } from '@yaac/shared/git-identity-seed'
import { env } from '@yaac/shared/env'
import { ServerError } from '@yaac/shared/errors'
import { listenForRedirect, type RedirectListener } from '@yaac/auth-daemon/oauth-callback'
import {
  buildAuthPayload,
  type ToolLoginResult,
} from '@yaac/shared/tool-auth-interactive'
import {
  CUSTOM_PROVIDER,
  OMP_DEFAULT_PROVIDER,
  OMP_PROVIDERS,
  OPENCODE_DEFAULT_PROVIDER,
  OPENCODE_PROVIDERS,
  PI_DEFAULT_PROVIDER,
  PI_PROVIDERS,
  ompProviderInfo,
  opencodeProviderInfo,
  piProviderInfo,
  type ApiKeyTool,
  type OmpProvider,
  type OpencodeProvider,
  type PiProvider,
  type ToolProviderInfo,
} from '@yaac/shared/tool-providers'
import { describeEndpointModel } from '@yaac/shared/endpoint-models'
import { TOOL_LABELS, type AgentTool, type LoginTool, type ToolLoginView } from '@yaac/shared/types'

/**
 * One reader for every prompt of an `auth update`, so answers piped in all
 * at once each reach their own prompt: a reader per prompt would swallow the
 * rest of the pipe. A stdin that ends before an answer fails the command.
 */
let reader: { rl: readline.Interface; lines: AsyncIterator<string> } | null = null

/** What Ctrl-C does before exiting: cancels the sign-in in progress, so the
 *  server stops on it rather than waiting out its timeout. */
let onInterrupt: () => Promise<unknown> = () => Promise.resolve()

function interrupt(): void {
  void onInterrupt().catch(() => {}).finally(() => process.exit(130))
}

async function ask(query: string): Promise<string> {
  if (!reader) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.on('SIGINT', interrupt)
    reader = { rl, lines: rl[Symbol.asyncIterator]() }
  }
  reader.rl.setPrompt(query)
  reader.rl.prompt()
  const next = await reader.lines.next()
  if (next.done) throw new Error(`stdin closed with no answer to "${query.trim()}"`)
  return next.value.trim()
}

export async function authUpdate(): Promise<void> {
  try {
    await runUpdate()
  } finally {
    reader?.rl.close()
    reader = null
  }
}

async function runUpdate(): Promise<void> {
  console.log('What would you like to authenticate?')
  console.log('  1) Git credential (HTTPS token or SSH key)')
  console.log('  2) Claude Code (Anthropic)')
  console.log('  3) Codex (OpenAI)')
  console.log('  4) OpenCode (any supported provider)')
  console.log('  5) Pi (any supported provider)')
  console.log('  6) Oh My Pi (any supported provider)')
  const answer = await ask('Choice [1-6]: ')

  if (answer === '1') {
    await runGitUpdate()
    return
  }
  const choices: Partial<Record<string, AgentTool>> = { 2: 'claude', 3: 'codex', 4: 'opencode', 5: 'pi', 6: 'omp' }
  const tool = choices[answer]
  if (tool === undefined) {
    console.log('Cancelled.')
    return
  }
  await runToolUpdate(tool)
}

/**
 * Add a named git credential: a pasted HTTPS token, or an SSH key the server
 * generates (docs/git-credentials.md). The name is what `yaac project add`
 * takes; Enter accepts a default no other credential has.
 */
async function runGitUpdate(): Promise<void> {
  console.log('Credential type:')
  console.log('  a) HTTPS (personal access token)')
  console.log('  b) SSH (a key yaac generates)')
  const kindAnswer = (await ask('Choice [a/b]: ')).toLowerCase()
  const kind = kindAnswer === 'a' || kindAnswer === 'https' ? 'https'
    : kindAnswer === 'b' || kindAnswer === 'ssh' ? 'ssh'
    : null
  if (kind === null) {
    console.log('Cancelled.')
    return
  }

  const client = getApiClient()
  const taken = (await client.auth.list.$get()).gitCredentials.map((c) => c.name)
  const base = kind === 'https' ? 'git-token' : 'git-key'
  let fallback = base
  for (let n = 2; taken.includes(fallback); n++) fallback = `${base}-${n}`
  const name = await ask(`Name [${fallback}]: `) || fallback

  if (kind === 'https') {
    const token = await ask('Token (PAT): ')
    if (!token) throw new Error('Token cannot be empty.')
    await client.auth.git.credentials.$post({ json: { name, token } })
    console.log(`Git credential "${name}" saved.`)
  } else {
    const { publicKey } = await client.auth.git['ssh-keys'].$post({ json: { name } })
    console.log(`SSH key "${name}" generated. The server keeps the private key encrypted and never`)
    console.log('shows it. Register this public key with your git host, as a deploy key or on your account:')
    console.log(publicKey)
  }
  console.log(`Add a project with it: yaac project add <remote-url> '${name}'`)
}

/**
 * Sign a tool in: claude and codex through the vendor's browser sign-in (or a
 * pasted key, if asked for), the api-key tools with a pasted key.
 */
async function runToolUpdate(tool: AgentTool): Promise<void> {
  const label = TOOL_LABELS[tool]

  if (tool === 'claude' || tool === 'codex') {
    const how = (await ask('Sign in with your browser, or paste an API key? [B/k]: ')).toLowerCase()
    if (how !== 'k') {
      if (!await runBrowserLogin(tool)) process.exit(1)
      console.log(`${label} credentials saved.`)
      return
    }
  }
  const result = await promptForApiKey(tool)

  const payload = buildAuthPayload(tool, result)
  const client = getApiClient()
  await client.auth[':tool'].$put({ param: { tool }, json: payload })
  console.log(`${label} credentials saved.`)
}

const POLL_MS = 1000

/** Open a URL in this machine's browser, best effort: the URL is printed
 *  beside it. */
function openBrowser(url: string): void {
  const opener = env.browser ?? (process.platform === 'darwin' ? 'open' : 'xdg-open')
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true })
  child.on('error', () => { /* no opener; the user follows the printed URL */ })
  child.unref()
}

/**
 * Run the server's OAuth sign-in for claude or codex (docs/tool-sign-in.md),
 * saving the tokens on the (possibly remote) server. When a browser opened
 * here runs on this machine, the vendor redirects to a loopback listener in
 * this process, which hands the code to the server. Otherwise (an SSH
 * login) the user pastes Claude's code or enters Codex's device code. A
 * machine with no git identity on the server gets one from the local git
 * config first.
 */
async function runBrowserLogin(tool: LoginTool): Promise<boolean> {
  const client = getApiClient()
  try {
    await seedGitIdentityFromShell()
  } catch (err) {
    console.error(`Could not set the git identity: ${err instanceof Error ? err.message : String(err)}`)
  }
  const start = (callback?: 'caller'): Promise<ToolLoginView> =>
    client.auth[':tool'].login.start.$post({ param: { tool }, json: callback ? { callback } : {} })
  const submit = (id: string, text: string): Promise<ToolLoginView> =>
    client.auth.login[':id'].input.$post({ param: { id }, json: { text } })

  const local = env.canOpenLocalBrowser
  let view = await start(local ? 'caller' : undefined)
  // Ctrl-C reaches the reader while a prompt is open, else the process.
  onInterrupt = () => client.auth.login[':id'].cancel.$post({ param: { id: view.id } })
  process.on('SIGINT', interrupt)
  let listener: RedirectListener | null = null
  if (local && view.status === 'running' && view.url) {
    try {
      listener = await listenForRedirect(view.url)
    } catch (err) {
      console.log(`${err instanceof Error ? err.message : String(err)} Finishing with a code instead.`)
      await client.auth.login[':id'].cancel.$post({ param: { id: view.id } })
      view = await start()
    }
  }
  if (view.status === 'error' || !view.url) {
    console.error(view.error ?? 'Sign-in failed.')
    return false
  }

  if (listener) {
    console.log('Finish signing in in the browser window that opens. If none does, open:')
    console.log(`  ${view.url}`)
    openBrowser(view.url)
    try {
      const { code, state } = await listener.result
      view = await submit(view.id, `${code}#${state}`)
    } catch (err) {
      await client.auth.login[':id'].cancel.$post({ param: { id: view.id } })
      console.error(err instanceof Error ? err.message : String(err))
      return false
    }
  } else if (view.userCode) {
    console.log(`Open ${view.url} in a browser, sign in, and enter this code: ${view.userCode}`)
    while (view.status === 'running') {
      await new Promise((r) => setTimeout(r, POLL_MS))
      view = await client.auth.login[':id'].$get({ param: { id: view.id } })
    }
  } else {
    console.log('Open this page in a browser and sign in:')
    console.log(`  ${view.url}`)
    while (view.status === 'running') {
      const text = await ask('Paste the code the page shows: ')
      if (!text) continue
      try {
        view = await submit(view.id, text)
      } catch (err) {
        // A mistyped code is refused before it is spent; ask again.
        if (!(err instanceof ServerError && err.code === 'VALIDATION')) throw err
        console.error(err.message)
      }
    }
  }

  if (view.status === 'success') return true
  console.error(view.error ?? 'Sign-in failed.')
  return false
}

/**
 * Ask which provider an api-key tool's key is for. There are too many for
 * a numbered menu, so the user types an id; "?" lists them and Enter takes
 * the default. Re-prompts on an unknown id.
 */
async function promptForProvider<T extends string>(
  tool: ApiKeyTool,
  list: readonly ToolProviderInfo[],
  defaultId: T,
): Promise<T> {
  console.log(`Which ${tool} provider? Type its id, "?" to list all ${list.length}, or Enter for "${defaultId}".`)
  for (;;) {
    const answer = await ask(`Provider [${defaultId}]: `)
    if (!answer) return defaultId
    if (answer === '?') {
      for (const p of list) console.log(`  ${p.id}  —  ${p.label}`)
      continue
    }
    const match = list.find((p) => p.id === answer)
    if (match) return match.id as T
    console.log(`Unknown provider "${answer}". Type "?" to see the full list.`)
  }
}

/**
 * Prompt the user to paste an API key, asking for the provider first on an
 * api-key tool. The custom provider takes one of the user's custom
 * endpoints instead, which holds its own key.
 */
async function promptForApiKey(tool: AgentTool): Promise<ToolLoginResult> {
  let opencodeProvider: OpencodeProvider | undefined
  let piProvider: PiProvider | undefined
  let ompProvider: OmpProvider | undefined
  if (tool === 'opencode') {
    opencodeProvider = await promptForProvider('opencode', OPENCODE_PROVIDERS, OPENCODE_DEFAULT_PROVIDER)
  }
  if (tool === 'pi') {
    piProvider = await promptForProvider('pi', PI_PROVIDERS, PI_DEFAULT_PROVIDER)
  }
  if (tool === 'omp') {
    ompProvider = await promptForProvider('omp', OMP_PROVIDERS, OMP_DEFAULT_PROVIDER)
  }
  if ((opencodeProvider ?? piProvider ?? ompProvider) === CUSTOM_PROVIDER) {
    const endpointId = await promptForEndpoint()
    return { apiKey: '', opencodeProvider, piProvider, ompProvider, endpointId }
  }
  const label =
    tool === 'claude' ? 'Anthropic API key or OAuth token' :
    tool === 'codex' ? 'OpenAI API key' :
    tool === 'opencode' && opencodeProvider ? `${opencodeProviderInfo(opencodeProvider).label} API key` :
    tool === 'pi' && piProvider ? `${piProviderInfo(piProvider).label} API key` :
    tool === 'omp' && ompProvider ? `${ompProviderInfo(ompProvider).label} API key` :
    'API key'
  const key = await ask(`Paste your ${label}: `)
  if (!key) {
    console.error('Key cannot be empty.')
    process.exit(1)
  }
  return { apiKey: key, opencodeProvider, piProvider, ompProvider }
}

/**
 * Pick one of the caller's custom endpoints by name, or add one under a new
 * name: its URL and key, then the models its /models lists.
 */
async function promptForEndpoint(): Promise<string> {
  const client = getApiClient()
  const { customEndpoints } = await client.auth.list.$get()
  const names = customEndpoints.map((e) => e.name)
  console.log(names.length > 0
    ? `Your custom endpoints: ${names.join(', ')}. Type one, or a new name to add one.`
    : 'You have no custom endpoints yet. Name one to add it.')
  const name = await ask('Custom endpoint: ')
  if (!name) throw new Error('No custom endpoint named.')
  const existing = customEndpoints.find((e) => e.name === name)
  if (existing) return existing.id
  const baseUrl = await ask('Endpoint URL (e.g. http://my-box:8080/v1): ')
  const apiKey = await ask('API key (Enter for none): ')
  const found = await client.auth.endpoints.discover.$post({ json: { baseUrl, ...(apiKey ? { apiKey } : {}) } })
  if (found.models.length === 0) {
    throw new Error(`${baseUrl} listed no usable models. Add it with \`yaac auth endpoint add --models-file\`.`)
  }
  console.log('It serves:')
  for (const m of found.models) console.log(`  ${describeEndpointModel(m)}`)
  const { id } = await client.auth.endpoints.$post({
    json: { name, baseUrl, ...(apiKey ? { apiKey } : {}), models: found.models },
  })
  console.log(`Custom endpoint "${name}" saved; edit its models with \`yaac auth endpoint edit ${name}\`.`)
  return id
}
