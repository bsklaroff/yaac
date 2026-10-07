import fs from 'node:fs/promises'
import { deleteScopedClaudeKeychainItem, claudeKeychainService } from '@yaac/shared/tool-auth-interactive'
import { claudeDir, projectClaudeCredentialsFile, projectCodexAuthFile } from '@yaac/shared/project-paths'
import { deleteToolCredential } from '#db'
import { serverLog } from '#log'
import { ownedProjectIds } from './store'
import { AGENT_TOOLS, type AgentTool } from '@yaac/shared/types'

export type ClearAuthTarget = 'all' | AgentTool

/**
 * Remove a user's stored tool credentials for `target` (`all` or one tool),
 * and claude's and codex's copies in the tool homes of that user's projects,
 * so their running workspaces stop using a revoked credential. opencode and
 * pi keep no project copy. Git credentials are deleted separately
 * (`DELETE /auth/git/credentials/:id`).
 *
 * On macOS claude may have moved a project's live token into its scoped
 * Keychain item, so that is dropped too; the user's own claude install is
 * never touched.
 */
export async function clearAuth(owner: string, target: ClearAuthTarget): Promise<void> {
  const tools = target === 'all' ? AGENT_TOOLS : [target]
  for (const tool of tools) await deleteToolCredential(owner, tool)
  for (const projectId of await ownedProjectIds(owner)) {
    try {
      if (tools.includes('claude')) {
        await fs.rm(projectClaudeCredentialsFile(projectId), { force: true })
        deleteScopedClaudeKeychainItem(claudeKeychainService(claudeDir(projectId)))
      }
      if (tools.includes('codex')) await fs.rm(projectCodexAuthFile(projectId), { force: true })
    } catch (err) {
      serverLog(`[server] removing project "${projectId}"'s tool credentials failed: ${String(err)}`)
    }
  }
}
