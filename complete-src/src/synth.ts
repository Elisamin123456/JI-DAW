/**
 * 内置合成器预置。
 *
 * 所有复合音色都只使用基频的整数倍泛音，不对单个声部偷偷加入失谐；
 * 因此音符传入的纯律频率会被原样保留。实时播放和离线导出共用本文件。
 */
export interface SynthLayer {
  waveform: OscillatorType
  ratio: number
  gain: number
  /** FC/NES 风格脉冲的占空比；省略时使用 waveform 的标准波形。 */
  pulseWidth?: number
  /** 需要逐级量化波形时使用的芯片波形。 */
  chipWave?: 'fc-triangle'
}

export interface SynthPreset {
  id: string
  name: string
  description: string
  layers: readonly SynthLayer[]
  attack: number
  decay: number
  sustain: number
  release: number
  level: number
  filterRatio?: number
  filterSustainRatio?: number
  filterMin?: number
  filterMax?: number
  filterQ?: number
  filterAttack?: number
  filterDecay?: number
  filterStages?: 1 | 2
}

export const SYNTH_INSTRUMENTS: readonly SynthPreset[] = [
  { id: 'pure-sine', name: '纯正弦', description: '无附加泛音，最适合检查纯律拍频', layers: [{ waveform: 'sine', ratio: 1, gain: 1 }], attack: .01, decay: .05, sustain: .92, release: .18, level: .22 },
  { id: 'fc-pulse-12', name: 'FC 脉冲 12.5%', description: '明亮纤细的早期 FC/NES 窄脉冲，无失谐、无音色低通', layers: [{ waveform: 'square', ratio: 1, gain: 1, pulseWidth: .125 }], attack: .004, decay: .08, sustain: .86, release: .09, level: .105 },
  { id: 'fc-pulse-25', name: 'FC 脉冲 25%', description: '经典早期 FC/NES 脉冲音色，无失谐、无音色低通', layers: [{ waveform: 'square', ratio: 1, gain: 1, pulseWidth: .25 }], attack: .004, decay: .08, sustain: .86, release: .09, level: .115 },
  { id: 'fc-pulse-50', name: 'FC 脉冲 50%', description: '饱满的早期 FC/NES 方波，无失谐、无音色低通', layers: [{ waveform: 'square', ratio: 1, gain: 1, pulseWidth: .5 }], attack: .004, decay: .08, sustain: .86, release: .09, level: .12 },
  { id: 'fc-triangle', name: 'FC 32阶三角波', description: '按 FC/NES 的 32 阶序列重建，保留阶梯波泛音', layers: [{ waveform: 'triangle', ratio: 1, gain: 1, chipWave: 'fc-triangle' }], attack: .004, decay: .06, sustain: .94, release: .08, level: .18 },
  { id: 'classic-triangle', name: '经典三角波', description: '柔和而清晰的经典合成器', layers: [{ waveform: 'triangle', ratio: 1, gain: 1 }], attack: .01, decay: .12, sustain: .74, release: .26, level: .2, filterRatio: 40, filterSustainRatio: 28, filterMin: 900, filterMax: 17000, filterQ: .1 },
  { id: 'classic-square', name: '经典方波', description: '空心而有力、保留高频泛音的方波音色', layers: [{ waveform: 'square', ratio: 1, gain: 1 }], attack: .008, decay: .13, sustain: .66, release: .22, level: .12, filterRatio: 64, filterSustainRatio: 48, filterMin: 1200, filterMax: 17500, filterQ: .1 },
  { id: 'classic-saw', name: '经典锯齿主奏', description: '明亮、保留高频泛音的模拟合成器主奏', layers: [{ waveform: 'sawtooth', ratio: 1, gain: 1 }], attack: .008, decay: .18, sustain: .6, release: .24, level: .11, filterRatio: 48, filterSustainRatio: 32, filterMin: 1100, filterMax: 17000, filterQ: .15 },
  { id: 'pure-organ', name: '纯律风琴', description: '整数泛音叠加，不引入十二平均律失谐', layers: [
    { waveform: 'sine', ratio: 1, gain: 1 }, { waveform: 'sine', ratio: 2, gain: .62 }, { waveform: 'sine', ratio: 3, gain: .38 },
    { waveform: 'sine', ratio: 4, gain: .25 }, { waveform: 'sine', ratio: 5, gain: .16 }, { waveform: 'sine', ratio: 6, gain: .1 }
  ], attack: .018, decay: .07, sustain: .92, release: .3, level: .22, filterRatio: 24, filterSustainRatio: 18, filterMin: 800, filterMax: 16000, filterQ: .1 },
  { id: 'odd-reed', name: '奇次泛音簧管', description: '以奇次整数泛音构成的簧管音色', layers: [
    { waveform: 'sine', ratio: 1, gain: 1 }, { waveform: 'sine', ratio: 3, gain: .42 }, { waveform: 'sine', ratio: 5, gain: .22 },
    { waveform: 'sine', ratio: 7, gain: .13 }, { waveform: 'sine', ratio: 9, gain: .07 }
  ], attack: .03, decay: .12, sustain: .8, release: .34, level: .2, filterRatio: 24, filterSustainRatio: 16, filterMin: 900, filterMax: 15500, filterQ: .25 },
  { id: 'sub-bass', name: '纯律低音', description: '基频、低八度与整数泛音构成的稳定低音', layers: [
    { waveform: 'sine', ratio: .5, gain: .52 }, { waveform: 'sine', ratio: 1, gain: 1 }, { waveform: 'triangle', ratio: 2, gain: .18 }
  ], attack: .016, decay: .16, sustain: .7, release: .3, level: .22, filterRatio: 18, filterSustainRatio: 10, filterMin: 240, filterMax: 7000, filterQ: .15 },
  { id: 'warm-pad', name: '纯律暖垫', description: '慢起音的整数泛音垫底音色，无拍频失谐', layers: [
    { waveform: 'triangle', ratio: 1, gain: 1 }, { waveform: 'sine', ratio: 2, gain: .32 }, { waveform: 'sine', ratio: 3, gain: .16 }
  ], attack: .38, decay: .55, sustain: .68, release: 1.2, level: .18, filterRatio: 24, filterSustainRatio: 14, filterMin: 700, filterMax: 14500, filterQ: .2 },
  { id: 'crystal-bell', name: '水晶钟', description: '整数泛音钟声，适合展示长衰减纯律和弦', layers: [
    { waveform: 'sine', ratio: 1, gain: 1 }, { waveform: 'sine', ratio: 2, gain: .66 }, { waveform: 'sine', ratio: 3, gain: .27 },
    { waveform: 'sine', ratio: 4, gain: .2 }, { waveform: 'sine', ratio: 6, gain: .12 }
  ], attack: .005, decay: 1.3, sustain: .05, release: 1.65, level: .2, filterRatio: 32, filterSustainRatio: 24, filterMin: 1000, filterMax: 17000, filterQ: .15 }
] as const

