import type { DrumVoiceId, Track } from './types'

const limit = (value: unknown, fallback: number, min: number, max: number) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}
export function eqSettings(track: Pick<Track, 'eq'>) {
  return { low: limit(track.eq?.low, 0, -18, 18), mid: limit(track.eq?.mid, 0, -18, 18), high: limit(track.eq?.high, 0, -18, 18) }
}
export function reverbSettings(track: Pick<Track, 'reverb'>) {
  return { mix: limit(track.reverb?.mix, 0, 0, .6), decay: limit(track.reverb?.decay, 1.6, .2, 4) }
}
export function drumLevel(track: Track, id: DrumVoiceId): number { return limit(track.drumVolumes?.[id], 1, 0, 2) }
export function levelText(level: number): string { return level <= 0 ? '−∞ dB' : `${(20 * Math.log10(level)).toFixed(1)} dB` }

// A deterministic stereo room: sparse early reflections, followed by a damped,
// diffuse tail. Fixed seeds keep playback and independently rendered chunks equal.
const impulses = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>()
function roomImpulse(context: BaseAudioContext, decay: number): AudioBuffer {
  let cache = impulses.get(context)
  if (!cache) { cache = new Map(); impulses.set(context, cache) }
  const key = Math.round(decay * 10) / 10, cached = cache.get(key)
  if (cached) return cached
  const rate = context.sampleRate, buffer = context.createBuffer(2, Math.ceil(key * rate), rate)
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    let seed = 7919 + channel * 104729, smooth = 0
    const alpha = 1 - Math.exp(-2 * Math.PI * 4200 / rate)
    for (let i = Math.round(.027 * rate); i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0
      smooth += alpha * (seed / 2147483648 - smooth)
      const t = i / rate
      data[i] = smooth * Math.exp(-6.91 * t / key) * Math.min(1, (t - .027) / .035) * .07
    }
    ;[.013, .023, .037, .053, .079].forEach((t, i) => {
      const at = Math.round((t + channel * .0017) * rate)
      if (at < data.length) data[at] += (i % 2 ? -.3 : .4) * Math.exp(-t * 9)
    })
  }
  cache.set(key, buffer)
  return buffer
}

export interface TrackBus {
  input: GainNode
  gain: GainNode
  panner: StereoPannerNode
  eq: BiquadFilterNode[]
  wet: GainNode
  convolver: ConvolverNode
  nodes: AudioNode[]
  decay: number
}
export function createTrackBus(context: BaseAudioContext, destination: AudioNode, track: Track): TrackBus {
  const input = context.createGain(), gain = context.createGain(), panner = context.createStereoPanner()
  const eq = ['lowshelf', 'peaking', 'highshelf'].map((type, index) => {
    const filter = context.createBiquadFilter(); filter.type = type as BiquadFilterType
    filter.frequency.value = [160, 1000, 6000][index]; filter.Q.value = .7
    return filter
  })
  const convolver = context.createConvolver(), wet = context.createGain()
  convolver.normalize = false
  input.connect(eq[0]); eq[0].connect(eq[1]); eq[1].connect(eq[2])
  // Fader follows the dry/wet sum so it controls the entire channel linearly.
  eq[2].connect(gain); eq[2].connect(convolver); convolver.connect(wet); wet.connect(gain)
  gain.connect(panner); panner.connect(destination)
  const bus = { input, gain, panner, eq, wet, convolver, nodes: [input, ...eq, convolver, wet, gain, panner], decay: 0 }
  updateTrackBus(context, bus, track)
  return bus
}
export function updateTrackBus(context: BaseAudioContext, bus: TrackBus, track: Track, silent = false): void {
  const at = context.currentTime
  const set = (param: AudioParam, value: number) => {
    param.cancelScheduledValues(at)
    if (at === 0) param.value = value
    else param.setTargetAtTime(value, at, .008)
  }
  set(bus.gain.gain, silent ? 0 : limit(track.volume, .8, 0, 1.25))
  set(bus.panner.pan, limit(track.pan, 0, -1, 1))
  const eq = eqSettings(track), reverb = reverbSettings(track)
  ;[eq.low, eq.mid, eq.high].forEach((value, index) => set(bus.eq[index].gain, value))
  if (reverb.mix > 0 && bus.decay !== reverb.decay) {
    bus.convolver.buffer = roomImpulse(context, reverb.decay); bus.decay = reverb.decay
  }
  set(bus.wet.gain, reverb.mix)
}
