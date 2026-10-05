/**
 * The attention chime: cuelume's 'chime' cue (a soft two-note bell),
 * synthesized with Web Audio, so there are no audio files.
 */
import { play } from 'cuelume'

/**
 * Play the attention chime. Safe to call anywhere: cuelume creates and
 * resumes its AudioContext as needed and does nothing without Web Audio
 * (jsdom, old browsers). Callers check the user's sound preference first.
 *
 * cuelume runs every sound through a 4x output gain, so a quarter volume
 * plays the chime at the bell's own level, which is loud enough to notice
 * without startling.
 */
export function playChime(): void {
  play('chime', { volume: 0.25 })
}