export const DEFAULT_SYNTH_ID = 'classic-triangle'

export function synthPreset(id?: string): SynthPreset {
  return SYNTH_INSTRUMENTS.find(item => item.id === id) ?? SYNTH_INSTRUMENTS.find(item => item.id === DEFAULT_SYNTH_ID)!
}

export interface ScheduledSynthVoice {
  sources: AudioScheduledSourceNode[]
  nodes: AudioNode[]
}

const periodicWaveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>()

function waveCache(context: BaseAudioContext): Map<string, PeriodicWave> {
  let cache = periodicWaveCache.get(context)
  if (!cache) { cache = new Map(); periodicWaveCache.set(context, cache) }
  return cache
}

function additivePeriodicWave(context: BaseAudioContext, preset: SynthPreset, frequency: number): PeriodicWave | null {
  if (preset.layers.length < 2 || !preset.layers.every(layer => layer.waveform === 'sine' && Number.isInteger(layer.ratio) && layer.ratio > 0)) return null
  const layers = preset.layers.filter(layer => frequency * layer.ratio < context.sampleRate * .45)
  if (!layers.length) return null
  const cache = waveCache(context), key = `${preset.id}:${layers.map(layer => layer.ratio).join(',')}`
  const cached = cache.get(key); if (cached) return cached
  const maximum = Math.max(...layers.map(layer => layer.ratio)), real = new Float32Array(maximum + 1), imag = new Float32Array(maximum + 1)
  const total = Math.max(.001, layers.reduce((sum, layer) => sum + Math.abs(layer.gain), 0))
  for (const layer of layers) imag[layer.ratio] += layer.gain / total
  const wave = context.createPeriodicWave(real, imag, { disableNormalization: true })
  cache.set(key, wave)
  return wave
}

