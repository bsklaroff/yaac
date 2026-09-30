/**
 * The attention chime: cuelume's 'chime' cue (a soft two-note bell),
 * synthesized with Web Audio, so there are no audio files. cuelume has an
 * exception to the release-age guard in pnpm-workspace.yaml.
 */
import { play } from 'cuelume'

/**
 * Play the attention chime. Safe to call anywhere: cuelume creates and
 * resumes its AudioContext as needed and does nothing without Web Audio
 * (jsdom, old browsers). Callers check the user's sound preference first.
 */
export function playChime(): void {
  play('chime')
}
