import { getDefaultTool } from '@/lib/project/preferences'

export async function toolGet(): Promise<void> {
  const tool = await getDefaultTool()
  if (tool) {
    console.log(tool)
  } else {
    console.log('No default tool configured. Run "yaac tool set <tool>" to set one.')
  }
}