function bandLimitedBasicWave(context: BaseAudioContext, type: OscillatorType, frequency: number, pulseWidth?: number): PeriodicWave | null {
  if (type !== 'square' && type !== 'sawtooth' && type !== 'triangle') return null
  const nyquistHarmonic = Math.floor(context.sampleRate * .45 / Math.max(1, frequency))
  const maximum = Math.max(1, Math.min(512, nyquistHarmonic))
  const duty = pulseWidth == null ? null : Math.max(.01, Math.min(.99, pulseWidth))
  const cache = waveCache(context), key = duty == null ? `${type}:${maximum}` : `pulse:${duty}:${maximum}`
  const cached = cache.get(key); if (cached) return cached
  const real = new Float32Array(maximum + 1), imag = new Float32Array(maximum + 1)
  for (let harmonic = 1; harmonic <= maximum; harmonic++) {
    if (duty != null) {
      // 以脉冲中心为相位原点；去掉直流但保留准确占空比对应的全部安全谐波。
      real[harmonic] = Math.sin(Math.PI * harmonic * duty) / harmonic
    } else if (type === 'square') {
      if (harmonic % 2) imag[harmonic] = 1 / harmonic
    } else if (type === 'sawtooth') imag[harmonic] = (harmonic % 2 ? 1 : -1) / harmonic
    else if (harmonic % 2) imag[harmonic] = (harmonic % 4 === 1 ? 1 : -1) / (harmonic * harmonic)
  }
  const wave = context.createPeriodicWave(real, imag)
  cache.set(key, wave)
  return wave
}

/** FC/NES APU 的 32 阶、逐级保持三角序列，并按当前音高安全带限。 */
function fcTrianglePeriodicWave(context: BaseAudioContext, frequency: number): PeriodicWave {
  const maximum = Math.max(1, Math.min(512, Math.floor(context.sampleRate * .45 / Math.max(1, frequency))))
  const cache = waveCache(context), key = `fc-triangle:${maximum}`
  const cached = cache.get(key); if (cached) return cached
  const steps = [...Array.from({ length: 16 }, (_, index) => 15 - index), ...Array.from({ length: 16 }, (_, index) => index)]
  const real = new Float32Array(maximum + 1), imag = new Float32Array(maximum + 1)
  for (let harmonic = 1; harmonic <= maximum; harmonic++) {
    for (let index = 0; index < steps.length; index++) {
      const sample = (steps[index] - 7.5) / 7.5
      const phaseStart = 2 * Math.PI * harmonic * index / steps.length
      const phaseEnd = 2 * Math.PI * harmonic * (index + 1) / steps.length
      real[harmonic] += sample * (Math.sin(phaseEnd) - Math.sin(phaseStart)) / (Math.PI * harmonic)
      imag[harmonic] += sample * (Math.cos(phaseStart) - Math.cos(phaseEnd)) / (Math.PI * harmonic)
    }
  }
  const wave = context.createPeriodicWave(real, imag)
  cache.set(key, wave)
  return wave
}

function perceivedLevelCompensation(frequency: number): number {
  // 只做温和补偿，避免低音听感突然变小，同时给极高音留出峰值余量。
  const octavesBelowA4 = Math.log2(440 / Math.max(20, frequency))
  return 2 ** (Math.max(-2, Math.min(3, octavesBelowA4)) * .075)
}

