import { createSF2Player, type SF2Player, type SF2Program } from '@gwegash/sf2-player'
import { drumVoice, scheduleDrumHit } from './drums'
import { scheduleSynthVoice, synthPreset } from './synth'
import { swungBeat } from './timing'
import { createTrackBus, updateTrackBus, drumLevel, reverbSettings, type TrackBus } from './mixer'
import type { AudioClip, JiNote, JiProject, Track } from './types'

export const BUILTIN_INSTRUMENTS = [
  { id: 'salamander-piano', name: 'Salamander Grand Piano' },
  { id: 'vcsl-strumstick', name: 'VCSL Strumstick' },
  { id: 'vcsl-vibraphone', name: 'VCSL Vibraphone' },
  { id: 'vcsl-ksharp', name: 'VCSL K‑Sharp' },
  { id: 'vcsl-pipeorgan-rode', name: 'VCSL Pipe Organ Rode' }
] as const

interface BuiltinDefinition {
  release: number
  samples: Array<{ midi: number; path: string }>
}

function midiOf(name: string): number {
  const match = /^([A-G])(#?)(-?\d+)$/.exec(name)
  if (!match) throw new Error(`无效采样音名：${name}`)
  const semitones: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  return (Number(match[3]) + 1) * 12 + semitones[match[1]] + (match[2] ? 1 : 0)
}

function samples(directory: string, extension: string, entries: string[]): BuiltinDefinition['samples'] {
  return entries.map(entry => {
    const [note, fileStem = note] = entry.split(':')
    return { midi: midiOf(note), path: `${directory}/${fileStem}.${extension}` }
  })
}

const BUILTIN_DEFINITIONS: Record<string, BuiltinDefinition> = {
  'salamander-piano': {
    release: 1.25,
    samples: samples('salamander', 'mp3', [
      ...Array.from({ length: 8 }, (_, octave) => `A${octave}`),
      ...Array.from({ length: 7 }, (_, index) => `D#${index + 1}:Ds${index + 1}`),
      ...Array.from({ length: 8 }, (_, index) => `C${index + 1}`),
      ...Array.from({ length: 7 }, (_, index) => `F#${index + 1}:Fs${index + 1}`)
    ])
  },
  'vcsl-strumstick': {
    release: 1.25,
    samples: samples('strumstick', 'ogg', ['A2', 'A3', 'A4', 'B2', 'B3', 'C#3:Cs3', 'C#4:Cs4', 'D2', 'D3', 'D4', 'E2', 'E3', 'E4', 'F#2:Fs2', 'F#3:Fs3', 'F#4:Fs4', 'G2', 'G3', 'G4'])
  },
  'vcsl-vibraphone': {
    release: 1.25,
    samples: samples('vibraphone', 'ogg', ['A2', 'A4', 'B3', 'C3', 'C5', 'D4', 'E3', 'E5', 'F2', 'F4', 'G3'])
  },
  'vcsl-ksharp': {
    release: 1.25,
    samples: samples('ksharp', 'ogg', ['A4', 'B1', 'B5', 'B6', 'C3', 'D4', 'E5', 'F2', 'F6', 'G3'])
  },
  'vcsl-pipeorgan-rode': {
    release: 1.25,
    samples: samples('pipeorgan', 'ogg', ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'F#1:Fs1', 'F#2:Fs2', 'F#3:Fs3', 'F#4:Fs4', 'F#5:Fs5'])
  }
}

interface LoadedFont {
  player: ExactSF2Player
  path?: string
  programs: readonly SF2Program[]
  bankKey: object
  outputGain: GainNode
  limiter: DynamicsCompressorNode
  drums: Map<string, GainNode>
}

interface ExactSF2Player extends SF2Player {
  noteOnExact: (key: number, pitch: number, velocity?: number, time?: number, destination?: AudioNode) => number
  noteOffVoice: (voiceId: number, time?: number) => void
  cloneForContext: (context: BaseAudioContext) => Promise<ExactSF2Player>
  releaseSeconds: (key: number, velocity?: number) => number
}

export interface RenderChunk {
  buffer: AudioBuffer
  from: number
  length: number
  completedFrames: number
  totalFrames: number
}

export interface RenderOptions {
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
  onStatus?: (message: string) => void
}

function validateSf2(bytes: Uint8Array): void {
  if (bytes.byteLength < 12) throw new Error('SF2 文件不完整')
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (text(0) !== 'RIFF' || text(8) !== 'sfbk') throw new Error('文件不是有效的 SoundFont 2（RIFF/sfbk）')
}

function scheduleSf2(player: ExactSF2Player, midi: number, velocity: number, start: number, end: number, destination?: AudioNode): void {
  const key = Math.max(0, Math.min(127, Math.round(midi)))
  const voiceId = player.noteOnExact(key, midi, velocity, start, destination)
  player.noteOffVoice(voiceId, end)
}

function sf2Velocity(velocity: number): number {
  return Math.max(1, Math.min(127, Math.round(velocity * 127)))
}

