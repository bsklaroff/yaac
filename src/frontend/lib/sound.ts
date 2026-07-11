/**
 * The attention chime, synthesized live via Web Audio — no audio files.
 *
 * Ported verbatim (the 'chime' recipe + its render engine) from cuelume, which
 * is MIT-licensed © Daniel Belyi (github.com/Danilaa1/cuelume). Inlined rather
 * than taken as a dependency; we use only this one cue. cuelume's other sounds
 * and its declarative binding are omitted.
 */

interface ToneLayer {
  frequency: number
  attack: number
  decay: number
  peak: number
  offset?: number
}
interface Shimmer {
  delay: number
  feedback: number
  wet: number
  lowpass: number
}
interface Recipe {
  masterGain: number
  layers: ToneLayer[]
  shimmer?: Shimmer
}

/** cuelume's 'chime': a soft two-note ascending bell (C6 → G6), with a gentle
 *  shimmer tail. Exact values from the source recipe. */
const CHIME: Recipe = {
  masterGain: 0.5,
  layers: [
    { frequency: 1046.5, attack: 0.006, decay: 0.22, peak: 0.09 },
    { frequency: 1568, offset: 0.09, attack: 0.006, decay: 0.26, peak: 0.08 },
  ],
  shimmer: { delay: 0.12, feedback: 0.25, wet: 0.18, lowpass: 4000 },
}

const SOURCE_STOP_PADDING = 0.05
const CLEANUP_MARGIN = 0.05
const INAUDIBLE_GAIN = 0.001

function renderTone(ctx: AudioContext, dest: AudioNode, layer: ToneLayer, start: number): void {
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(layer.frequency, start)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(layer.peak, start + layer.attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + layer.attack + layer.decay)
  osc.connect(gain).connect(dest)
  osc.start(start)
  osc.stop(start + layer.attack + layer.decay + SOURCE_STOP_PADDING)
}

/** A soft echo/shimmer send off `source` feeding back into `dest`. */
function attachShimmer(ctx: AudioContext, source: AudioNode, dest: AudioNode, s: Shimmer): AudioNode[] {
  const delay = ctx.createDelay(1)
  delay.delayTime.value = s.delay
  const feedbackFilter = ctx.createBiquadFilter()
  feedbackFilter.type = 'lowpass'
  feedbackFilter.frequency.value = s.lowpass
  const feedbackGain = ctx.createGain()
  feedbackGain.gain.value = s.feedback
  const wet = ctx.createGain()
  wet.gain.value = s.wet
  source.connect(delay)
  delay.connect(feedbackFilter)
  feedbackFilter.connect(feedbackGain)
  feedbackGain.connect(delay)
  feedbackFilter.connect(wet)
  wet.connect(dest)
  return [delay, feedbackFilter, feedbackGain, wet]
}

function sourceEnd(r: Recipe): number {
  return Math.max(...r.layers.map((l) => (l.offset ?? 0) + l.attack + l.decay + SOURCE_STOP_PADDING))
}
function shimmerTail(s?: Shimmer): number {
  if (!s || s.feedback <= 0) return 0
  if (s.feedback >= 1) return s.delay
  return s.delay * (1 + Math.ceil(Math.log(INAUDIBLE_GAIN) / Math.log(s.feedback)))
}

function renderRecipe(ctx: AudioContext, r: Recipe): void {
  const now = ctx.currentTime
  const master = ctx.createGain()
  master.gain.value = r.masterGain
  master.connect(ctx.destination)
  const shimmerNodes = r.shimmer ? attachShimmer(ctx, master, ctx.destination, r.shimmer) : []
  for (const layer of r.layers) renderTone(ctx, master, layer, now + (layer.offset ?? 0))
  const cleanupMs = (sourceEnd(r) + shimmerTail(r.shimmer) + CLEANUP_MARGIN) * 1000
  setTimeout(() => {
    master.disconnect()
    for (const node of shimmerNodes) node.disconnect()
  }, cleanupMs)
}

let sharedContext: AudioContext | null = null
function audioContext(): AudioContext | null {
  if (sharedContext) return sharedContext
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    sharedContext = new Ctor()
  } catch {
    return null
  }
  return sharedContext
}

/**
 * Play the attention chime. Lazily creates the shared AudioContext, resumes it
 * if the browser started it suspended (pre-gesture), and is a no-op when Web
 * Audio is unavailable (jsdom, old browsers). Callers gate on the user's
 * sound preference before calling.
 */
export function playChime(): void {
  const ctx = audioContext()
  if (!ctx) return
  if (ctx.state === 'running') {
    renderRecipe(ctx, CHIME)
    return
  }
  try {
    void ctx.resume().then(() => {
      if (ctx.state === 'running') renderRecipe(ctx, CHIME)
    }, () => { /* audio blocked */ })
  } catch {
    // Some browsers throw synchronously when audio is blocked.
  }
}