/** 按精确 Hz 调度一个音色；不经过 MIDI 音高量化。 */
export function scheduleSynthVoice(
  context: BaseAudioContext,
  destination: AudioNode,
  frequency: number,
  velocity: number,
  at: number,
  duration: number,
  presetId?: string
): ScheduledSynthVoice {
  const preset = synthPreset(presetId)
  const envelope = context.createGain()
  const peak = Math.max(.0001, Math.min(1.25, velocity) * preset.level * perceivedLevelCompensation(frequency))
  const releaseAt = at + Math.max(.01, duration)
  const attackDuration = Math.min(preset.attack, Math.max(.001, duration))
  const attackEnd = at + attackDuration
  const decayDuration = Math.min(preset.decay, Math.max(0, releaseAt - attackEnd))
  const decayEnd = attackEnd + decayDuration
  const sustainPeak = peak * preset.sustain
  const releaseValue = duration <= preset.attack
    ? peak * Math.max(.05, duration / Math.max(.001, preset.attack))
    : duration < preset.attack + preset.decay
      ? peak + (sustainPeak - peak) * ((duration - preset.attack) / Math.max(.001, preset.decay))
      : sustainPeak

  const filters: BiquadFilterNode[] = []
  if (preset.filterRatio) {
    const filterCeiling = Math.min(preset.filterMax ?? 12000, context.sampleRate * .44)
    const filterFloor = Math.min(preset.filterMin ?? 80, filterCeiling)
    const cutoffFor = (ratio: number) => Math.max(filterFloor, Math.min(filterCeiling, frequency * ratio))
    const baseCutoff = cutoffFor(preset.filterSustainRatio ?? preset.filterRatio), peakCutoff = cutoffFor(preset.filterRatio)
    const filterAttackEnd = at + Math.min(Math.max(0, preset.filterAttack ?? 0), Math.max(.001, duration))
    const filterDecayEnd = Math.min(releaseAt, filterAttackEnd + Math.max(0, preset.filterDecay ?? 0))
    for (let index = 0; index < (preset.filterStages ?? 1); index++) {
      const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = (preset.filterQ ?? 0) / (preset.filterStages ?? 1)
      filter.frequency.setValueAtTime(baseCutoff, at)
      if (filterAttackEnd > at && peakCutoff !== baseCutoff) filter.frequency.linearRampToValueAtTime(peakCutoff, filterAttackEnd)
      else filter.frequency.setValueAtTime(peakCutoff, at)
      if (filterDecayEnd > filterAttackEnd && peakCutoff !== baseCutoff) filter.frequency.exponentialRampToValueAtTime(Math.max(20, baseCutoff), filterDecayEnd)
      filters.push(filter)
    }
    filters.forEach((filter, index) => filter.connect(filters[index + 1] ?? envelope))
  }
  envelope.connect(destination)

  envelope.gain.setValueAtTime(.0001, at)
  envelope.gain.linearRampToValueAtTime(peak, attackEnd)
  if (decayDuration > 0) envelope.gain.exponentialRampToValueAtTime(Math.max(.0001, sustainPeak), decayEnd)
  envelope.gain.setValueAtTime(Math.max(.0001, releaseValue), releaseAt)
  envelope.gain.exponentialRampToValueAtTime(.0001, releaseAt + preset.release)

  const layerTotal = Math.max(.001, preset.layers.reduce((sum, layer) => sum + Math.abs(layer.gain), 0))
  const sources: AudioScheduledSourceNode[] = []
  const nodes: AudioNode[] = [envelope]
  nodes.push(...filters)
  const filterInput: AudioNode = filters[0] ?? envelope
  const periodicWave = additivePeriodicWave(context, preset, frequency)
  if (periodicWave) {
    const oscillator = context.createOscillator()
    oscillator.setPeriodicWave(periodicWave)
    oscillator.frequency.setValueAtTime(frequency, at)
    oscillator.connect(filterInput)
    oscillator.start(at); oscillator.stop(releaseAt + preset.release + .06)
    sources.push(oscillator)
    return { sources, nodes }
  }
  for (const layer of preset.layers) {
    const layerFrequency = frequency * layer.ratio
    if (layerFrequency >= context.sampleRate * .47) continue
    const oscillator = context.createOscillator()
    const layerGain = context.createGain()
    const basicWave = layer.chipWave === 'fc-triangle'
      ? fcTrianglePeriodicWave(context, layerFrequency)
      : bandLimitedBasicWave(context, layer.waveform, layerFrequency, layer.pulseWidth)
    if (basicWave) oscillator.setPeriodicWave(basicWave); else oscillator.type = layer.waveform
    oscillator.frequency.setValueAtTime(layerFrequency, at)
    layerGain.gain.value = layer.gain / layerTotal
    oscillator.connect(layerGain)
    layerGain.connect(filterInput)
    oscillator.start(at)
    oscillator.stop(releaseAt + preset.release + .06)
    sources.push(oscillator)
    nodes.push(layerGain)
  }
  return { sources, nodes }
}
