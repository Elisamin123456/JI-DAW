import type { DrumVoiceId } from './types'

export type DrumKitId = 'chip-drum-16' | 'fc-noise-8'
export const DRUM_KITS: readonly { id: DrumKitId; name: string; description: string }[] = [
  { id: 'chip-drum-16', name: '16-bit 芯片鼓组', description: '较饱满、平滑的经典 16-bit 主机鼓声' },
  { id: 'fc-noise-8', name: 'FC 8-bit 808 鼓组', description: '深沉的 808 式低频鼓体、饱满军鼓与柔化高频的 8-bit 质感' }
] as const

export function drumKit(id: unknown) { return DRUM_KITS.find(kit => kit.id === id) ?? DRUM_KITS[0] }

export interface DrumVoice {
  id: DrumVoiceId
  name: string
  shortName: string
  color: string
  midi: number
  duration: number
}

export const DRUM_VOICES: readonly DrumVoice[] = [
  { id: 'crash', name: 'Crash 碎音镲', shortName: 'CRASH', color: '#f1cb62', midi: 49, duration: 1.25 },
  { id: 'hat-open', name: '开放踩镲', shortName: 'OPEN HH', color: '#dfd675', midi: 46, duration: .58 },
  { id: 'hat-closed', name: '闭合踩镲', shortName: 'CLOSED HH', color: '#c8d67a', midi: 42, duration: .105 },
  { id: 'tom-high', name: '高嗵鼓', shortName: 'HIGH TOM', color: '#7ed4bd', midi: 50, duration: .34 },
  { id: 'tom-mid', name: '中嗵鼓', shortName: 'MID TOM', color: '#72bed8', midi: 47, duration: .39 },
  { id: 'tom-low', name: '低嗵鼓', shortName: 'LOW TOM', color: '#738fd8', midi: 43, duration: .46 },
  { id: 'clap', name: '拍手', shortName: 'CLAP', color: '#d58bd5', midi: 39, duration: .38 },
  { id: 'rim', name: '边击', shortName: 'RIM', color: '#e58b9e', midi: 37, duration: .14 },
  { id: 'snare', name: '军鼓', shortName: 'SNARE', color: '#ed8c72', midi: 38, duration: .36 },
  { id: 'kick', name: '底鼓', shortName: 'KICK', color: '#eead62', midi: 36, duration: .7 }
] as const

export function drumVoice(id: unknown): DrumVoice {
  return DRUM_VOICES.find(voice => voice.id === id) ?? DRUM_VOICES.find(voice => voice.id === 'kick')!
}

export function drumVoiceFromMidi(midi: number): DrumVoice {
  return DRUM_VOICES.reduce((best, voice) => Math.abs(voice.midi - midi) < Math.abs(best.midi - midi) ? voice : best)
}

const sampleCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>()

function quantize16(value: number): number {
  return Math.round(Math.max(-1, Math.min(1, value)) * 32767) / 32767
}

function quantize8(value: number): number {
  return Math.round(Math.max(-1, Math.min(1, value)) * 127) / 127
}

function makeNoise(seed = 0x5eED): () => number {
  let state = seed & 0x7fff || 1
  return () => {
    const bit = ((state >> 0) ^ (state >> 1)) & 1
    state = (state >> 1) | (bit << 14)
    return (state / 0x3fff) - 1
  }
}