export class AudioEngine {
  private context: AudioContext | null = null
  private compressor: DynamicsCompressorNode | null = null
  private masterGain: GainNode | null = null
  private buses = new Map<string, TrackBus>()
  private drumBuses = new Map<string, Map<string, GainNode>>()
  private bundledBytes: Promise<Uint8Array> | undefined
  private fonts = new Map<string, LoadedFont>()
  private builtinBuffers = new Map<string, Map<number, AudioBuffer>>()
  private builtinLoads = new Map<string, Promise<Map<number, AudioBuffer>>>()
  private audioBuffers = new Map<string, AudioBuffer>()
  private activeSources = new Set<AudioScheduledSourceNode>()
  private schedulerTimer: number | null = null
  private nextScheduleBeat = 0
  private nextScheduleTime = 0
  private includeInitialOverlaps = false
  private frame = 0
  private project: JiProject | null = null
  private contextStart = 0
  private playStartBeat = 0
  private onPosition: ((beat: number) => void) | null = null
  private onEnded: (() => void) | null = null
  playing = false

  private getContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'balanced' })
      this.compressor = this.context.createDynamicsCompressor()
      this.masterGain = this.context.createGain()
      this.compressor.threshold.value = -14
      this.compressor.knee.value = 12
      this.compressor.ratio.value = 8
      this.compressor.attack.value = 0.002
      this.compressor.release.value = 0.16
      this.masterGain.gain.value = .82
      this.compressor.connect(this.masterGain); this.masterGain.connect(this.context.destination)
    }
    return this.context
  }

  async resume(): Promise<void> {
    const context = this.getContext()
    if (context.state === 'suspended') await context.resume()
  }

  private busFor(track: Track): TrackBus {
    const context = this.getContext()
    let bus = this.buses.get(track.id)
    if (!bus) {
      bus = createTrackBus(context, this.compressor!, track)
      this.buses.set(track.id, bus)
    }
    return bus
  }

  private drumInput(track: Track, id: JiNote['drumId'], font?: LoadedFont): GainNode {
    let gains = font?.drums ?? this.drumBuses.get(track.id)
    if (!gains) { gains = new Map(); this.drumBuses.set(track.id, gains) }
    const voice = drumVoice(id)
    let gain = gains.get(voice.id)
    if (!gain) {
      gain = this.getContext().createGain(); gain.gain.value = drumLevel(track, voice.id)
      gain.connect(font ? font.player.output : this.busFor(track).input); gains.set(voice.id, gain)
    }
    return gain
  }

  syncTracks(tracks: Track[]): void {
    const anySolo = tracks.some(track => track.solo)
    for (const track of tracks) {
      updateTrackBus(this.getContext(), this.busFor(track), track, track.muted || (anySolo && !track.solo))
      for (const gains of [this.drumBuses.get(track.id), this.fonts.get(track.id)?.drums]) {
        for (const [id, gain] of gains ?? []) gain.gain.setTargetAtTime(drumLevel(track, drumVoice(id).id), this.getContext().currentTime, .008)
      }
      if ((track.type ?? 'instrument') === 'instrument' && track.instrument.kind === 'builtin' && track.instrument.builtinId) void this.ensureBuiltin(track.instrument.builtinId).catch(() => undefined)
    }
    const ids = new Set(tracks.map(track => track.id))
    for (const [id, bus] of this.buses) {
      if (!ids.has(id)) {
        for (const node of bus.nodes) node.disconnect()
        for (const node of this.drumBuses.get(id)?.values() ?? []) node.disconnect()
        this.drumBuses.delete(id); this.buses.delete(id)
        const font = this.fonts.get(id)
        for (const node of font?.drums.values() ?? []) node.disconnect()
        font?.player.dispose(); font?.outputGain.disconnect(); font?.limiter.disconnect(); this.fonts.delete(id)
      }
    }
  }

  async loadAudioClip(clip: AudioClip, bytes: Uint8Array): Promise<number> {
    const copy = bytes.slice().buffer
    const buffer = await this.getContext().decodeAudioData(copy)
    this.audioBuffers.set(clip.id, buffer)
    clip.sourceDuration = buffer.duration
    clip.missing = false
    return buffer.duration
  }

  hasAudioClip(clipId: string): boolean {
    return this.audioBuffers.has(clipId)
  }

  async loadSf2(track: Track, bytes: Uint8Array, path?: string, sourceTrackId?: string): Promise<readonly SF2Program[]> {
    await this.resume()
    validateSf2(bytes)
    const old = this.fonts.get(track.id)
    const context = this.getContext()
    const normalizedPath = path?.replaceAll('\\', '/').toLowerCase()
    const shared = sourceTrackId ? this.fonts.get(sourceTrackId) : normalizedPath ? [...this.fonts.values()].find(font => font.path?.replaceAll('\\', '/').toLowerCase() === normalizedPath) : undefined
    const player = shared ? await shared.player.cloneForContext(context) : await createSF2Player(context, bytes) as ExactSF2Player
    const outputGain = context.createGain(), limiter = context.createDynamicsCompressor()
    // SoundFont 的区层数量和原始采样电平差异很大；预衰减加快速峰值限制可避免多层音色炸音。
    outputGain.gain.value = .48
    limiter.threshold.value = -10; limiter.knee.value = 4; limiter.ratio.value = 12
    limiter.attack.value = .0015; limiter.release.value = .12
    player.output.connect(outputGain); outputGain.connect(limiter); limiter.connect(this.busFor(track).input)
    const index = Math.min(Math.max(track.instrument.programIndex || 0, 0), player.programs.length - 1)
    player.selectProgram(index)
    if (old) { old.player.dispose(); old.outputGain.disconnect(); old.limiter.disconnect(); for (const node of old.drums.values()) node.disconnect() }
    this.fonts.set(track.id, { player, path, programs: player.programs, bankKey: shared?.bankKey ?? {}, outputGain, limiter, drums: new Map() })
    return player.programs
  }

  async loadBundledSf2(track: Track): Promise<readonly SF2Program[]> {
    const path = 'builtin:Touhou.sf2'
    const shared = [...this.fonts.entries()].find(([, font]) => font.path === path)
    this.bundledBytes ??= this.readBuiltinBytes('Touhou.sf2').then(value => new Uint8Array(value)).catch(error => { this.bundledBytes = undefined; throw error })
    return this.loadSf2(track, await this.bundledBytes, path, shared?.[0])
  }

  getPrograms(trackId: string): readonly SF2Program[] {
    return this.fonts.get(trackId)?.programs ?? []
  }

  selectProgram(trackId: string, index: number): void {
    this.fonts.get(trackId)?.player.selectProgram(index)
  }

  hasFont(trackId: string): boolean {
    return this.fonts.has(trackId)
  }

  private async readBuiltinBytes(relativePath: string): Promise<ArrayBuffer> {
    if (window.desktop) {
      const file = await window.desktop.readBuiltinSound(relativePath)
      const value = file?.bytes
      if (value instanceof Uint8Array) return value.slice().buffer
      if (value && typeof value === 'object' && 'data' in value && Array.isArray(value.data)) return Uint8Array.from(value.data).buffer
      throw new Error(`无法读取内置采样：${relativePath}`)
    }
    const url = new URL(`sound/${relativePath}`, document.baseURI)
    if (relativePath === 'Touhou.sf2') {
      // Static hosting distributes this bank in smaller files. Desktop builds
      // continue to read the original SF2 through the native bridge above.
      const manifestResponse = await fetch(`${url}.json`)
      if (manifestResponse.ok && manifestResponse.headers.get('content-type')?.includes('application/json')) {
        const manifest = await manifestResponse.json() as { size: number; parts: Array<{ file: string; size: number }> }
        if (!Number.isSafeInteger(manifest.size) || manifest.size <= 0 || !Array.isArray(manifest.parts) || !manifest.parts.length) throw new Error('Touhou 音源清单无效')
        const bytes = new Uint8Array(manifest.size)
        let offset = 0
        for (const part of manifest.parts) {
          if (!/^Touhou\.sf2\.part\d{2}$/.test(part.file) || !Number.isSafeInteger(part.size) || part.size <= 0) throw new Error('Touhou 音源分块无效')
          const response = await fetch(new URL(part.file, url))
          if (!response.ok) throw new Error(`无法读取 Touhou 音源分块：${part.file}`)
          const chunk = new Uint8Array(await response.arrayBuffer())
          if (chunk.length !== part.size || offset + chunk.length > bytes.length) throw new Error(`Touhou 音源分块不完整：${part.file}`)
          bytes.set(chunk, offset); offset += chunk.length
        }
        if (offset !== bytes.length) throw new Error('Touhou 音源不完整')
        return bytes.buffer
      }
    }
    const response = await fetch(url)
    if (!response.ok) throw new Error(`无法读取内置采样：${relativePath}`)
    return response.arrayBuffer()
  }

  private ensureBuiltin(id: string): Promise<Map<number, AudioBuffer>> {
    const cached = this.builtinBuffers.get(id)
    if (cached) return Promise.resolve(cached)
    const pending = this.builtinLoads.get(id)
    if (pending) return pending
    const definition = BUILTIN_DEFINITIONS[id]
    if (!definition) return Promise.reject(new Error('未知内置音色'))
    const load = Promise.all(definition.samples.map(async sample => {
      const data = await this.readBuiltinBytes(sample.path)
      return [sample.midi, await this.getContext().decodeAudioData(data.slice(0))] as const
    })).then(entries => {
      const buffers = new Map<number, AudioBuffer>(entries)
      this.builtinBuffers.set(id, buffers)
      this.builtinLoads.delete(id)
      return buffers
    }).catch(error => {
      this.builtinLoads.delete(id)
      throw error
    })
    this.builtinLoads.set(id, load)
    return load
  }

  private sampledNoteOn(track: Track, note: JiNote, at: number, duration: number, id: string): boolean {
    const buffers = this.builtinBuffers.get(id)
    const definition = BUILTIN_DEFINITIONS[id]
    if (!buffers?.size || !definition) return false
    const context = this.getContext()
    const midi = 69 + 12 * Math.log2(note.frequency / 440)
    const sampleMidi = [...buffers.keys()].reduce((best, key) => Math.abs(key - midi) < Math.abs(best - midi) ? key : best)
    const source = context.createBufferSource()
    const envelope = context.createGain()
    source.buffer = buffers.get(sampleMidi)!
    source.playbackRate.setValueAtTime(2 ** ((midi - sampleMidi) / 12), at)
    const peak = Math.max(0.0001, Math.min(note.velocity, 1.25))
    envelope.gain.setValueAtTime(peak, at)
    envelope.gain.setValueAtTime(peak, at + Math.max(.01, duration))
    envelope.gain.exponentialRampToValueAtTime(.0001, at + duration + definition.release)
    source.connect(envelope); envelope.connect(this.busFor(track).input)
    source.start(at); source.stop(at + duration + definition.release + .05)
    this.activeSources.add(source)
    source.onended = () => { source.disconnect(); envelope.disconnect(); this.activeSources.delete(source) }
    return true
  }

  private noteOn(track: Track, note: JiNote, at: number, duration: number): void {
    if (note.muted || note.ghost || note.velocity <= 0 || duration <= 0) return
    const context = this.getContext()
    if (track.type === 'drum' && track.instrument.kind !== 'sf2') {
      const hit = scheduleDrumHit(context, this.drumInput(track, note.drumId), note.drumId, note.velocity, at, track.instrument.synthId)
      this.activeSources.add(hit.source)
      hit.source.onended = () => { hit.source.disconnect(); hit.gain.disconnect(); this.activeSources.delete(hit.source) }
      return
    }
    const midi = track.type === 'drum' ? drumVoice(note.drumId).midi : 69 + 12 * Math.log2(note.frequency / 440)
    const font = this.fonts.get(track.id)
    if (track.instrument.kind === 'sf2' && font) {
      const velocity = sf2Velocity(note.velocity)
      scheduleSf2(font.player, midi, velocity, at, at + duration, track.type === 'drum' ? this.drumInput(track, note.drumId, font) : undefined)
      return
    }
    if (track.instrument.kind === 'sf2') return
    if (track.instrument.kind === 'builtin' && track.instrument.builtinId && this.sampledNoteOn(track, note, at, duration, track.instrument.builtinId)) return
    const voice = scheduleSynthVoice(context, this.busFor(track).input, note.frequency, note.velocity, at, duration, track.instrument.synthId)
    let remaining = voice.sources.length
    for (const source of voice.sources) {
      this.activeSources.add(source)
      source.onended = () => {
        source.disconnect(); this.activeSources.delete(source)
        if (--remaining === 0) for (const node of voice.nodes) node.disconnect()
      }
    }
  }

  private audioClipOn(track: Track, clip: AudioClip, fromBeat: number, windowEndBeat: number, projectEndBeat: number, startAt: number, beatSeconds: number, includeOverlaps: boolean): void {
    const buffer = this.audioBuffers.get(clip.id)
    if (!buffer) return
    const offsetSeconds = Math.max(0, clip.offsetSeconds || 0)
    const availableSeconds = Math.max(0, buffer.duration - offsetSeconds)
    const clipEndBeat = clip.beat + availableSeconds / beatSeconds
    const startsInWindow = clip.beat >= fromBeat - 1e-7 && clip.beat < windowEndBeat - 1e-7
    const overlapsStart = includeOverlaps && clip.beat < fromBeat - 1e-7 && clipEndBeat > fromBeat + 1e-7
    if (availableSeconds <= 0 || (!startsInWindow && !overlapsStart)) return
    const overlapStart = Math.max(clip.beat, fromBeat)
    const sourceOffset = offsetSeconds + (overlapStart - clip.beat) * beatSeconds
    const duration = Math.min(buffer.duration - sourceOffset, (projectEndBeat - overlapStart) * beatSeconds)
    if (duration <= 0) return
    const context = this.getContext()
    const source = context.createBufferSource()
    const clipGain = context.createGain()
    source.buffer = buffer
    clipGain.gain.value = Math.max(0, Math.min(clip.gain ?? 1, 2))
    source.connect(clipGain)
    clipGain.connect(this.busFor(track).input)
    const at = startAt + (overlapStart - fromBeat) * beatSeconds
    source.start(at, sourceOffset, duration)
    source.stop(at + duration + .01)
    this.activeSources.add(source)
    source.onended = () => { source.disconnect(); clipGain.disconnect(); this.activeSources.delete(source) }
  }

  private click(at: number, strong: boolean): void {
    const context = this.getContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = strong ? 1400 : 950
    gain.gain.setValueAtTime(strong ? 0.12 : 0.07, at)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.035)
    oscillator.connect(gain); gain.connect(this.compressor!)
    oscillator.start(at); oscillator.stop(at + 0.04)
    this.activeSources.add(oscillator)
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.activeSources.delete(oscillator) }
  }

  private beatsPerBar(project: JiProject): number {
    const [top, bottom] = project.signature.split('/').map(Number)
    return top * 4 / bottom
  }

  async *renderChunks(project: JiProject, options: RenderOptions = {}): AsyncGenerator<RenderChunk> {
    const { signal, onProgress, onStatus } = options
    signal?.throwIfAborted()
    onStatus?.('检查工程与音源…')
    const sampleRate = 44100, endLimit = project.bars * this.beatsPerBar(project)
    const beatSeconds = 60 / project.bpm
    if (!Number.isFinite(endLimit) || endLimit <= 0 || !Number.isFinite(beatSeconds) || beatSeconds <= 0) throw new Error('工程速度或长度无效')
    const anySolo = project.tracks.some(track => track.solo)
    const tracks = project.tracks.filter(track => !track.muted && (!anySolo || track.solo))
    const missingFonts = tracks.filter(track => track.type !== 'audio' && track.instrument.kind === 'sf2'
      && (!this.fonts.has(track.id) || track.instrument.missing)
      && track.notes.some(note => !note.muted && !note.ghost && note.beat < endLimit && note.beat + note.duration > 0))
    if (missingFonts.length) throw new Error(`缺少 SF2 音源：\n${missingFonts.map(track => `轨道「${track.name}」：${track.instrument.name} · ${track.instrument.programName || `预置 ${track.instrument.programIndex}`}`).join('\n')}\n请点击“重新定位 SF2”，选择音源文件后重试。`)
    const notes = tracks.flatMap(track => (track.type ?? 'instrument') === 'audio' ? [] : track.notes.flatMap(note => {
      if (note.muted || note.ghost || note.velocity <= 0) return []
      const startBeat = Math.max(0, swungBeat(note.beat, project))
      const endBeat = Math.min(endLimit, startBeat + note.duration)
      if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || endBeat <= startBeat) return []
      if (track.type !== 'drum' && (!Number.isFinite(note.frequency) || note.frequency <= 0)) throw new Error(`轨道「${track.name}」包含无效音高`)
      if (!Number.isFinite(note.velocity)) throw new Error(`轨道「${track.name}」包含无效力度`)
      const midi = track.type === 'drum' ? drumVoice(note.drumId).midi : 69 + 12 * Math.log2(note.frequency / 440)
      let release = synthPreset(track.instrument.synthId).release + .06
      if (track.type === 'drum' && track.instrument.kind !== 'sf2') release = track.instrument.synthId === 'fc-noise-8' && drumVoice(note.drumId).id === 'kick' ? 1.16 : drumVoice(note.drumId).duration + .01
      else if (track.instrument.kind === 'builtin') release = (BUILTIN_DEFINITIONS[track.instrument.builtinId || '']?.release ?? 1.25) + .05
      else if (track.instrument.kind === 'sf2') {
        const font = this.fonts.get(track.id)
        if (!font) throw new Error(`请先为轨道「${track.name}」加载 SF2 音源`)
        release = font.player.releaseSeconds(Math.max(0, Math.min(127, Math.round(midi))), sf2Velocity(note.velocity))
      }
      const start = startBeat * beatSeconds, end = endBeat * beatSeconds
      return [{ track, note, midi, start, end, audibleEnd: (track.type === 'drum' && track.instrument.kind !== 'sf2' ? start : end) + release + (reverbSettings(track).mix ? reverbSettings(track).decay : 0) }]
    })).sort((a, b) => a.start - b.start)
    const clips = tracks.flatMap(track => (track.type ?? 'instrument') !== 'audio' ? [] : (track.audioClips ?? []).flatMap(clip => {
      if (clip.beat >= endLimit) return []
      const buffer = this.audioBuffers.get(clip.id)
      if (!buffer) throw new Error(`请先为轨道「${track.name}」重新加载音频「${clip.name}」`)
      const skipped = Math.max(0, -clip.beat * beatSeconds)
      const start = Math.max(0, clip.beat * beatSeconds)
      const sourceOffset = Math.max(0, clip.offsetSeconds || 0) + skipped
      const duration = Math.min(buffer.duration - sourceOffset, endLimit * beatSeconds - start)
      return duration > 0 ? [{ track, clip, buffer, sourceOffset, start, end: start + duration }] : []
    }))
    if (!notes.length && !clips.length) throw new Error('工程中没有可导出的音频内容')
    const contentEnd = Math.max(notes.reduce((end, item) => Math.max(end, item.end), 0), clips.reduce((end, item) => Math.max(end, item.end), 0))
    const audibleEnd = Math.max(notes.reduce((end, item) => Math.max(end, item.audibleEnd), 0), clips.reduce((end, item) => Math.max(end, item.end + (reverbSettings(item.track).mix ? reverbSettings(item.track).decay : 0)), 0))
    const durationSeconds = Math.min(contentEnd + 8, audibleEnd + .2)
    if (durationSeconds > 20 * 60) throw new Error('MP3 导出暂不支持超过 20 分钟的工程')
    const totalFrames = Math.ceil(durationSeconds * sampleRate)
    onStatus?.('准备采样音源…')
    await Promise.all([...new Set(notes.map(({ track }) => track.type !== 'drum' && track.instrument.kind === 'builtin' ? track.instrument.builtinId : undefined)
      .filter((id): id is string => Boolean(id)))].map(id => this.ensureBuiltin(id)))
    signal?.throwIfAborted()

    // Share parsed SoundFonts and decoded samples between chunks. Keep one bank
    // per track at the export sample rate, instead of reparsing every segment.
    const banks = new Map<string, ExactSF2Player>()
    const sharedBanks = new Map<object, ExactSF2Player>()
    try {
      for (const { track } of notes) {
        if (track.instrument.kind !== 'sf2' || banks.has(track.id)) continue
        signal?.throwIfAborted()
        onStatus?.(`准备 SF2 音源：${track.name}`)
        const holder = new OfflineAudioContext(2, 1, sampleRate)
        const loaded = this.fonts.get(track.id)!
        const bank = await (sharedBanks.get(loaded.bankKey) ?? loaded.player).cloneForContext(holder)
        sharedBanks.set(loaded.bankKey, bank)
        banks.set(track.id, bank)
        bank.selectProgram(Math.min(Math.max(track.instrument.programIndex || 0, 0), bank.programs.length - 1))
      }
      const chunkFrames = 20 * sampleRate
      for (let completedFrames = 0; completedFrames < totalFrames; completedFrames += chunkFrames) {
        signal?.throwIfAborted()
        const endFrame = Math.min(totalFrames, completedFrames + chunkFrames)
        // Reconstruct held voices from their original onset, including release
        // tails. One second of warmup settles the master/track compressors.
        const warmStart = Math.max(0, completedFrames / sampleRate - 1 - Math.max(0, ...tracks.map(track => reverbSettings(track).mix ? reverbSettings(track).decay : 0)))
        const selected = notes.filter(item => item.start < endFrame / sampleRate && item.audibleEnd > warmStart)
        // Keep the Web Audio render quantum on the same grid as the full song.
        const renderStartFrame = Math.max(0, Math.floor(selected.reduce((start, item) => Math.min(start, item.start), warmStart) * sampleRate / 128) * 128)
        const renderStart = renderStartFrame / sampleRate
        onStatus?.(`渲染第 ${Math.floor(completedFrames / chunkFrames) + 1} / ${Math.ceil(totalFrames / chunkFrames)} 段`)
        let buffer: AudioBuffer | undefined = await this.renderSection(tracks, selected, clips, banks, renderStart, endFrame / sampleRate, sampleRate, signal, seconds => {
          onProgress?.(Math.max(completedFrames, Math.min(endFrame, (renderStart + seconds) * sampleRate)) / totalFrames)
        })
        signal?.throwIfAborted()
        onProgress?.(endFrame / totalFrames)
        yield { buffer, from: completedFrames - renderStartFrame, length: endFrame - completedFrames, completedFrames, totalFrames }
        buffer = undefined
      }
    } finally { for (const bank of banks.values()) bank.dispose() }
  }

  private async renderSection(
    tracks: Track[],
    notes: Array<{ track: Track; note: JiNote; midi: number; start: number; end: number }>,
    clips: Array<{ track: Track; clip: AudioClip; buffer: AudioBuffer; sourceOffset: number; start: number; end: number }>,
    banks: Map<string, ExactSF2Player>,
    renderStart: number, renderEnd: number, sampleRate: number, signal?: AbortSignal, onTime?: (seconds: number) => void
  ): Promise<AudioBuffer> {
    const context = new OfflineAudioContext(2, Math.round((renderEnd - renderStart) * sampleRate), sampleRate)
    const compressor = context.createDynamicsCompressor(), masterGain = context.createGain()
    compressor.threshold.value = -14; compressor.knee.value = 12; compressor.ratio.value = 8
    compressor.attack.value = .002; compressor.release.value = .16; masterGain.gain.value = .82
    compressor.connect(masterGain); masterGain.connect(context.destination)
    const buses = new Map<string, GainNode>(), fonts = new Map<string, ExactSF2Player>()
    const sources: AudioScheduledSourceNode[] = []
    const nodes: AudioNode[] = [compressor, masterGain]
    const connectSource = (source: AudioScheduledSourceNode, owned: AudioNode[]) => {
      sources.push(source); nodes.push(...owned)
      source.onended = () => { source.disconnect(); for (const node of owned) node.disconnect() }
    }
    try {
      for (const track of tracks) {
        signal?.throwIfAborted()
        if (!notes.some(item => item.track.id === track.id) && !clips.some(item => item.track.id === track.id && item.end > renderStart && item.start < renderEnd)) continue
        const bus = createTrackBus(context, compressor, track)
        const gain = bus.input
        buses.set(track.id, gain); nodes.push(...bus.nodes)
        const bank = banks.get(track.id)
        if (bank) {
          const player = await bank.cloneForContext(context)
          fonts.set(track.id, player)
          player.selectProgram(bank.program.index)
          const sf2Gain = context.createGain(), limiter = context.createDynamicsCompressor()
          sf2Gain.gain.value = .48; limiter.threshold.value = -10; limiter.knee.value = 4; limiter.ratio.value = 12
          limiter.attack.value = .0015; limiter.release.value = .12
          player.output.connect(sf2Gain); sf2Gain.connect(limiter); limiter.connect(gain); nodes.push(sf2Gain, limiter)
        }
      }
      let scheduled = 0
      for (const { track, note, midi, start: absoluteStart, end } of notes) {
        signal?.throwIfAborted()
        if (scheduled++ % 64 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
        const start = absoluteStart - renderStart, duration = end - absoluteStart, bus = buses.get(track.id)!
        const font = fonts.get(track.id)
        let drumGain: GainNode | undefined
        if (track.type === 'drum') {
          drumGain = context.createGain(); drumGain.gain.value = drumLevel(track, drumVoice(note.drumId).id)
          drumGain.connect(font ? font.output : bus); nodes.push(drumGain)
        }
        if (track.type === 'drum' && !font) {
          const hit = scheduleDrumHit(context, drumGain!, note.drumId, note.velocity, start, track.instrument.synthId)
          connectSource(hit.source, [hit.gain]); continue
        }
        if (font) { scheduleSf2(font, midi, sf2Velocity(note.velocity), start, start + duration, drumGain); continue }
        const id = track.instrument.kind === 'builtin' ? track.instrument.builtinId : undefined
        const buffers = id ? this.builtinBuffers.get(id) : undefined, definition = id ? BUILTIN_DEFINITIONS[id] : undefined
        if (buffers?.size && definition) {
          const sampleMidi = [...buffers.keys()].reduce((best, key) => Math.abs(key - midi) < Math.abs(best - midi) ? key : best)
          const source = context.createBufferSource(), envelope = context.createGain()
          source.buffer = buffers.get(sampleMidi)!; source.playbackRate.value = 2 ** ((midi - sampleMidi) / 12)
          const peak = Math.max(.0001, Math.min(note.velocity, 1.25))
          envelope.gain.setValueAtTime(peak, start); envelope.gain.setValueAtTime(peak, start + Math.max(.01, duration))
          envelope.gain.exponentialRampToValueAtTime(.0001, start + duration + definition.release)
          source.connect(envelope); envelope.connect(bus); source.start(start); source.stop(start + duration + definition.release + .05)
          connectSource(source, [envelope]); continue
        }
        const voice = scheduleSynthVoice(context, bus, note.frequency, note.velocity, start, duration, track.instrument.synthId)
        let remaining = voice.sources.length
        sources.push(...voice.sources); nodes.push(...voice.nodes)
        for (const source of voice.sources) source.onended = () => { source.disconnect(); if (--remaining === 0) for (const node of voice.nodes) node.disconnect() }
      }
      for (const { track, clip, buffer, sourceOffset, start, end } of clips) {
        if (end <= renderStart || start >= renderEnd) continue
        signal?.throwIfAborted()
        const source = context.createBufferSource(), gain = context.createGain()
        source.buffer = buffer; gain.gain.value = Math.max(0, Math.min(clip.gain ?? 1, 2))
        source.connect(gain); gain.connect(buses.get(track.id)!)
        const from = Math.max(start, renderStart), until = Math.min(end, renderEnd)
        source.start(from - renderStart, sourceOffset + from - start, until - from)
        connectSource(source, [gain])
      }
      // OfflineAudioContext has no close(). On cancellation disconnect its graph
      // immediately; reject the caller without waiting for the silent render.
      return await new Promise<AudioBuffer>((resolve, reject) => {
        const timer = setInterval(() => onTime?.(context.currentTime), 100)
        const abort = () => {
          clearInterval(timer)
          for (const node of nodes) node.disconnect()
          for (const font of fonts.values()) font.dispose()
          reject(new DOMException('已取消导出', 'AbortError'))
        }
        signal?.addEventListener('abort', abort, { once: true })
        context.startRendering().then(resolve, reject).finally(() => { clearInterval(timer); signal?.removeEventListener('abort', abort) })
      })
    } finally {
      for (const source of sources) { try { source.stop() } catch { /* already stopped */ } source.disconnect() }
      for (const player of fonts.values()) player.dispose()
      for (const node of nodes) node.disconnect()
    }
  }

  private scheduleWindow(project: JiProject, fromBeat: number, windowEndBeat: number, startAt: number, includeOverlaps: boolean): void {
    const beatSeconds = 60 / project.bpm
    const projectEndBeat = project.bars * this.beatsPerBar(project)
    const anySolo = project.tracks.some(track => track.solo)
    for (const track of project.tracks) {
      const silent = track.muted || (anySolo && !track.solo)
      if (silent) continue
      if ((track.type ?? 'instrument') === 'audio') {
        for (const clip of track.audioClips ?? []) this.audioClipOn(track, clip, fromBeat, windowEndBeat, projectEndBeat, startAt, beatSeconds, includeOverlaps)
      } else {
        for (const note of track.notes) {
          const playedStart = swungBeat(note.beat, project), playedEnd = playedStart + note.duration
          const startsInWindow = playedStart >= fromBeat - 1e-7 && playedStart < windowEndBeat - 1e-7
          const overlapsStart = includeOverlaps && playedStart < fromBeat - 1e-7 && playedEnd > fromBeat + 1e-7
          if ((!startsInWindow && !overlapsStart) || playedEnd <= fromBeat || playedStart >= projectEndBeat) continue
          const audibleStart = Math.max(playedStart, fromBeat), audibleEnd = Math.min(playedEnd, projectEndBeat)
          const relativeBeat = audibleStart - fromBeat
          const durationBeats = audibleEnd - audibleStart
          this.noteOn(track, note, startAt + relativeBeat * beatSeconds, durationBeats * beatSeconds)
        }
      }
    }
    if (project.metronome) {
      const first = Math.ceil(fromBeat - 1e-7)
      const beatsPerBar = this.beatsPerBar(project)
      for (let beat = first; beat < windowEndBeat - 1e-7; beat++) {
        this.click(startAt + (beat - fromBeat) * beatSeconds, beat % beatsPerBar === 0)
      }
    }
  }

  private scheduleAhead = (): void => {
    if (!this.playing || !this.project) return
    const project = this.project, context = this.getContext(), beatSeconds = 60 / project.bpm
    const projectEndBeat = project.bars * this.beatsPerBar(project), horizon = context.currentTime + 1
    let guard = 0
    while (this.nextScheduleTime < horizon - .001 && guard++ < 8) {
      if (this.nextScheduleBeat >= projectEndBeat - 1e-7) {
        if (!project.loop) break
        this.nextScheduleBeat = 0
        this.includeInitialOverlaps = false
      }
      const availableBeats = (horizon - this.nextScheduleTime) / beatSeconds
      if (availableBeats <= 1e-5) break
      const windowEndBeat = Math.min(projectEndBeat, this.nextScheduleBeat + availableBeats)
      this.scheduleWindow(project, this.nextScheduleBeat, windowEndBeat, this.nextScheduleTime, this.includeInitialOverlaps)
      this.nextScheduleTime += (windowEndBeat - this.nextScheduleBeat) * beatSeconds
      this.nextScheduleBeat = windowEndBeat
      this.includeInitialOverlaps = false
    }
    if (this.playing && (project.loop || this.nextScheduleBeat < projectEndBeat - 1e-7)) this.schedulerTimer = window.setTimeout(this.scheduleAhead, 80)
  }

  async play(project: JiProject, fromBeat: number, onPosition: (beat: number) => void, onEnded: () => void): Promise<void> {
    this.stop(false)
    await this.resume()
    await Promise.all(project.tracks.map(track => (track.type ?? 'instrument') === 'instrument' && track.instrument.kind === 'builtin' && track.instrument.builtinId
      ? this.ensureBuiltin(track.instrument.builtinId).catch(() => undefined)
      : Promise.resolve()))
    this.project = project
    this.syncTracks(project.tracks)
    this.onPosition = onPosition
    this.onEnded = onEnded
    this.playStartBeat = fromBeat
    this.contextStart = this.getContext().currentTime + 0.18
    this.nextScheduleBeat = fromBeat
    this.nextScheduleTime = this.contextStart
    this.includeInitialOverlaps = true
    this.playing = true
    this.scheduleAhead()
    this.updatePosition()
  }

  private updatePosition = (): void => {
    if (!this.playing || !this.project) return
    const project = this.project
    const elapsed = Math.max(0, this.getContext().currentTime - this.contextStart)
    const rawBeat = this.playStartBeat + elapsed * project.bpm / 60
    const endBeat = project.bars * this.beatsPerBar(project)
    if (!project.loop && rawBeat >= endBeat) {
      this.stop(false); this.onPosition?.(0); this.onEnded?.(); return
    }
    this.onPosition?.(project.loop ? rawBeat % endBeat : rawBeat)
    this.frame = requestAnimationFrame(this.updatePosition)
  }

  stop(releaseCallback = true): void {
    if (this.schedulerTimer !== null) { window.clearTimeout(this.schedulerTimer); this.schedulerTimer = null }
    cancelAnimationFrame(this.frame)
    for (const font of this.fonts.values()) font.player.allNotesOff()
    for (const source of this.activeSources) {
      try { source.stop() } catch { /* already stopped */ }
    }
    this.activeSources.clear()
    const wasPlaying = this.playing
    this.playing = false
    this.project = null
    if (releaseCallback && wasPlaying) this.onEnded?.()
  }

  async audition(track: Track, note: JiNote): Promise<void> {
    await this.resume()
    if ((track.type ?? 'instrument') === 'instrument' && track.instrument.kind === 'builtin' && track.instrument.builtinId) await this.ensureBuiltin(track.instrument.builtinId).catch(() => undefined)
    updateTrackBus(this.getContext(), this.busFor(track), track)
    this.noteOn(track, note, this.getContext().currentTime + 0.02, Math.min(note.duration * 60 / 120, 1.5))
  }
}
