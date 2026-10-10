import { createSF2Player, type SF2Player, type SF2Program } from '@gwegash/sf2-player'
import { scheduleSynthVoice } from './synth'
import { swungBeat } from './timing'
import type { JiNote, JiProject, Track } from './types'

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
  bytes: Uint8Array
  outputGain: GainNode
  limiter: DynamicsCompressorNode
}

interface ExactSF2Player extends SF2Player {
  noteOnExact: (key: number, pitch: number, velocity?: number, time?: number) => number
  noteOffVoice: (voiceId: number, time?: number) => void
}
function validateSf2(bytes: Uint8Array): void {
  if (bytes.byteLength < 12) throw new Error('SF2 文件不完整')
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (text(0) !== 'RIFF' || text(8) !== 'sfbk') throw new Error('文件不是有效的 SoundFont 2（RIFF/sfbk）')
}
function scheduleSf2(player: ExactSF2Player, midi: number, velocity: number, start: number, end: number): void {
  const key = Math.max(0, Math.min(127, Math.round(midi)))
  const voiceId = player.noteOnExact(key, midi, velocity, start); player.noteOffVoice(voiceId, end)
}

interface TrackBus {
  gain: GainNode
  panner: StereoPannerNode
}

export class AudioEngine {
  private context: AudioContext | null = null
  private compressor: DynamicsCompressorNode | null = null
  private masterGain: GainNode | null = null
  private buses = new Map<string, TrackBus>()
  private fonts = new Map<string, LoadedFont>()
  private builtinBuffers = new Map<string, Map<number, AudioBuffer>>()
  private builtinLoads = new Map<string, Promise<Map<number, AudioBuffer>>>()
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
      const gain = context.createGain()
      const panner = context.createStereoPanner()
      gain.connect(panner)
      panner.connect(this.compressor!)
      bus = { gain, panner }
      this.buses.set(track.id, bus)
    }
    bus.gain.gain.value = Math.max(0, Math.min(track.volume, 1.25))
    bus.panner.pan.value = Math.max(-1, Math.min(track.pan, 1))
    return bus
  }

  syncTracks(tracks: Track[]): void {
    for (const track of tracks) {
      this.busFor(track)
      if (track.instrument.kind === 'builtin' && track.instrument.builtinId) void this.ensureBuiltin(track.instrument.builtinId).catch(() => undefined)
    }
    const ids = new Set(tracks.map(track => track.id))
    for (const [id, bus] of this.buses) {
      if (!ids.has(id)) {
        bus.gain.disconnect(); bus.panner.disconnect(); this.buses.delete(id)
        const font = this.fonts.get(id)
        font?.player.dispose(); font?.outputGain.disconnect(); font?.limiter.disconnect(); this.fonts.delete(id)
      }
    }
  }

  async loadSf2(track: Track, bytes: Uint8Array, path?: string): Promise<readonly SF2Program[]> {
    await this.resume()
    validateSf2(bytes)
    const old = this.fonts.get(track.id)
    const fontBytes = bytes.slice()
    const context = this.getContext(), player = await createSF2Player(context, fontBytes) as ExactSF2Player
    const outputGain = context.createGain(), limiter = context.createDynamicsCompressor()
    outputGain.gain.value = .48; limiter.threshold.value = -10; limiter.knee.value = 4; limiter.ratio.value = 12; limiter.attack.value = .0015; limiter.release.value = .12
    player.output.connect(outputGain); outputGain.connect(limiter); limiter.connect(this.busFor(track).gain)
    const index = Math.min(Math.max(track.instrument.programIndex || 0, 0), player.programs.length - 1)
    player.selectProgram(index)
    if (old) { old.player.dispose(); old.outputGain.disconnect(); old.limiter.disconnect() }
    this.fonts.set(track.id, { player, path, programs: player.programs, bytes: fontBytes, outputGain, limiter })
    return player.programs
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
    const response = await fetch(new URL(`sound/${relativePath}`, document.baseURI))
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
    source.connect(envelope); envelope.connect(this.busFor(track).gain)
    source.start(at); source.stop(at + duration + definition.release + .05)
    this.activeSources.add(source)
    source.onended = () => { source.disconnect(); envelope.disconnect(); this.activeSources.delete(source) }
    return true
  }

  private noteOn(track: Track, note: JiNote, at: number, duration: number): void {
    if (note.muted || note.ghost || duration <= 0) return
    const context = this.getContext()
    const midi = 69 + 12 * Math.log2(note.frequency / 440)
    const font = this.fonts.get(track.id)
    if (track.instrument.kind === 'sf2' && font) {
      const velocity = Math.round(Math.max(1, Math.min(note.velocity, 1)) * 127)
      scheduleSf2(font.player, midi, velocity, at, at + duration)
      return
    }
    if (track.instrument.kind === 'builtin' && track.instrument.builtinId && this.sampledNoteOn(track, note, at, duration, track.instrument.builtinId)) return
    const voice = scheduleSynthVoice(context, this.busFor(track).gain, note.frequency, note.velocity, at, duration, track.instrument.synthId)
    let remaining = voice.sources.length
    for (const source of voice.sources) {
      this.activeSources.add(source)
      source.onended = () => { source.disconnect(); this.activeSources.delete(source); if (--remaining === 0) for (const node of voice.nodes) node.disconnect() }
    }
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

  async render(project: JiProject): Promise<AudioBuffer> {
    const endLimit = project.bars * this.beatsPerBar(project)
    const anySolo = project.tracks.some(track => track.solo)
    const tracks = project.tracks.filter(track => !track.muted && (!anySolo || track.solo))
    const playable = tracks.flatMap(track => track.notes
      .filter(note => !note.muted && !note.ghost && note.beat < endLimit && note.beat + note.duration > 0)
      .map(note => ({ track, note })))
    if (!playable.length) throw new Error('工程中没有可导出的音符')

    await Promise.all([...new Set(tracks
      .filter(track => track.instrument.kind === 'builtin' && track.instrument.builtinId)
      .map(track => track.instrument.builtinId!))].map(id => this.ensureBuiltin(id)))

    const beatSeconds = 60 / project.bpm
    const endBeat = Math.min(endLimit, Math.max(...playable.map(({ note }) => swungBeat(note.beat, project) + note.duration)))
    const tailSeconds = 4
    const durationSeconds = endBeat * beatSeconds + tailSeconds
    if (durationSeconds > 20 * 60) throw new Error('MP3 导出暂不支持超过 20 分钟的工程')
    const sampleRate = 44100
    const context = new OfflineAudioContext(2, Math.ceil(durationSeconds * sampleRate), sampleRate)
    const compressor = context.createDynamicsCompressor()
    const masterGain = context.createGain()
    compressor.threshold.value = -14; compressor.knee.value = 12; compressor.ratio.value = 8
    compressor.attack.value = .002; compressor.release.value = .16; masterGain.gain.value = .82
    compressor.connect(masterGain); masterGain.connect(context.destination)
    const buses = new Map<string, GainNode>()
    const offlineFonts = new Map<string, ExactSF2Player>()

    for (const track of tracks) {
      const gain = context.createGain(), panner = context.createStereoPanner()
      gain.gain.value = Math.max(0, Math.min(track.volume, 1.25)); panner.pan.value = Math.max(-1, Math.min(track.pan, 1))
      gain.connect(panner); panner.connect(compressor); buses.set(track.id, gain)
      const loaded = this.fonts.get(track.id)
      if (track.instrument.kind === 'sf2' && loaded?.bytes) {
        const player = await createSF2Player(context, loaded.bytes.slice()) as ExactSF2Player
        player.selectProgram(Math.min(Math.max(track.instrument.programIndex || 0, 0), player.programs.length - 1))
        const sf2Gain = context.createGain(), limiter = context.createDynamicsCompressor()
        sf2Gain.gain.value = .48; limiter.threshold.value = -10; limiter.knee.value = 4; limiter.ratio.value = 12; limiter.attack.value = .0015; limiter.release.value = .12
        player.output.connect(sf2Gain); sf2Gain.connect(limiter); limiter.connect(gain); offlineFonts.set(track.id, player)
      }
    }

    for (const { track, note } of playable) {
      const playedStart = Math.max(0, swungBeat(note.beat, project)), playedEnd = Math.min(endLimit, playedStart + note.duration)
      const start = playedStart * beatSeconds
      const duration = (playedEnd - playedStart) * beatSeconds
      if (duration <= 0) continue
      const bus = buses.get(track.id)!
      const midi = 69 + 12 * Math.log2(note.frequency / 440)
      const font = offlineFonts.get(track.id)
      if (font) {
        scheduleSf2(font, midi, Math.round(Math.max(1, Math.min(note.velocity, 1)) * 127), start, start + duration)
        continue
      }
      const id = track.instrument.kind === 'builtin' ? track.instrument.builtinId : undefined
      const buffers = id ? this.builtinBuffers.get(id) : undefined
      const definition = id ? BUILTIN_DEFINITIONS[id] : undefined
      if (buffers?.size && definition) {
        const sampleMidi = [...buffers.keys()].reduce((best, key) => Math.abs(key - midi) < Math.abs(best - midi) ? key : best)
        const source = context.createBufferSource(), envelope = context.createGain()
        source.buffer = buffers.get(sampleMidi)!
        source.playbackRate.value = 2 ** ((midi - sampleMidi) / 12)
        const peak = Math.max(.0001, Math.min(note.velocity, 1.25))
        envelope.gain.setValueAtTime(peak, start)
        envelope.gain.setValueAtTime(peak, start + Math.max(.01, duration))
        envelope.gain.exponentialRampToValueAtTime(.0001, start + duration + definition.release)
        source.connect(envelope); envelope.connect(bus); source.start(start)
        source.stop(Math.min(durationSeconds, start + duration + definition.release + .05))
        continue
      }
      scheduleSynthVoice(context, bus, note.frequency, note.velocity, start, duration, track.instrument.synthId)
    }

    const rendered = await context.startRendering()
    for (const player of offlineFonts.values()) player.dispose()
    return rendered
  }

  private scheduleWindow(project: JiProject, fromBeat: number, windowEndBeat: number, startAt: number, includeOverlaps: boolean): void {
    const beatSeconds = 60 / project.bpm
    const projectEndBeat = project.bars * this.beatsPerBar(project)
    const anySolo = project.tracks.some(track => track.solo)
    for (const track of project.tracks) {
      const silent = track.muted || (anySolo && !track.solo)
      this.busFor(track).gain.gain.setValueAtTime(silent ? 0 : track.volume, startAt)
      if (silent) continue
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
        this.nextScheduleBeat = 0; this.includeInitialOverlaps = false
      }
      const availableBeats = (horizon - this.nextScheduleTime) / beatSeconds
      if (availableBeats <= 1e-5) break
      const windowEndBeat = Math.min(projectEndBeat, this.nextScheduleBeat + availableBeats)
      this.scheduleWindow(project, this.nextScheduleBeat, windowEndBeat, this.nextScheduleTime, this.includeInitialOverlaps)
      this.nextScheduleTime += (windowEndBeat - this.nextScheduleBeat) * beatSeconds
      this.nextScheduleBeat = windowEndBeat; this.includeInitialOverlaps = false
    }
    if (this.playing && (project.loop || this.nextScheduleBeat < projectEndBeat - 1e-7)) this.schedulerTimer = window.setTimeout(this.scheduleAhead, 80)
  }

  async play(project: JiProject, fromBeat: number, onPosition: (beat: number) => void, onEnded: () => void): Promise<void> {
    this.stop(false)
    await this.resume()
    await Promise.all(project.tracks.map(track => track.instrument.kind === 'builtin' && track.instrument.builtinId
      ? this.ensureBuiltin(track.instrument.builtinId).catch(() => undefined)
      : Promise.resolve()))
    this.project = project
    this.onPosition = onPosition
    this.onEnded = onEnded
    this.playStartBeat = fromBeat
    this.contextStart = this.getContext().currentTime + 0.18
    this.nextScheduleBeat = fromBeat; this.nextScheduleTime = this.contextStart; this.includeInitialOverlaps = true
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
    if (track.instrument.kind === 'builtin' && track.instrument.builtinId) await this.ensureBuiltin(track.instrument.builtinId).catch(() => undefined)
    this.busFor(track).gain.gain.value = track.volume
    this.noteOn(track, note, this.getContext().currentTime + 0.02, Math.min(note.duration * 60 / 120, 1.5))
  }
}
