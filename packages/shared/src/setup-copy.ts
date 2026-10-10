/**
 * Wording shared by the desktop shell's setup pages and the SPA: what each
 * kind of install means for the agents it runs, so the choice between them
 * and the containerless workspace badge say the same thing
 * (docs/containerless-driver.md).
 */
import type { TrustedTap } from '#types'

/** What an agent in a containerless workspace can reach, beyond its checkout. */
export const CONTAINERLESS_REACH = [
  'it can read and change any file that account can, not just its own checkout',
  'it holds real credentials and tokens: every project\'s on the server, not only its own',
  'its network access is unfiltered',
  'it can read and change every other workspace on the server, and drive the yaac server itself',
]

export const SETUP_COPY: Record<'server' | 'cluster', { title: string; summary: string; reach?: string[] }> = {
  server: {
    title: 'This Mac (containerless)',
    summary: 'Each workspace is its own checkout on this Mac, with no sandbox, and the permission mode defaults '
      + 'to accept-edits. Install the agent CLIs you want yourself (yaac host check names them). Quick to set up.',
    reach: CONTAINERLESS_REACH,
  },
  cluster: {
    title: 'Local Kubernetes cluster (kind)',
    summary: 'Each workspace is a gVisor-sandboxed pod behind an egress proxy that holds the real credentials. '
      + 'It needs a podman VM, several GB of disk and memory, and some minutes to install. Macs with Apple '
      + 'silicon only.',
  },
}

/** The sentence saying which taps a setup trusts, and what trusting one allows. */
export function trustSentence(taps: TrustedTap[]): string {
  const names = taps.map((t) => (t.thirdParty ? `${t.tap} (third-party, not yaac's)` : t.tap))
  return `Running it trusts the Homebrew tap${taps.length > 1 ? 's' : ''} ${names.join(' and ')}, `
    + 'which lets Homebrew run their formula code on this Mac.'
}