// Preserve each kit's original snare waveform; loudness is adjusted after synthesis.
function fillSnare(data: Float32Array, rate: number, kitId: DrumKitId): void {
  const chip = kitId === 'fc-noise-8', duration = drumVoice('snare').duration
  const synthesisRate = chip ? Math.min(11025, rate) : rate
  const generated = chip ? new Float32Array(Math.ceil(duration * synthesisRate)) : data
  const noise = makeNoise(0x2345 + drumVoice('snare').midi * 97)
  const alpha = (cutoff: number) => 1 - Math.exp(-2 * Math.PI * cutoff / synthesisRate)
  const a420 = alpha(420), a1500 = alpha(1500), a3500 = alpha(3500)
  const stepped = (value: number) => Math.ceil(Math.max(0, Math.min(1, value)) * 31) / 31
  let phase = 0, secondary = 0, previous = 0, high = 0, n420 = 0, n1500 = 0, n3500 = 0
  for (let index = 0; index < generated.length; index++) {
    const t = index / synthesisRate, raw = noise()
    let sample: number
    if (chip) {
      const bitNoise = raw >= 0 ? 1 : -1
      n420 += a420 * (bitNoise - n420); n1500 += a1500 * (bitNoise - n1500); n3500 += a3500 * (bitNoise - n3500)
      const midNoise = (n1500 - n420) * 1.2, highNoise = (n3500 - n1500) * 1.05
      phase += 176 / synthesisRate; secondary += 326 / synthesisRate
      const shell = Math.sin(phase * Math.PI * 2) * .62 + Math.sin(secondary * Math.PI * 2) * .31
      sample = shell * stepped(Math.exp(-t * 20)) * .43
        + (midNoise * .62 + highNoise * .26) * stepped(Math.exp(-t * 15.5)) * .32
    } else {
      high = .88 * (high + raw - previous); previous = raw
      phase += (178 - 34 * t / duration) / synthesisRate
      sample = high * Math.exp(-t * 12) * .82 + Math.sin(phase * Math.PI * 2) * Math.exp(-t * 18) * .36
    }
    const fade = Math.max(0, Math.min(1, (duration - t) * 80))
    generated[index] = chip ? quantize8(Math.tanh(sample * .94) * fade) : quantize16(Math.tanh(sample * 1.18) * fade)
  }
  if (generated !== data) for (let index = 0; index < data.length; index++) data[index] = generated[Math.min(generated.length - 1, Math.floor(index * synthesisRate / rate))]
}

