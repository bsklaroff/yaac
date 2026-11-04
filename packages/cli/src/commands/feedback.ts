import fs from 'node:fs/promises'
import { env } from '@yaac/shared/env'
import { api } from '#commands/api'

export interface FeedbackOptions {
  image: string[]
}

/**
 * `yaac feedback`: send a message, and any screenshots, through the
 * selected server to its feedback endpoint, which it signs and forwards
 * as the webapp's form does (docs/feedback.md). The images go as they
 * are: the server checks their type and the 5 MB cap, and refuses the
 * whole report rather than drop one.
 */
export async function feedback(message: string, options: FeedbackOptions): Promise<void> {
  const images = await Promise.all(options.image.map(async (file) => ({
    mimeType: '',
    data: (await fs.readFile(file)).toString('base64'),
  })))
  const { host } = await api.feedback.$post({
    json: {
      message,
      images,
      client: {
        ...(env.version ? { version: env.version } : {}),
        ...(env.gitCommit ? { gitCommit: env.gitCommit } : {}),
        userAgent: `yaac-cli node/${process.version} ${process.platform}-${process.arch}`,
      },
    },
  })
  console.log(`Feedback sent to ${host}. Thank you!`)
}
