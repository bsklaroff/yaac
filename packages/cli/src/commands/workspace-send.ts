import { api } from '#commands/api'
import { promptSource, readPrompt } from '#commands/workspace-create'

/**
 * `yaac workspace send <workspace-id>`: message a running workspace's agent
 * as if you typed it: its first agent, or the one `--agent` or
 * `--conversation` names. A busy agent takes it once its turn allows.
 */
export async function workspaceSend(
  workspace: string,
  options: { prompt?: string; promptFile?: string; agent?: string; conversation?: string },
): Promise<void> {
  const source = promptSource(options)
  const message = source !== undefined ? await readPrompt(source) : options.prompt
  if (message === undefined || message.trim() === '') throw new Error('Give the message with --prompt or --prompt-file.')
  const sent = await api.workspace[':id'].send.$post({
    param: { id: workspace },
    json: {
      message,
      ...(options.agent !== undefined ? { session: options.agent } : {}),
      ...(options.conversation !== undefined ? { conversation: options.conversation } : {}),
    },
  })
  console.log(`Sent to ${sent.workspaceId.slice(0, 8)}'s ${sent.tool} agent ${sent.sessionId.slice(0, 8)}; a busy agent takes it once its current turn allows.`)
}
