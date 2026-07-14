import { api } from '#commands/api'

export async function toolGet(): Promise<void> {
  const result = await api.tool.get.$get()
  if (result.tool) {
    console.log(result.tool)
  } else {
    console.log('No default tool configured. Run "yaac tool set <tool>" to set one.')
  }
}
