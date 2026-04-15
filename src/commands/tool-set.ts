import { setDefaultTool, isValidTool } from '@/lib/project/preferences'

export async function toolSet(toolName: string): Promise<void> {
  if (!isValidTool(toolName)) {
    console.error(`Invalid tool "${toolName}". Must be one of: claude, codex`)
    process.exitCode = 1
    return
  }
  await setDefaultTool(toolName)
  console.log(`Default tool set to "${toolName}".`)
}
