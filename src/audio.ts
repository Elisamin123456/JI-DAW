import { createSF2Player, type SF2Player, type SF2Program } from '@gwegash/sf2-player'
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
  player: SF2Player
  path?: string
  programs: readonly SF2Program[]
  bytes: Uint8Array
}

interface TrackBus {
  gain: GainNode
  panner: StereoPannerNode
}

export class AudioEngine {
  private context: AudioContext | null = null
  private compressor: DynamicsCompressorNode | null = null
  private buses = new Map<string, TrackBus>()
  private fonts = new Map<string, LoadedFont>()
  private builtinBuffers = new Map<string, Map<number, AudioBuffer>>()
  private builtinLoads = new Map<string, Promise<Map<number, AudioBuffer>>>()
  private activeSources = new Set<AudioScheduledSourceNode>()
  private cycleTimer: number | null = null
  private frame = 0
  private project: JiProject | null = null
  private contextStart = 0
  private playStartBeat = 0
  private onPosition: ((beat: number) => void) | null = null
  private onEnded: (() => void) | null = null
  playing = false

  private getContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      this.compressor = this.context.createDynamicsCompressor()
      this.compressor.threshold.value = -8
      this.compressor.knee.value = 10
      this.compressor.ratio.value = 6
      this.compressor.attack.value = 0.003
      this.compressor.release.value = 0.18
      this.compressor.connect(this.context.destination)
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
        this.fonts.get(id)?.player.dispose(); this.fonts.delete(id)
      }
    }
  }

  async loadSf2(track: Track, bytes: Uint8Array, path?: string): Promise<readonly SF2Program[]> {
    await this.resume()
    const old = this.fonts.get(track.id)
    if (old) old.player.dispose()
    const fontBytes = bytes.slice()
    const player = await createSF2Player(this.getContext(), fontBytes)
    player.output.connect(this.busFor(track).gain)
    const index = Math.min(Math.max(track.instrument.programIndex || 0, 0), player.programs.length - 1)
    player.selectProgram(index)
    this.fonts.set(track.id, { player, path, programs: player.programs, bytes: fontBytes })
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
      font.player.noteOn(midi, velocity, at)
      font.player.noteOff(midi, at + duration)
      return
    }
    if (track.instrument.kind === 'builtin' && track.instrument.builtinId && this.sampledNoteOn(track, note, at, duration, track.instrument.builtinId)) return
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = track.name.includes('低音') ? 'square' : 'triangle'
    oscillator.frequency.setValueAtTime(note.frequency, at)
    const peak = Math.max(0.0001, note.velocity * 0.25)
    envelope.gain.setValueAtTime(0.0001, at)
    envelope.gain.exponentialRampToValueAtTime(peak, at + 0.008)
    envelope.gain.setTargetAtTime(peak * 0.7, at + 0.03, 0.08)
    envelope.gain.setTargetAtTime(0.0001, Math.max(at + 0.05, at + duration - 0.05), 0.05)
    oscillator.connect(envelope)
    envelope.connect(this.busFor(track).gain)
    oscillator.start(at)
    oscillator.stop(at + duration + 0.28)
    this.activeSources.add(oscillator)
    oscillator.onended = () => {
      oscillator.disconnect(); envelope.disconnect(); this.activeSources.delete(oscillator)
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
    const endBeat = Math.min(endLimit, Math.max(...playable.map(({ note }) => note.beat + note.duration)))
    const tailSeconds = 4
    const durationSeconds = endBeat * beatSeconds + tailSeconds
    if (durationSeconds > 20 * 60) throw new Error('MP3 导出暂不支持超过 20 分钟的工程')
    const sampleRate = 44100
    const context = new OfflineAudioContext(2, Math.ceil(durationSeconds * sampleRate), sampleRate)
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = -8; compressor.knee.value = 10; compressor.ratio.value = 6
    compressor.attack.value = .003; compressor.release.value = .18; compressor.connect(context.destination)
    const buses = new Map<string, GainNode>()
    const offlineFonts = new Map<string, SF2Player>()

    for (const track of tracks) {
      const gain = context.createGain(), panner = context.createStereoPanner()
      gain.gain.value = Math.max(0, Math.min(track.volume, 1.25)); panner.pan.value = Math.max(-1, Math.min(track.pan, 1))
      gain.connect(panner); panner.connect(compressor); buses.set(track.id, gain)
      const loaded = this.fonts.get(track.id)
      if (track.instrument.kind === 'sf2' && loaded?.bytes) {
        const player = await createSF2Player(context, loaded.bytes.slice())
        player.selectProgram(Math.min(Math.max(track.instrument.programIndex || 0, 0), player.programs.length - 1))
        player.output.connect(gain); offlineFonts.set(track.id, player)
      }
    }

    for (const { track, note } of playable) {
      const start = Math.max(0, note.beat) * beatSeconds
      const duration = (Math.min(endLimit, note.beat + note.duration) - Math.max(0, note.beat)) * beatSeconds
      if (duration <= 0) continue
      const bus = buses.get(track.id)!
      const midi = 69 + 12 * Math.log2(note.frequency / 440)
      const font = offlineFonts.get(track.id)
      if (font) {
        font.noteOn(midi, Math.round(Math.max(1, Math.min(note.velocity, 1)) * 127), start)
        font.noteOff(midi, start + duration)
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
      const oscillator = context.createOscillator(), envelope = context.createGain()
      oscillator.type = track.name.includes('低音') ? 'square' : 'triangle'; oscillator.frequency.value = note.frequency
      const peak = Math.max(.0001, note.velocity * .25)
      envelope.gain.setValueAtTime(.0001, start); envelope.gain.exponentialRampToValueAtTime(peak, start + .008)
      envelope.gain.setTargetAtTime(peak * .7, start + .03, .08)
      envelope.gain.setTargetAtTime(.0001, Math.max(start + .05, start + duration - .05), .05)
      oscillator.connect(envelope); envelope.connect(bus); oscillator.start(start); oscillator.stop(start + duration + .28)
    }

    const rendered = await context.startRendering()
    for (const player of offlineFonts.values()) player.dispose()
    return rendered
  }

  private scheduleRange(project: JiProject, fromBeat: number, startAt: number): number {
    const beatSeconds = 60 / project.bpm
    const endBeat = project.bars * this.beatsPerBar(project)
    const anySolo = project.tracks.some(track => track.solo)
    for (const track of project.tracks) {
      const silent = track.muted || (anySolo && !track.solo)
      this.busFor(track).gain.gain.setValueAtTime(silent ? 0 : track.volume, startAt)
      if (silent) continue
      for (const note of track.notes) {
        const noteEnd = note.beat + note.duration
        if (noteEnd <= fromBeat || note.beat >= endBeat) continue
        const relativeBeat = Math.max(note.beat, fromBeat) - fromBeat
        const durationBeats = Math.min(noteEnd, endBeat) - Math.max(note.beat, fromBeat)
        this.noteOn(track, note, startAt + relativeBeat * beatSeconds, durationBeats * beatSeconds)
      }
    }
    if (project.metronome) {
      const first = Math.ceil(fromBeat)
      const beatsPerBar = this.beatsPerBar(project)
      for (let beat = first; beat < endBeat; beat++) {
        this.click(startAt + (beat - fromBeat) * beatSeconds, beat % beatsPerBar === 0)
      }
    }
    return (endBeat - fromBeat) * beatSeconds
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
    this.contextStart = this.getContext().currentTime + 0.06
    this.playing = true
    const firstDuration = this.scheduleRange(project, fromBeat, this.contextStart)
    this.armNextCycle(this.contextStart + firstDuration)
    this.updatePosition()
  }

  private armNextCycle(nextAt: number): void {
    if (!this.project) return
    const project = this.project
    const delay = Math.max(0, (nextAt - this.getContext().currentTime - 0.12) * 1000)
    this.cycleTimer = window.setTimeout(() => {
      if (!this.playing) return
      if (!project.loop) return
      const duration = this.scheduleRange(project, 0, nextAt)
      this.armNextCycle(nextAt + duration)
    }, delay)
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
    if (this.cycleTimer !== null) window.clearTimeout(this.cycleTimer)
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
