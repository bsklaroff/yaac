/**
 * The attention chime — cuelume's 'chime' cue (a soft two-note ascending
 * bell, C6 → G6, with a gentle shimmer tail), synthesized live via Web
 * Audio; no audio files. cuelume is days old with a single release, so it
 * carries an exception to the release-age guard in pnpm-workspace.yaml —
 * adopted after reading its full source. We use only this one cue; its
 * declarative binding layer is unused.
 */
import { play } from 'cuelume'

/**
 * Play the attention chime. Safe to call from anywhere — cuelume lazily
 * creates its shared AudioContext, resumes it if the browser started it
 * suspended (pre-gesture), and is a no-op when Web Audio is unavailable
 * (jsdom, old browsers). Callers gate on the user's sound preference
 * before calling.
 */
export function playChime(): void {
  play('chime')
}
