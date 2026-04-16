import { setDefaultTool, isValidTool } from '@/lib/project/preferences'
import { loadToolAuthEntry } from '@/lib/project/tool-auth'

export async function toolSet(toolName: string): Promise<void> {
  if (!isValidTool(toolName)) {
    console.error(`Invalid tool "${toolName}". Must be one of: claude, codex`)
    process.exitCode = 1
    return
  }
  await setDefaultTool(toolName)
  console.log(`Default tool set to "${toolName}".`)

  const auth = await loadToolAuthEntry(toolName)
  if (!auth) {
    console.log(`No ${toolName} credentials configured. Run "yaac auth update" to authenticate.`)
  }
}