function drumSample(context: BaseAudioContext, voice: DrumVoice, kitId: DrumKitId): AudioBuffer {
  let cache = sampleCache.get(context)
  if (!cache) { cache = new Map(); sampleCache.set(context, cache) }
  const cacheKey = `${kitId}:${voice.id}`, existing = cache.get(cacheKey); if (existing) return existing
  const duration = kitId === 'fc-noise-8' && voice.id === 'kick' ? 1.15 : voice.duration
  const rate = context.sampleRate, length = Math.ceil(duration * rate)
  const buffer = context.createBuffer(1, length, rate), data = buffer.getChannelData(0)
  if (voice.id === 'snare') { fillSnare(data, rate, kitId); cache.set(cacheKey, buffer); return buffer }
  // Generate at the output rate: sample-and-hold used to mirror cymbal energy
  // into the top octave. Shape the noise and metal before reducing bit depth.
  const noise = makeNoise(0x2345 + voice.midi * 97), chip = kitId === 'fc-noise-8'
  const cymbal = voice.id === 'hat-closed' || voice.id === 'hat-open' || voice.id === 'crash'
  const cutoff = cymbal ? (chip ? 5400 : 6800) : 10000
  const alpha = (hz: number) => 1 - Math.exp(-2 * Math.PI * Math.min(hz, rate * .4) / rate)
  const bands = [80, 600, 1800, 4200, 6500].map(hz => ({ a: alpha(hz), value: 0 }))
  const outputAlpha = alpha(cutoff)
  const ratios = [1, 1.342, 1.618, 1.873, 2.137, 2.473], metalPhases = ratios.map(() => 0)
  let phase = 0, secondary = 0, smooth1 = 0, smooth2 = 0, quantizationError = 0
  for (let index = 0; index < length; index++) {
    const t = index / rate, raw = noise()
    for (const band of bands) band.value += band.a * (raw - band.value)
    const low = bands[1].value - bands[0].value
    const mid = bands[3].value - bands[1].value
    const air = bands[4].value - bands[2].value
    let sample = 0
    if (voice.id === 'kick') {
      const frequency = (chip ? 44 : 46) + 122 * Math.exp(-t * 58) + 24 * Math.exp(-t * 17)
      phase += frequency / rate
      const body = Math.sin(phase * 2 * Math.PI)
      const punch = Math.sin(phase * 4 * Math.PI) * .19 * Math.exp(-t * 18)
      sample = (body * 1.08 + punch) * Math.exp(-t * (chip ? 4.8 : 6.6))
        + mid * .34 * Math.exp(-t * 95) + air * .12 * Math.exp(-t * 180)
    } else if (voice.id === 'clap') {
      const burst = [0, .024, .049, .082].reduce((sum, start) => t >= start ? sum + Math.exp(-(t - start) * 85) : sum, 0)
      sample = (mid * 2 + air * .6) * Math.min(1.3, burst) * Math.exp(-t * 4.8) * .95
    } else if (voice.id === 'rim') {
      phase += 610 / rate; secondary += 880 / rate
      sample = (Math.sin(phase * 2 * Math.PI) * .55 + Math.sin(secondary * 2 * Math.PI) * .26 + mid * .5) * Math.exp(-t * 39)
    } else if (cymbal) {
      const crash = voice.id === 'crash', base = crash ? 1420 : 1910
      let metal = 0
      for (let i = 0; i < ratios.length; i++) {
        metalPhases[i] += base * ratios[i] / rate
        metal += Math.sin(metalPhases[i] * 2 * Math.PI)
      }
      const decay = voice.id === 'hat-closed' ? 48 : voice.id === 'hat-open' ? 9 : 4.2
      // Damped inharmonic sines replace the unfiltered square-wave cluster.
      // Lower overall cymbal level leaves room for snare transients.
      sample = (air * 1.8 + mid * (crash ? .32 : .12) + metal / ratios.length * .27)
        * Math.exp(-t * decay) * (crash ? .74 : .64)
      if (crash) sample *= .88 + .12 * Math.sin(t * 23)
    } else {
      const base = voice.id === 'tom-high' ? 178 : voice.id === 'tom-mid' ? 126 : 86
      phase += base * (1 + .45 * Math.exp(-t * 27)) / rate
      sample = (Math.sin(phase * Math.PI * 2) * .91 + Math.sin(phase * Math.PI * 4) * .1 + low * .25 * Math.exp(-t * 30))
        * Math.exp(-t * (voice.id === 'tom-low' ? 7.8 : 10))
    }
    const fade = Math.max(0, Math.min(1, (duration - t) * 100)) * Math.min(1, t * 2200)
    const shaped = Math.tanh(sample * 1.15) * fade
    // Error feedback retains an 8-bit edge without a gritty decaying noise floor.
    const value = chip ? quantize8(shaped + quantizationError * .75) : quantize16(shaped)
    quantizationError = chip ? shaped + quantizationError * .75 - value : 0
    smooth1 += outputAlpha * (value - smooth1); smooth2 += outputAlpha * (smooth1 - smooth2)
    data[index] = smooth2
  }
  cache.set(cacheKey, buffer)
  return buffer
}

export interface ScheduledDrumHit { source: AudioBufferSourceNode; gain: GainNode }

export function scheduleDrumHit(context: BaseAudioContext, destination: AudioNode, id: DrumVoiceId | undefined, velocity: number, at: number, requestedKit?: string): ScheduledDrumHit {
  const voice = drumVoice(id), kit = drumKit(requestedKit), source = context.createBufferSource(), gain = context.createGain()
  source.buffer = drumSample(context, voice, kit.id)
  gain.gain.setValueAtTime(Math.max(.0001, Math.min(1.25, velocity)) * (voice.id === 'snare' ? 2 : 1), at)
  source.connect(gain); gain.connect(destination); source.start(at); source.stop(at + source.buffer.duration + .01)
  return { source, gain }
}
