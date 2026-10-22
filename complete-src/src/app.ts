import { AudioEngine, BUILTIN_INSTRUMENTS } from './audio'
import { DRUM_KITS, DRUM_VOICES, drumKit, drumVoice, drumVoiceFromMidi } from './drums'
import { drumLevel, eqSettings, reverbSettings, levelText } from './mixer'
import { parseMidi } from './midi'
import { exportMidi } from './midi-export'
import { ExportLog, lastExportLog } from './export-log'
import { intervalConnectionStyle, parseRatio, primeLimit, ratioValue } from './ratio'
import { DEFAULT_SYNTH_ID, SYNTH_INSTRUMENTS, synthPreset } from './synth'
import { decodeTrackCode, encodeTrackCode, type TrackCodePayload } from './track-code'
import { edoGridPosition, edoHarmonizationActive, generateTwelveToneRatios, isLegacyPitchRatios, NATURAL_PITCH_CLASSES, nearestEdoGridFrequency, nearestTunedFrequency, PITCH_MODES, pitchClassSpelling, pitchNameForOffset, ratioEdoSteps, tunedFrequencyForMidiPitch, tuningPitches, tuningPitchName } from './tuning'
import type { AudioClip, JiAnnotation, JiNote, JiProject, RatioSpec, Track, TuningInterval, TuningSystem } from './types'

const $ = <T extends HTMLElement = HTMLInputElement>(selector: string): T => {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`缺少界面元素：${selector}`)
  return element
}
const clamp = (min: number, value: number, max: number) => Math.min(max, Math.max(min, value))
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)
const RICH_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'BR', 'DIV', 'P', 'UL', 'OL', 'LI', 'A', 'H1', 'H2', 'H3', 'SPAN', 'FONT'])
function sanitizeRichText(value: string): string {
  const template = document.createElement('template'); template.innerHTML = value.slice(0, 50000)
  const elements = [...template.content.querySelectorAll<HTMLElement>('*')].reverse()
  for (const element of elements) {
    if (!RICH_TAGS.has(element.tagName)) { element.replaceWith(...element.childNodes); continue }
    const href = element.tagName === 'A' ? element.getAttribute('href') || '' : ''
    const color = element.tagName === 'FONT' ? element.getAttribute('color') || '' : ''
    const size = element.tagName === 'FONT' ? element.getAttribute('size') || '' : ''
    const safeStyles: string[] = []
    for (const property of ['color', 'background-color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-align']) {
      const styleValue = element.style.getPropertyValue(property)
      if (styleValue && !/(url|expression)\s*\(/i.test(styleValue)) safeStyles.push(`${property}:${styleValue}`)
    }
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name)
    if (href && /^(https?:|mailto:)/i.test(href)) { element.setAttribute('href', href); element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noreferrer') }
    if (color && /^#[0-9a-f]{3,8}$/i.test(color)) element.setAttribute('color', color)
    if (size && /^[1-7]$/.test(size)) element.setAttribute('size', size)
    if (safeStyles.length) element.setAttribute('style', safeStyles.join(';'))
  }
  return template.innerHTML
}
const TRACK_COLORS = ['#f2b24d', '#69aef5', '#ab87ef', '#73d398', '#f27992', '#6fd2d9', '#d08bd5']
const MIN_NOTE_DURATION = 1 / 32
const SUPPORTED_SNAPS = [0, 1 / 32, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 2]
function sanitizeSnap(value: unknown): number {
  const candidate = Number(value)
  return SUPPORTED_SNAPS.find(option => Math.abs(option - candidate) < 1e-9) ?? 1
}
const INTERVAL_PRESETS: Record<number, Array<[string, string]>> = {
  3: [['9/8', '大全音'], ['4/3', '纯四度'], ['3/2', '纯五度']],
  5: [['10/9', '小全音'], ['6/5', '纯律小三度'], ['5/4', '纯律大三度'], ['8/5', '纯律小六度'], ['5/3', '纯律大六度'], ['9/5', '纯律小七度']],
  7: [['8/7', '七限全音'], ['7/6', '七限小三度'], ['9/7', '七限大三度'], ['7/5', '七限增四度'], ['10/7', '七限减五度'], ['7/4', '谐七度']],
  11: [['12/11', '十一限小二度'], ['11/10', '十一限中二度'], ['11/9', '十一限中三度'], ['14/11', '十一限大三度'], ['11/8', '十一谐音四度'], ['16/11', '十一限减五度'], ['11/7', '十一限小六度'], ['18/11', '十一限中六度'], ['20/11', '十一限中七度'], ['11/6', '十一限大七度']],
  13: [['14/13', '十三限小二度'], ['13/12', '十三限中二度'], ['13/11', '十三限小三度'], ['16/13', '十三限大三度'], ['13/10', '十三限四度'], ['18/13', '十三限增四度'], ['13/9', '十三限减五度'], ['20/13', '十三限五度'], ['13/8', '十三限小六度'], ['22/13', '十三限大六度'], ['24/13', '十三限中七度'], ['13/7', '十三限大七度']]
}
const PRIME_DEFAULT_RATIOS: Record<number, string> = { 2: '2/1', 3: '3/2', 5: '5/4', 7: '7/4', 11: '11/8', 13: '13/8' }
const DEFAULT_INTERVAL_RATIOS = new Set(Object.values(PRIME_DEFAULT_RATIOS))
const audio = new AudioEngine()
const DEFAULT_TUNING_KEY = 'ji-daw-default-tuning-v1'

interface TuningDefinition {
  version: 1
  name?: string
  tonic: number
  system: TuningSystem
  mode: string
  edo: number
  harmonizeRatiosToEdo: boolean
  intervals: TuningInterval[]
}

function tuningGcd(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left)), b = Math.abs(Math.trunc(right))
  while (b) [a, b] = [b, a % b]
  return a || 1
}

function sanitizeTuningIntervals(raw: unknown, system: TuningSystem, edo: number): TuningInterval[] {
  if (system === 'preset' || !Array.isArray(raw)) return []
  const result: TuningInterval[] = [], keys = new Set<string>()
  for (const value of raw.slice(0, 512)) {
    const source = value as TuningInterval
    if (system === 'ratio') {
      const rawNumerator = Number(source.numerator), rawDenominator = Number(source.denominator)
      if (!Number.isFinite(rawNumerator) || !Number.isFinite(rawDenominator) || rawNumerator <= 0 || rawDenominator <= 0) continue
      let numerator = clamp(1, Math.round(rawNumerator), 1_000_000_000)
      let denominator = clamp(1, Math.round(rawDenominator), 1_000_000_000)
      const divisor = tuningGcd(numerator, denominator); numerator /= divisor; denominator /= divisor
      const ratio = numerator / denominator, key = `${numerator}/${denominator}`
      if (ratio <= 1 || ratio >= 2 || keys.has(key)) continue
      keys.add(key); result.push({ numerator, denominator })
    } else {
      const steps = Math.round(Number(source.steps))
      const key = String(steps)
      if (!Number.isFinite(steps) || steps <= 0 || steps >= edo || keys.has(key)) continue
      keys.add(key); result.push({ steps })
    }
  }
  return result.sort((left, right) => system === 'ratio'
    ? (left.numerator! / left.denominator!) - (right.numerator! / right.denominator!)
    : left.steps! - right.steps!)
}

function normalizeTuningDefinition(raw: unknown): TuningDefinition {
  if (!raw || typeof raw !== 'object') throw new Error('调律表格式无效')
  const source = raw as Partial<TuningDefinition>
  if (source.version !== undefined && source.version !== 1) throw new Error('不支持的调律表版本')
  const system: TuningSystem = source.system === 'ratio' || source.system === 'edo' ? source.system : 'preset'
  const mode = typeof source.mode === 'string' && PITCH_MODES[source.mode] ? source.mode : 'chromatic'
  const edo = clamp(2, Math.round(Number(source.edo) || 12), 9999)
  if (system !== 'preset' && !Array.isArray(source.intervals)) throw new Error('自由调律缺少音程列表')
  const intervals = sanitizeTuningIntervals(source.intervals, system, edo)
  if (system !== 'preset' && intervals.length !== source.intervals!.length) throw new Error('调律表包含无效或重复音程')
  return {
    version: 1, name: typeof source.name === 'string' ? source.name.slice(0, 80) : undefined,
    tonic: clamp(0, Math.round(Number(source.tonic) || 0), 11), system, mode, edo,
    harmonizeRatiosToEdo: Boolean(source.harmonizeRatiosToEdo),
    intervals
  }
}

function loadDefaultTuning(): TuningDefinition | null {
  try { const stored = localStorage.getItem(DEFAULT_TUNING_KEY); return stored ? normalizeTuningDefinition(JSON.parse(stored)) : null } catch { return null }
}

function applyTuningDefinition(target: JiProject, definition: TuningDefinition): void {
  target.pitchTonic = definition.tonic
  target.tuningSystem = definition.system
  target.tuningEdo = definition.edo
  target.harmonizeRatiosToEdo = definition.harmonizeRatiosToEdo
  target.tuningIntervals = definition.intervals.map(interval => ({ ...interval }))
  target.pitchMode = definition.mode
  if (definition.system === 'preset') target.pitchRatios = generateTwelveToneRatios(definition.mode)
  recalculateProjectRatioNotes(target)
}

function recalculateRatioDescendants(target: JiProject, track: Track, parentId: string, visited = new Set<string>()): void {
  if (visited.has(parentId)) return
  visited.add(parentId)
  const parent = track.notes.find(note => note.id === parentId)
  if (!parent) return
  for (const child of track.notes) if (child.parentId === parentId) {
    if (child.ratio) child.frequency = parent.frequency * ratioValue(child.ratio)
    recalculateRatioDescendants(target, track, child.id, visited)
  }
}

function recalculateProjectRatioNotes(target: JiProject): void {
  for (const track of target.tracks) {
    if ((track.type ?? 'instrument') !== 'instrument') continue
    const noteIds = new Set(track.notes.map(note => note.id))
    const roots = track.notes.filter(note => !note.parentId || !note.ratio || !noteIds.has(note.parentId))
    for (const root of roots) recalculateRatioDescendants(target, track, root.id)
  }
}

function makeTrack(index: number, name = `轨道 ${index + 1}`): Track {
  return { id: uid('track'), type: 'instrument', name, color: TRACK_COLORS[index % TRACK_COLORS.length], volume: .8, pan: 0, muted: false, solo: false, height: 78, instrument: { kind: 'builtin', builtinId: 'salamander-piano', name: 'Salamander Grand Piano', programIndex: 0 }, notes: [], annotations: [], audioClips: [] }
}

function makeAudioTrack(index: number, fileName: string, path?: string): Track {
  const track = makeTrack(index, fileName.replace(/\.[^.]+$/, '') || `音频 ${index + 1}`)
  track.type = 'audio'
  track.instrument = { kind: 'synth', synthId: DEFAULT_SYNTH_ID, name: '音频', programIndex: 0 }
  track.audioClips = [{ id: uid('audio'), trackId: track.id, name: fileName, path, beat: snap(currentBeat), sourceDuration: 0, gain: 1 }]
  return track
}

function makeDrumTrack(index: number, name = 'FC 8-bit 808 鼓组'): Track {
  const track = makeTrack(index, name)
  track.type = 'drum'
  track.color = '#e58b72'
  track.instrument = { kind: 'synth', synthId: 'fc-noise-8', name: 'FC 8-bit 808 鼓组', programIndex: 0 }
  return track
}

function makeProject(demo = true): JiProject {
  const tracks = [makeTrack(0, '和声'), makeTrack(1, '低音'), makeTrack(2, '旋律')]
  if (demo) {
    const root = uid('note')
    tracks[0].notes = [
      { id: root, trackId: tracks[0].id, beat: 0, duration: 4, frequency: 261.626, velocity: .82 },
      { id: uid('note'), trackId: tracks[0].id, beat: 0, duration: 4, frequency: 327.0325, velocity: .72, parentId: root, ratio: { numerator: 5, denominator: 4, direction: 'up' } },
      { id: uid('note'), trackId: tracks[0].id, beat: 0, duration: 4, frequency: 392.439, velocity: .72, parentId: root, ratio: { numerator: 3, denominator: 2, direction: 'up' } }
    ]
    tracks[1].notes = [{ id: uid('note'), trackId: tracks[1].id, beat: 0, duration: 4, frequency: 130.813, velocity: .86 }]
    const melody = uid('note')
    tracks[2].notes = [
      { id: melody, trackId: tracks[2].id, beat: 4, duration: 2, frequency: 440, velocity: .78 },
      { id: uid('note'), trackId: tracks[2].id, beat: 6, duration: 2, frequency: 660, velocity: .78, parentId: melody, ratio: { numerator: 3, denominator: 2, direction: 'up' } }
    ]
  }
  const created: JiProject = { version: 2, name: '我的纯律工程', bpm: 120, signature: '4/4', snap: 1, bars: 16, loop: true, metronome: false, swingEnabled: false, swingAmount: 50, pitchRatios: generateTwelveToneRatios('chromatic'), pitchMode: 'chromatic', pitchTonic: 0, tuningSystem: 'preset', tuningEdo: 12, harmonizeRatiosToEdo: false, tuningIntervals: [], tracks }
  const defaultTuning = loadDefaultTuning(); if (defaultTuning) applyTuningDefinition(created, defaultTuning)
  return created
}

function sanitizeProject(raw: unknown): JiProject {
  if (!raw || typeof raw !== 'object') throw new Error('工程文件格式无效')
  const input = raw as Partial<JiProject>
  if (input.version !== 2 || !Array.isArray(input.tracks)) throw new Error('仅支持第 2 版工程')
  const pitchMode = typeof input.pitchMode === 'string' && PITCH_MODES[input.pitchMode] ? input.pitchMode : 'chromatic'
  const generatedRatios = generateTwelveToneRatios(pitchMode)
  let pitchRatios = Array.isArray(input.pitchRatios) && input.pitchRatios.length === 12
    ? input.pitchRatios.map((rawRatio, index) => {
      const n = Math.max(1, Math.round(Number(rawRatio?.[0]) || generatedRatios[index][0]))
      const d = Math.max(1, Math.round(Number(rawRatio?.[1]) || generatedRatios[index][1]))
      return [n, d] as [number, number]
    })
    : generatedRatios
  if (isLegacyPitchRatios(pitchRatios)) pitchRatios = generatedRatios
  const tuningSystem: TuningSystem = input.tuningSystem === 'ratio' || input.tuningSystem === 'edo' ? input.tuningSystem : 'preset'
  const tuningEdo = clamp(2, Math.round(Number(input.tuningEdo) || 12), 9999)
  const tuningIntervals = sanitizeTuningIntervals(input.tuningIntervals, tuningSystem, tuningEdo)
  const project: JiProject = {
    version: 2, name: typeof input.name === 'string' ? input.name.slice(0, 120) : '未命名工程',
    bpm: clamp(20, Number(input.bpm) || 120, 400), signature: ['4/4', '3/4', '5/4', '6/8', '7/8'].includes(input.signature ?? '') ? input.signature! : '4/4',
    snap: sanitizeSnap(input.snap),
    bars: clamp(4, Math.round(Number(input.bars) || 16), 256), loop: input.loop !== false, metronome: Boolean(input.metronome),
    swingEnabled: Boolean(input.swingEnabled), swingAmount: clamp(0, Number.isFinite(Number(input.swingAmount)) ? Number(input.swingAmount) : 50, 100),
    pitchRatios, pitchMode,
    pitchTonic: clamp(0, Math.round(Number(input.pitchTonic) || 0), 11), tuningSystem, tuningEdo,
    harmonizeRatiosToEdo: Boolean(input.harmonizeRatiosToEdo), tuningIntervals, tracks: []
  }
  project.tracks = input.tracks.slice(0, 64).map((rawTrack, index) => {
    const source = rawTrack as Track
    const builtinId = source.instrument?.builtinId || 'salamander-piano'
    const builtin = BUILTIN_INSTRUMENTS.find(item => item.id === builtinId) || BUILTIN_INSTRUMENTS[0]
    const track: Track = {
      id: typeof source.id === 'string' ? source.id : uid('track'), name: typeof source.name === 'string' ? source.name.slice(0, 80) : `轨道 ${index + 1}`,
      type: source.type === 'audio' ? 'audio' : source.type === 'drum' ? 'drum' : 'instrument',
      color: /^#[0-9a-f]{6}$/i.test(source.color ?? '') ? source.color : TRACK_COLORS[index % TRACK_COLORS.length],
      volume: clamp(0, Number(source.volume) || 0, 1.25), pan: clamp(-1, Number(source.pan) || 0, 1), muted: Boolean(source.muted), solo: Boolean(source.solo), height: clamp(56, Number(source.height) || 78, 280),
      eq: eqSettings(source), reverb: reverbSettings(source),
      drumVolumes: Object.fromEntries(DRUM_VOICES.map(voice => [voice.id, drumLevel(source, voice.id)])),
      instrument: source.type === 'drum' && source.instrument?.kind !== 'sf2'
        ? { kind: 'synth', synthId: drumKit(source.instrument?.synthId).id, name: drumKit(source.instrument?.synthId).name, programIndex: 0 }
        : source.instrument?.kind === 'sf2'
          ? { kind: 'sf2', name: String(source.instrument.name || 'SoundFont'), path: source.instrument.path, bundledId: source.instrument.bundledId === 'touhou' ? 'touhou' : undefined, programIndex: Math.max(0, Math.round(source.instrument.programIndex || 0)), programName: source.instrument.programName, missing: true }
          : source.instrument?.kind === 'synth'
            ? { kind: 'synth', synthId: synthPreset(source.instrument.synthId).id, name: synthPreset(source.instrument.synthId).name, programIndex: 0 }
            : { kind: 'builtin', builtinId: builtin.id, name: builtin.name, programIndex: 0 }, notes: [], annotations: [], audioClips: []
    }
    track.notes = Array.isArray(source.notes) ? source.notes.slice(0, 10000).map(rawNote => {
      const note = rawNote as JiNote
      let ratio: RatioSpec | undefined
      if (track.type !== 'drum' && note.ratio) ratio = parseRatio(note.ratio.numerator, note.ratio.denominator, note.ratio.direction === 'down' ? 'down' : 'up')
      const voice = track.type === 'drum' ? drumVoice(note.drumId) : null
      return {
        id: typeof note.id === 'string' ? note.id : uid('note'), trackId: track.id,
        beat: Math.max(0, Number(note.beat) || 0), duration: Math.max(MIN_NOTE_DURATION, Number(note.duration) || 1),
        frequency: voice ? 440 * 2 ** ((voice.midi - 69) / 12) : clamp(8, Number(note.frequency) || 440, 24000), velocity: clamp(0, Number.isFinite(Number(note.velocity)) ? Number(note.velocity) : .8, 1),
        muted: Boolean(note.muted), ghost: track.type === 'drum' ? false : Boolean(note.ghost), parentId: track.type === 'drum' ? undefined : typeof note.parentId === 'string' ? note.parentId : undefined, ratio: track.type === 'drum' ? undefined : ratio,
        color: /^#[0-9a-f]{6}$/i.test(note.color ?? '') ? note.color : undefined, drumId: voice?.id
      }
    }) : []
    track.annotations = Array.isArray(source.annotations) ? source.annotations.slice(0, 1000).map(rawAnnotation => {
      const annotation = rawAnnotation as JiAnnotation
      return {
        id: typeof annotation.id === 'string' ? annotation.id : uid('annotation'), trackId: track.id,
        beat: Math.max(0, Number(annotation.beat) || 0), frequency: clamp(8, Number(annotation.frequency) || 440, 24000),
        html: typeof annotation.html === 'string' ? sanitizeRichText(annotation.html) : ''
      }
    }).filter(annotation => annotation.html) : []
    track.audioClips = Array.isArray(source.audioClips) ? source.audioClips.slice(0, 256).map(rawClip => {
      const clip = rawClip as AudioClip
      return {
        id: typeof clip.id === 'string' ? clip.id : uid('audio'), trackId: track.id,
        name: typeof clip.name === 'string' ? clip.name.slice(0, 240) : '音频片段', path: typeof clip.path === 'string' ? clip.path : undefined,
        beat: Math.max(0, Number(clip.beat) || 0), sourceDuration: Math.max(0, Number(clip.sourceDuration) || 0),
        offsetSeconds: Math.max(0, Number(clip.offsetSeconds) || 0), gain: clamp(0, Number.isFinite(Number(clip.gain)) ? Number(clip.gain) : 1, 2), missing: true
      }
    }) : []
    if (track.type === 'audio') { track.notes = []; track.annotations = [] }
    return track
  })
  if (!project.tracks.length) project.tracks.push(makeTrack(0))
  recalculateProjectRatioNotes(project)
  return project
}

function loadAutosave(): JiProject | null {
  try { const value = localStorage.getItem('ji-daw-autosave-v2'); return value ? sanitizeProject(JSON.parse(value)) : null } catch { return null }
}

let project = loadAutosave() ?? makeProject()
let projectPath: string | undefined
let activeTrackId = project.tracks[0].id
let selectedNoteId: string | null = null
let selectedNoteIds = new Set<string>()
let activeTool: 'pen' | 'select' | 'text' = 'pen'
let controlHeld = false
let globalPianoMode = false
let selectionBox: { x1: number; y1: number; x2: number; y2: number } | null = null
let currentBeat = 0
let currentNoteDuration = 1
type PlaybackFollowMode = 'off' | 'locked' | 'page'
let playbackFollowMode: PlaybackFollowMode = 'off'
let editingAnnotationId: string | null = null
let annotationSelection: Range | null = null
let annotationOriginalHtml = ''
let annotationWasNew = false
let dirty = false
let toastTimer = 0
let clipboardNotes: JiNote[] | null = null
let clipboardTrackType: Track['type'] = 'instrument'
const history: string[] = []
const future: string[] = []
const view = { offsetX: 80, offsetY: 0, scale: 1 }
let renderedOffsetX = view.offsetX

const trackRows = $('#track-rows')
const overviewScroll = $('#overview-scroll')
const overviewContent = $('#overview-content')
const overviewRuler = $('#overview-ruler')
const overviewLanes = $('#overview-lanes')
const pianoCanvas = $('#piano-canvas')
const pianoSvg = $('#piano-svg') as unknown as SVGSVGElement
const pianoRuler = $('#piano-ruler')
const pianoRulerContent = $('#piano-ruler-content')

function beatsPerBar(): number { const [top, bottom] = project.signature.split('/').map(Number); return top * 4 / bottom }
function totalBeats(): number { return project.bars * beatsPerBar() }
function activeTrack(): Track { return project.tracks.find(track => track.id === activeTrackId) ?? project.tracks[0] }
function effectiveNoteFrequency(note: JiNote, track: Track, cache = new Map<string, number>(), visiting = new Set<string>()): number {
  if ((track.type ?? 'instrument') !== 'instrument' || !edoHarmonizationActive(project)) return note.frequency
  const cached = cache.get(note.id); if (cached !== undefined) return cached
  if (visiting.has(note.id)) return nearestEdoGridFrequency(note.frequency, project)
  visiting.add(note.id)
  const parent = note.parentId && note.ratio ? track.notes.find(item => item.id === note.parentId) : undefined
  const frequency = parent && note.ratio
    ? effectiveNoteFrequency(parent, track, cache, visiting) * 2 ** (ratioEdoSteps(note.ratio, project) / project.tuningEdo)
    : nearestEdoGridFrequency(note.frequency, project)
  visiting.delete(note.id); cache.set(note.id, frequency)
  return frequency
}
function projectWithEffectiveFrequencies(): JiProject {
  if (!edoHarmonizationActive(project)) return project
  return {
    ...project,
    tracks: project.tracks.map(track => {
      if ((track.type ?? 'instrument') !== 'instrument') return track
      const cache = new Map<string, number>()
      return { ...track, notes: track.notes.map(note => ({ ...note, frequency: effectiveNoteFrequency(note, track, cache) })) }
    })
  }
}
function auditionNote(track: Track, note: JiNote): Promise<void> {
  return audio.audition(track, { ...note, frequency: effectiveNoteFrequency(note, track) })
}
function pianoDisplayTrack(): Track {
  const track = activeTrack()
  if (!globalPianoMode) return track
  const instrumentTracks = project.tracks.filter(item => (item.type ?? 'instrument') === 'instrument')
  return {
    ...track, id: '__global-piano__', type: 'instrument', name: '全局钢琴窗', color: '#ffffff', audioClips: [],
    notes: instrumentTracks.flatMap(owner => owner.notes.map(note => ({ ...note, color: note.color || owner.color }))),
    annotations: project.tracks.flatMap(owner => owner.annotations)
  }
}
function findNote(id: string | null): { note: JiNote; track: Track } | null {
  if (!id) return null
  for (const track of project.tracks) { const note = track.notes.find(item => item.id === id); if (note) return { note, track } }
  return null
}
function findAnnotation(id: string | null): { annotation: JiAnnotation; track: Track } | null {
  if (!id) return null
  for (const track of project.tracks) { const annotation = track.annotations.find(item => item.id === id); if (annotation) return { annotation, track } }
  return null
}
function hzToY(hz: number): number { return (Math.log2(20000) - Math.log2(hz)) * 100 }
function yToHz(y: number): number { return 20000 / 2 ** (y / 100) }
const LETTER_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
interface SpelledPitch { letter: number; accidental: number; octave: number }
function rootSpelling(hz: number): SpelledPitch {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440))
  const pitchClass = ((midi % 12) + 12) % 12
  const relative = ((pitchClass - project.pitchTonic) % 12 + 12) % 12
  const { letter, accidental } = pitchClassSpelling(project.pitchTonic, relative, project.tuningSystem === 'preset' ? project.pitchMode : 'chromatic')
  const octave = Math.round((midi - NATURAL_PITCH_CLASSES[letter] - accidental) / 12) - 1
  return { letter, accidental, octave }
}
function intervalDiatonicSteps(ratio: RatioSpec): number {
  const key = `${ratio.numerator}/${ratio.denominator}`
  if (key === '1/1') return 0
  if (key === '2/1') return 7
  const presetName = Object.values(INTERVAL_PRESETS).flat().find(([preset]) => preset === key)?.[1] || ''
  const namedStep = [['二度', 1], ['三度', 2], ['四度', 3], ['五度', 4], ['六度', 5], ['七度', 6]] as const
  const found = namedStep.find(([name]) => presetName.includes(name))
  if (found) return found[1]
  const cents = Math.abs(1200 * Math.log2(ratioValue(ratio)))
  const octaves = Math.floor((cents + .001) / 1200), remainder = cents - octaves * 1200
  const semitone = clamp(0, Math.round(remainder / 100), 12)
  const approximate = [0, 1, 1, 2, 2, 3, remainder < 600 ? 3 : 4, 4, 5, 5, 6, 6, 7][semitone]
  return octaves * 7 + approximate
}
function spelledNote(note: JiNote, track: Track, cache = new Map<string, SpelledPitch>(), visiting = new Set<string>()): SpelledPitch {
  const cached = cache.get(note.id); if (cached) return cached
  if (!note.parentId || !note.ratio || visiting.has(note.id)) { const root = rootSpelling(effectiveNoteFrequency(note, track)); cache.set(note.id, root); return root }
  const parent = track.notes.find(item => item.id === note.parentId)
  if (!parent) { const root = rootSpelling(effectiveNoteFrequency(note, track)); cache.set(note.id, root); return root }
  visiting.add(note.id)
  const parentPitch = spelledNote(parent, track, cache, visiting)
  const direction = note.ratio.direction === 'down' ? -1 : 1
  const absoluteLetter = parentPitch.octave * 7 + parentPitch.letter + direction * intervalDiatonicSteps(note.ratio)
  const letter = ((absoluteLetter % 7) + 7) % 7, octave = Math.floor(absoluteLetter / 7)
  const midi = Math.round(69 + 12 * Math.log2(effectiveNoteFrequency(note, track) / 440)), pitchClass = ((midi % 12) + 12) % 12
  let accidental = pitchClass - NATURAL_PITCH_CLASSES[letter]
  while (accidental > 6) accidental -= 12
  while (accidental < -6) accidental += 12
  const result = { letter, accidental, octave }; cache.set(note.id, result); visiting.delete(note.id); return result
}
function noteName(note: JiNote, track: Track, cache?: Map<string, SpelledPitch>): string {
  const pitch = spelledNote(note, track, cache)
  const accidental = pitch.accidental > 0 ? '♯'.repeat(pitch.accidental) : pitch.accidental < 0 ? '♭'.repeat(-pitch.accidental) : ''
  return `${LETTER_NAMES[pitch.letter]}${accidental}${pitch.octave}`
}
function spellingText(pitch: SpelledPitch): string {
  const accidental = pitch.accidental > 0 ? '♯'.repeat(pitch.accidental) : pitch.accidental < 0 ? '♭'.repeat(-pitch.accidental) : ''
  return `${LETTER_NAMES[pitch.letter]}${accidental}${pitch.octave}`
}
function renderEdoPosition(selector: string, note: JiNote, frequency: number): void {
  const element = $(selector)
  element.classList.toggle('hidden', !edoHarmonizationActive(project))
  if (!edoHarmonizationActive(project)) { element.textContent = ''; return }
  const position = edoGridPosition(frequency, project)
  const lowerTonic = spellingText(rootSpelling(position.lowerTonicFrequency))
  element.innerHTML = `<strong>${position.edo}-EDO</strong><span>距下方主音 ${lowerTonic}：第 ${position.step} 步</span><small>原始 ${note.frequency.toFixed(3)} Hz</small>`
}
function ratioText(note: JiNote): string { return note.ratio ? `${note.ratio.direction === 'down' ? '↓' : ''}${note.ratio.numerator}/${note.ratio.denominator}` : '' }
function snap(value: number): number { return project.snap ? Math.round(value / project.snap) * project.snap : value }
function snapFrequency(value: number): number {
  return nearestTunedFrequency(value, project)
}
function selectOnly(id: string | null): void {
  selectedNoteId = id
  selectedNoteIds = id ? new Set([id]) : new Set()
}
function effectiveTool(): 'pen' | 'select' | 'text' {
  if (globalPianoMode) return 'text'
  if (activeTrack().type === 'drum' && activeTool === 'text') return controlHeld ? 'select' : 'pen'
  return controlHeld ? 'select' : activeTool
}
function updateToolUi(clearSelectionOnExit = false): void {
  const tool = effectiveTool()
  if (clearSelectionOnExit && pianoCanvas.dataset.tool === 'select' && tool !== 'select') {
    selectOnly(null); selectionBox = null; renderPiano()
  }
  $('#tool-pen').classList.toggle('active', tool === 'pen')
  $('#tool-select').classList.toggle('active', tool === 'select')
  $('#tool-text').classList.toggle('active', tool === 'text')
  pianoCanvas.dataset.tool = tool
}
function serialize(): string { return JSON.stringify(project, null, 2) }

function download(bytes: Uint8Array, fileName: string, type: string): void {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes)
  downloadBlob(new Blob([copy.buffer], { type }), fileName)
}
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
async function exportMidiFile(): Promise<void> {
  try {
    const name = project.name || '未命名工程', bytes = exportMidi(projectWithEffectiveFrequencies())
    if (window.desktop) { const result = await window.desktop.saveMidi({ name, bytes }); if (!result) return }
    else download(bytes, `${name}.mid`, 'audio/midi')
    toast('MIDI 已导出')
  }
  catch (error) { toast(`MIDI 导出失败：${error instanceof Error ? error.message : '未知错误'}`, true) }
}

async function exportMp3File(): Promise<void> {
  const button = $('#export-mp3') as HTMLButtonElement
  if (button.disabled) return
  const label = button.textContent || '导出 MP3'
  button.disabled = true
  const controller = new AbortController(), { signal } = controller
  document.querySelector('.mp3-export-status')?.remove()
  const log = new ExportLog(project, projectPath)
  const status = document.createElement('dialog')
  status.className = 'mp3-export-status glass'
  status.setAttribute('aria-label', 'MP3 导出进度与日志')
  status.innerHTML = '<header><strong>导出 MP3</strong><span class="export-elapsed">0 秒</span></header><p role="status" aria-live="polite">准备导出…</p><progress max="1" aria-label="MP3 导出进度"></progress><small class="export-detail">正在检查工程</small><pre class="export-error" hidden></pre><small class="export-log-path"></small><footer><button type="button" data-action="cancel">取消</button><button type="button" data-action="save-log">保存日志</button><button type="button" data-action="relink" hidden>重新定位 SF2</button><button type="button" data-action="close" hidden>关闭</button></footer>'
  const message = status.querySelector('p')!, progress = status.querySelector('progress')!, cancel = status.querySelector<HTMLButtonElement>('[data-action="cancel"]')!
  const detail = status.querySelector<HTMLElement>('.export-detail')!, errors = status.querySelector<HTMLElement>('.export-error')!
  const close = status.querySelector<HTMLButtonElement>('[data-action="close"]')!, relink = status.querySelector<HTMLButtonElement>('[data-action="relink"]')!
  let phase = '准备导出', rendered = 0, encoded = 0, loggedPercent = -1, failed = false
  const started = performance.now()
  const setPhase = (value: string) => { if (!signal.aborted) { phase = value; log.record(value); update() } }
  const update = () => {
    if (signal.aborted) return
    const fraction = Math.min(.99, rendered * .45 + encoded * .5)
    progress.value = fraction
    message.textContent = `${phase} · ${Math.floor(fraction * 100)}%`
    detail.textContent = `音频渲染 ${Math.floor(rendered * 100)}% · MP3 编码 ${Math.floor(encoded * 100)}%`
    const percent = Math.floor(fraction * 10) * 10
    if (percent > loggedPercent) { loggedPercent = percent; log.record('导出进度', { percent, rendered, encoded }) }
  }
  const timer = window.setInterval(() => { status.querySelector('.export-elapsed')!.textContent = `${Math.floor((performance.now() - started) / 1000)} 秒` }, 1000)
  cancel.addEventListener('click', () => { cancel.disabled = true; message.textContent = '正在取消…'; controller.abort() })
  status.addEventListener('cancel', event => { event.preventDefault(); if (!cancel.hidden) cancel.click(); else status.remove() })
  close.addEventListener('click', () => status.remove())
  status.querySelector('[data-action="save-log"]')!.addEventListener('click', () => { void saveExportLog(log.text()) })
  relink.addEventListener('click', async () => {
    relink.disabled = true
    try {
      const missing = project.tracks.find(track => track.instrument.kind === 'sf2' && !audio.hasFont(track.id))
      if (missing) await chooseSf2(missing)
      const remaining = project.tracks.filter(track => track.instrument.kind === 'sf2' && !audio.hasFont(track.id))
      detail.textContent = remaining.length ? `仍有 ${remaining.length} 条轨道需要定位音源` : '音源已恢复，关闭此窗口后可重新导出；保存工程可保留新路径。'
      relink.hidden = !remaining.length
      log.record('重新定位音源', { remaining: remaining.map(track => track.name) })
    } finally { relink.disabled = false }
  })
  document.body.append(status)
  status.showModal()
  log.record('开始导出')
  try {
    // Let the progress window paint before project validation or SF2 parsing.
    await new Promise<void>(resolve => setTimeout(resolve, 30))
    signal.throwIfAborted()
    setPhase('恢复工程音源')
    await restoreFonts(log)
    signal.throwIfAborted()
    const snapshot = structuredClone(projectWithEffectiveFrequencies()), name = snapshot.name || '未命名工程'
    audio.stop(); setPlayState(false); button.textContent = '导出中…'
    const { encodeMp3 } = await import('./mp3-export')
    const chunks = audio.renderChunks(snapshot, { signal, onStatus: setPhase, onProgress: fraction => { rendered = fraction; update() } })
    const blob = await encodeMp3(chunks, { signal, onProgress: fraction => {
      encoded = fraction; phase = fraction < 1 ? '正在编码 MP3' : '正在完成 MP3 编码'; update()
    } })
    signal.throwIfAborted()
    cancel.disabled = true; setPhase('选择位置并保存 MP3')
    if (window.desktop) { const bytes = new Uint8Array(await blob.arrayBuffer()); const result = await window.desktop.saveAudio({ name, bytes }); if (!result) { log.record('用户取消保存'); return }; log.record('MP3 已保存', { path: result.path, bytes: blob.size }) }
    else downloadBlob(blob, `${name}.mp3`)
    log.record('导出成功', { bytes: blob.size })
    toast('MP3 已导出')
  } catch (error) {
    log.error(signal.aborted ? '用户取消导出' : `导出失败：${phase}`, error)
    if (signal.aborted) toast('已取消 MP3 导出')
    else {
      failed = true
      message.textContent = 'MP3 导出失败'
      errors.hidden = false; errors.textContent = `${error instanceof Error ? error.message : String(error)}\n\n失败阶段：${phase}`
      detail.textContent = '详情已保留。可保存日志，修复后重新导出。'
      cancel.hidden = true; close.hidden = false
      relink.hidden = !project.tracks.some(track => track.instrument.kind === 'sf2' && !audio.hasFont(track.id))
      toast(`MP3 导出失败：${error instanceof Error ? error.message : '未知错误'}`, true)
    }
  } finally {
    clearInterval(timer); button.disabled = false; button.textContent = label
    await log.flush()
    if (failed) status.querySelector('.export-log-path')!.textContent = log.path ? `自动日志：${log.path}` : '日志已保留在本机；也可点击“保存日志”导出。'
    else status.remove()
  }
}

async function saveExportLog(text = lastExportLog()): Promise<void> {
  if (!text) { toast('暂无 MP3 导出日志'); return }
  try {
    const name = `${project.name || '未命名工程'}-MP3-export`
    if (window.desktop?.saveDiagnosticLog) { if (!await window.desktop.saveDiagnosticLog({ name, text })) return }
    else downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${name}.log`)
    toast('导出日志已保存')
  } catch (error) { toast(`日志保存失败：${error instanceof Error ? error.message : String(error)}`, true) }
}

function checkpoint(): void {
  const now = JSON.stringify(project)
  if (history.at(-1) !== now) history.push(now)
  if (history.length > 100) history.shift()
  future.length = 0
}
function commit(message?: string): void {
  dirty = true; localStorage.setItem('ji-daw-autosave-v2', JSON.stringify(project)); document.title = `● ${project.name} — 纯律和音图 DAW`
  if (message) toast(message)
}
function undo(): void {
  const previous = history.pop(); if (!previous) return toast('没有可撤销的操作')
  future.push(JSON.stringify(project)); project = sanitizeProject(JSON.parse(previous)); selectOnly(null)
  if (!project.tracks.some(track => track.id === activeTrackId)) activeTrackId = project.tracks[0].id
  audio.stop(); renderAll(); void restoreAudioClips(); void restoreFonts(); commit('已撤销')
}
function redo(): void {
  const next = future.pop(); if (!next) return toast('没有可重做的操作')
  history.push(JSON.stringify(project)); project = sanitizeProject(JSON.parse(next)); selectOnly(null)
  if (!project.tracks.some(track => track.id === activeTrackId)) activeTrackId = project.tracks[0].id
  audio.stop(); renderAll(); void restoreAudioClips(); void restoreFonts(); commit('已重做')
}

function renderAll(): void {
  renderOverview(); renderPiano(); renderSettings(); renderGlobalSettings(); renderMixer(); audio.syncTracks(project.tracks)
  $('#project-name').value = project.name; $('#bpm-input').value = String(project.bpm); $('#signature-select').value = project.signature; $('#snap-select').value = String(project.snap)
  document.querySelectorAll('.toggle').forEach(button => button.classList.toggle('active', project.loop))
  updatePosition(currentBeat)
}

function mixerValue(key: string, value: number): string {
  if (key === 'volume' || key.startsWith('drum:')) return levelText(value)
  if (key === 'pan') return value === 0 ? '居中' : `${value < 0 ? '左' : '右'} ${Math.round(Math.abs(value) * 100)}%`
  if (key === 'mix') return `${Math.round(value * 100)}%`
  if (key === 'decay') return `${value.toFixed(1)} s`
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
}
function renderMixer(): void {
  const dialog = $('#mixer-dialog') as HTMLDialogElement
  if (!dialog.open) return
  dialog.style.width = `min(${Math.max(390, Math.min(1200, project.tracks.length * 250 + 40))}px,calc(100vw - 40px))`
  $('#mixer-channels').style.justifyContent = project.tracks.length === 1 ? 'center' : 'flex-start'
  const control = (key: string, label: string, value: number, min: number, max: number, step: number) => `<label class="mixer-control"><span>${label}</span><output>${mixerValue(key, value)}</output><input type="range" data-mix="${key}" aria-label="${label}" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`
  $('#mixer-channels').innerHTML = project.tracks.map((track, index) => {
    const eq = eqSettings(track), reverb = reverbSettings(track)
    return `<section class="mixer-channel" data-track-id="${track.id}" style="--track-color:${track.color}"><header><small>${String(index + 1).padStart(2, '0')}</small><strong>${escapeHtml(track.name)}</strong></header><small class="mixer-source">${escapeHtml(track.instrument.name)}</small><div class="mixer-switches"><button data-mix-action="muted" class="${track.muted ? 'active' : ''}">静音 M</button><button data-mix-action="solo" class="${track.solo ? 'active' : ''}">独奏 S</button><button data-mix-action="reset">复位</button></div>${control('volume', '轨道音量', track.volume, 0, 1.25, .01)}${control('pan', '声像', track.pan, -1, 1, .01)}<h4>均衡器 EQ</h4>${control('low', '低频 · 160 Hz', eq.low, -18, 18, .5)}${control('mid', '中频 · 1 kHz', eq.mid, -18, 18, .5)}${control('high', '高频 · 6 kHz', eq.high, -18, 18, .5)}<h4>房间混响</h4>${control('mix', '混响量', reverb.mix, 0, .6, .01)}${control('decay', '衰减时间', reverb.decay, .2, 4, .1)}${track.type === 'drum' ? `<details><summary>单鼓音量</summary>${DRUM_VOICES.map(voice => control(`drum:${voice.id}`, voice.name, drumLevel(track, voice.id), 0, 2, .01)).join('')}</details>` : ''}</section>`
  }).join('')
}
function openMixer(): void {
  closePopups(false)
  const dialog = $('#mixer-dialog') as HTMLDialogElement
  if (!dialog.open) dialog.showModal()
  renderMixer()
}
$('#open-mixer').addEventListener('click', openMixer)
$('#piano-mixer').addEventListener('click', openMixer)
$('#close-mixer').addEventListener('click', () => ($('#mixer-dialog') as HTMLDialogElement).close())
$('#mixer-channels').addEventListener('pointerdown', event => { if ((event.target as HTMLElement).matches('input')) checkpoint() })
$('#mixer-channels').addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) checkpoint() })
$('#mixer-channels').addEventListener('input', event => {
  const input = event.target as HTMLInputElement, key = input.dataset.mix
  const track = project.tracks.find(item => item.id === input.closest<HTMLElement>('[data-track-id]')?.dataset.trackId)
  if (!track || !key) return
  const value = Number(input.value)
  if (key === 'volume' || key === 'pan') track[key] = value
  else if (key === 'mix' || key === 'decay') track.reverb = { ...reverbSettings(track), [key]: value }
  else if (key.startsWith('drum:')) track.drumVolumes = { ...track.drumVolumes, [key.slice(5)]: value }
  else track.eq = { ...eqSettings(track), [key]: value }
  input.closest('label')!.querySelector('output')!.textContent = mixerValue(key, value)
  audio.syncTracks(project.tracks); commit()
})
$('#mixer-channels').addEventListener('change', () => { renderOverview(); renderPiano() })
$('#mixer-channels').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-mix-action]')
  const track = project.tracks.find(item => item.id === button?.closest<HTMLElement>('[data-track-id]')?.dataset.trackId)
  if (!button || !track) return
  checkpoint()
  const key = button.dataset.mixAction
  if (key === 'muted' || key === 'solo') track[key] = !track[key]
  else { track.volume = .8; track.pan = 0; track.eq = { low: 0, mid: 0, high: 0 }; track.reverb = { mix: 0, decay: 1.6 }; track.drumVolumes = {} }
  renderAll(); commit()
})
$('#drum-note-voice').innerHTML = DRUM_VOICES.map(voice => `<option value="${voice.id}">${voice.name}</option>`).join('')
$('#drum-note-voice').addEventListener('change', () => {
  const found = findNote(selectedNoteId); if (!found || found.track.type !== 'drum') return
  const voice = drumVoice($('#drum-note-voice').value)
  checkpoint(); found.note.drumId = voice.id; found.note.frequency = 440 * 2 ** ((voice.midi - 69) / 12)
  $('#root-note-name').textContent = voice.name; renderPiano(); commit(); void auditionNote(found.track, found.note)
})
pianoCanvas.addEventListener('pointerdown', event => { if ((event.target as HTMLElement).matches('[data-drum-volume]')) checkpoint() })
pianoCanvas.addEventListener('keydown', event => { if ((event.target as HTMLElement).matches('[data-drum-volume]')) checkpoint() })
pianoCanvas.addEventListener('input', event => {
  const input = event.target as HTMLInputElement, id = input.dataset.drumVolume
  if (!id) return
  const track = activeTrack(); track.drumVolumes = { ...track.drumVolumes, [id]: Number(input.value) }
  input.title = `${drumVoice(id).name} ${levelText(Number(input.value))}`
  audio.syncTracks(project.tracks); commit()
})

function instrumentOptions(track: Track): string {
  const value = track.instrument.kind === 'builtin' ? track.instrument.builtinId : track.instrument.kind === 'sf2' ? `sf2-program:${track.instrument.programIndex}` : `synth:${synthPreset(track.instrument.synthId).id}`
  const options: string[] = []
  if (track.type === 'drum') DRUM_KITS.forEach(kit => options.push(`<option value="${kit.id}" ${track.instrument.kind === 'synth' && track.instrument.synthId === kit.id ? 'selected' : ''}>${escapeHtml(kit.name)}</option>`))
  else {
    options.push(...BUILTIN_INSTRUMENTS.map(item => `<option value="${item.id}" ${value === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`))
    options.push('<optgroup label="经典合成器">')
    SYNTH_INSTRUMENTS.forEach(item => options.push(`<option value="synth:${item.id}" title="${escapeHtml(item.description)}" ${value === `synth:${item.id}` ? 'selected' : ''}>${escapeHtml(item.name)}</option>`))
    options.push('</optgroup>')
  }
  options.push('<option value="bundled:touhou">预制 · Touhou.sf2</option>')
  if (track.instrument.kind === 'sf2') {
    const programs = audio.getPrograms(track.id)
    if (programs.length) programs.forEach((program, index) => options.push(`<option value="sf2-program:${index}" ${index === track.instrument.programIndex ? 'selected' : ''}>${program.bank === 128 ? '鼓组' : 'SF2'} · ${escapeHtml(program.name || `音色 ${index + 1}`)} [${program.bank}:${program.program}]</option>`))
    else options.push(`<option value="sf2-program:${track.instrument.programIndex}" selected>${track.instrument.missing ? '⚠ ' : ''}SF2 · ${escapeHtml(track.instrument.programName || track.instrument.name)}</option>`)
  }
  options.push('<option value="sf2-import">导入 SF2…</option>')
  return options.join('')
}

function renderOverview(): void {
  const beatWidth = 44
  const width = Math.max(overviewScroll.clientWidth, totalBeats() * beatWidth)
  overviewContent.style.width = `${width}px`; overviewContent.style.setProperty('--beat-px', `${beatWidth}px`)
  $('#track-count').textContent = String(project.tracks.length)
  overviewRuler.innerHTML = Array.from({ length: project.bars }, (_, bar) => `<span class="bar-label" style="left:${bar * beatsPerBar() * beatWidth}px">${String(bar + 1).padStart(2, '0')}</span>`).join('')
  trackRows.innerHTML = project.tracks.map((track, index) => {
    const isAudio = track.type === 'audio'
    const isDrum = track.type === 'drum'
    const sourceControl = isAudio
      ? `<span class="audio-track-source" title="${escapeHtml(track.audioClips[0]?.path || track.audioClips[0]?.name || '音频轨')}">${track.audioClips.some(clip => clip.missing) ? '⚠ ' : ''}${escapeHtml(track.audioClips[0]?.name || '音频轨')}</span>`
      : `<select class="track-instrument" data-action="instrument" title="选择或导入轨道音源">${instrumentOptions(track)}</select>`
    return `<div class="track-row ${track.id === activeTrackId ? 'active' : ''}" data-track-id="${track.id}" style="--track-color:${track.color};--track-height:${track.height}px">
    <span class="track-color"></span><div class="track-row-body">
      <div class="track-row-main"><span class="track-index">${String(index + 1).padStart(2, '0')}</span>${isAudio ? '<span class="track-kind">AUDIO</span>' : isDrum ? '<span class="track-kind">DRUM</span>' : ''}<input class="track-name-input" data-action="name" value="${escapeHtml(track.name)}">${isAudio ? '' : '<button class="track-export" data-action="export" title="导出轨道码">↗</button>'}<button class="track-export" data-action="mixer" title="混音台">≋</button><button class="remove-track" data-action="remove" title="删除轨道">×</button></div>
      <div class="track-row-controls"><button class="mute-small ${track.muted ? 'active' : ''}" data-action="mute">M</button><button class="solo-small ${track.solo ? 'active' : ''}" data-action="solo">S</button><input class="track-volume" data-action="volume" title="轨道输出增益" aria-label="轨道音量" type="range" min="0" max="1.25" step=".01" value="${track.volume}">${sourceControl}</div>
    </div><span class="track-resize" data-action="resize" title="拖动调整轨道高度"></span></div>`
  }).join('')
  overviewLanes.innerHTML = project.tracks.map(track => {
    if (track.type === 'audio') {
      const clips = track.audioClips.map(clip => {
        const durationBeats = Math.max(.05, Math.max(0, clip.sourceDuration - (clip.offsetSeconds || 0)) * project.bpm / 60)
        return `<div class="overview-audio-clip ${clip.missing ? 'missing' : ''}" data-audio-clip-id="${clip.id}" style="left:${clip.beat * beatWidth}px;width:${Math.max(10, durationBeats * beatWidth)}px;--note-color:${track.color}" title="${escapeHtml(clip.name)}"><span>${escapeHtml(clip.name)}</span></div>`
      }).join('')
      return `<div class="overview-lane audio-lane" data-track-id="${track.id}" style="width:${width}px;--track-height:${track.height}px">${clips}</div>`
    }
    const isDrum = track.type === 'drum'
    const frequencyCache = new Map<string, number>()
    const pitches = track.notes.map(note => Math.log2(effectiveNoteFrequency(note, track, frequencyCache)))
    const low = Math.min(...pitches), high = Math.max(...pitches)
    const notes = track.notes.map(note => {
      const drumIndex = DRUM_VOICES.findIndex(voice => voice.id === note.drumId)
      const frequency = effectiveNoteFrequency(note, track, frequencyCache)
      const relative = isDrum ? 1 - Math.max(0, drumIndex) / Math.max(1, DRUM_VOICES.length - 1) : Number.isFinite(low) && high > low ? (Math.log2(frequency) - low) / (high - low) : .5
      const top = track.height - 18 - relative * Math.max(20, track.height - 36)
      return `<div class="overview-note ${isDrum ? 'drum-hit' : ''} ${note.ghost ? 'ghost' : ''} ${selectedNoteIds.has(note.id) ? 'selected' : ''}" data-note-id="${note.id}" style="left:${note.beat * beatWidth}px;top:${top}px;width:${Math.max(8, note.duration * beatWidth)}px;--note-color:${isDrum ? drumVoice(note.drumId).color : note.color || track.color}"></div>`
    }).join('')
    return `<div class="overview-lane" data-track-id="${track.id}" style="width:${width}px;--track-height:${track.height}px">${notes}</div>`
  }).join('')
}

function screenX(beat: number): number { return view.offsetX + beat * 48 * view.scale }
function screenY(hz: number): number { return view.offsetY + hzToY(hz) * view.scale }
function worldBeat(clientX: number): number { const rect = pianoCanvas.getBoundingClientRect(); return (clientX - rect.left - view.offsetX) / (48 * view.scale) }
function worldPitchY(clientY: number): number { const rect = pianoCanvas.getBoundingClientRect(); return (clientY - rect.top - view.offsetY) / view.scale }
function renderPianoRuler(): void {
  const parts: string[] = [], barLength = beatsPerBar(), margin = innerWidth
  for (let beat = 0; beat <= totalBeats(); beat++) {
    const x = screenX(beat); if (x >= -margin && x <= innerWidth + margin) parts.push(`<span class="ruler-beat" style="left:${x}px"></span>`)
  }
  for (let bar = 0; bar <= project.bars; bar++) {
    const x = screenX(bar * barLength); if (x < -margin || x > innerWidth + margin) continue
    parts.push(`<span class="ruler-bar" style="left:${x}px"><b>${bar + 1}</b></span>`)
  }
  pianoRulerContent.innerHTML = parts.join('')
  pianoRulerContent.style.transform = ''
  $('#piano-ruler-playhead').style.left = `${screenX(currentBeat)}px`
}

const DRUM_ROW_HEIGHT = 48
const DRUM_PAD_WIDTH = 160
function drumRowY(id: unknown): number {
  const index = Math.max(0, DRUM_VOICES.findIndex(voice => voice.id === id))
  return view.offsetY + (index + .5) * DRUM_ROW_HEIGHT * view.scale
}
function drumVoiceAt(clientY: number) {
  const rect = pianoCanvas.getBoundingClientRect()
  const index = Math.floor((clientY - rect.top - view.offsetY) / (DRUM_ROW_HEIGHT * view.scale))
  return DRUM_VOICES[index]
}
function renderDrumPiano(track: Track): void {
  const rect = pianoCanvas.getBoundingClientRect(), width = rect.width || innerWidth, height = rect.height || innerHeight
  renderedOffsetX = view.offsetX
  const parts: string[] = [], gridParts: string[] = [], renderMargin = width
  const leftBeat = ((-renderMargin - view.offsetX) / view.scale) / 48 - 1
  const rightBeat = ((width + renderMargin - view.offsetX) / view.scale) / 48 + 1
  const gridStep = project.snap || beatsPerBar(), firstGrid = Math.floor(leftBeat / gridStep) * gridStep
  for (let index = 0, beat = firstGrid; beat <= rightBeat && index < 4096; index++, beat = firstGrid + index * gridStep) {
    const x = screenX(beat), wholeBeat = Math.abs(beat - Math.round(beat)) < .0001
    gridParts.push(`<line class="grid-line snap-grid ${wholeBeat ? 'beat' : 'subdivision'}" x1="${x}" y1="0" x2="${x}" y2="${height}"/>`)
  }
  for (let bar = 0; bar <= project.bars; bar++) {
    const x = screenX(bar * beatsPerBar()); if (x >= -renderMargin && x <= width + renderMargin) gridParts.push(`<line class="grid-line bar" x1="${x}" y1="0" x2="${x}" y2="${height}"/>`)
  }
  DRUM_VOICES.forEach((voice, index) => {
    const rowHeight = DRUM_ROW_HEIGHT * view.scale, top = view.offsetY + index * rowHeight
    if (top > height + rowHeight || top + rowHeight < -rowHeight) return
    parts.push(`<rect class="drum-row ${index % 2 ? 'alternate' : ''}" x="0" y="${top}" width="${width}" height="${rowHeight}"/><line class="drum-row-line" x1="0" y1="${top + rowHeight}" x2="${width}" y2="${top + rowHeight}"/>`)
  })
  parts.push(...gridParts)
  for (const note of track.notes) {
    const voice = drumVoice(note.drumId), x1 = screenX(note.beat), x2 = Math.max(x1 + 11, screenX(note.beat + note.duration)), y = drumRowY(voice.id)
    if (x2 < -40 || x1 > width + 40 || y < -40 || y > height + 40) continue
    parts.push(`<g data-note-id="${note.id}" data-drum-id="${voice.id}" style="--note-color:${note.color || voice.color};opacity:${clamp(.28, note.velocity, 1)}"><line class="pitch-line drum-pitch-line ${note.muted ? 'muted' : ''} ${selectedNoteIds.has(note.id) ? 'selected' : ''}" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><line class="note-hit drum-note-hit" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/></g>`)
  }
  if (selectionBox) {
    const x = Math.min(selectionBox.x1, selectionBox.x2), y = Math.min(selectionBox.y1, selectionBox.y2)
    parts.push(`<rect class="selection-marquee" x="${x}" y="${y}" width="${Math.abs(selectionBox.x2 - selectionBox.x1)}" height="${Math.abs(selectionBox.y2 - selectionBox.y1)}"/>`)
  }
  parts.push(`<rect class="drum-pad-rail" x="0" y="0" width="${DRUM_PAD_WIDTH}" height="${height}"/>`)
  DRUM_VOICES.forEach((voice, index) => {
    const rowHeight = DRUM_ROW_HEIGHT * view.scale, top = view.offsetY + index * rowHeight, centre = top + rowHeight / 2
    if (top > height + rowHeight || top + rowHeight < -rowHeight) return
    parts.push(`<g class="drum-pad" data-drum-pad="${voice.id}" style="--drum-color:${voice.color}"><rect x="8" y="${top + 5}" width="${DRUM_PAD_WIDTH - 16}" height="${Math.max(22, rowHeight - 10)}" rx="4"/><text x="18" y="${centre - 5}">${voice.shortName}</text></g><foreignObject x="15" y="${centre + 3}" width="${DRUM_PAD_WIDTH - 30}" height="22"><div xmlns="http://www.w3.org/1999/xhtml" class="drum-level"><input data-drum-volume="${voice.id}" type="range" min="0" max="2" step=".01" value="${drumLevel(track, voice.id)}" title="${voice.name} ${levelText(drumLevel(track, voice.id))}" aria-label="${voice.name}音量" /></div></foreignObject>`)
  })
  pianoSvg.innerHTML = `<g id="piano-world">${parts.join('')}</g><line id="piano-playhead" class="play-indicator" x1="${screenX(currentBeat)}" y1="0" x2="${screenX(currentBeat)}" y2="${height}"/>`
  renderPianoRuler()
}

function renderPiano(): void {
  const track = pianoDisplayTrack(); if (!track) return
  $('#piano-view').classList.toggle('global-readonly', globalPianoMode)
  $('#piano-view').classList.toggle('drum-mode', !globalPianoMode && track.type === 'drum')
  $('#piano-mode-label').classList.toggle('hidden', !globalPianoMode)
  $('#active-track-name').textContent = track.name; $('#active-track-dot').style.setProperty('--track-color', track.color)
  pianoSvg.setAttribute('aria-label', globalPianoMode ? '只读全局钢琴窗，音符不可编辑' : '纯律钢琴窗')
  if (!globalPianoMode && track.type === 'drum') { pianoSvg.setAttribute('aria-label', '鼓轨编辑器'); renderDrumPiano(track); return }
  const rect = pianoCanvas.getBoundingClientRect(); const width = rect.width || innerWidth; const height = rect.height || innerHeight
  renderedOffsetX = view.offsetX
  const parts: string[] = []
  const renderMargin = width
  const leftBeat = ((-renderMargin - view.offsetX) / view.scale) / 48 - 1
  const rightBeat = ((width + renderMargin - view.offsetX) / view.scale) / 48 + 1
  const gridStep = project.snap || beatsPerBar()
  const firstGrid = Math.floor(leftBeat / gridStep) * gridStep
  for (let index = 0, beat = firstGrid; beat <= rightBeat && index < 4096; index++, beat = firstGrid + index * gridStep) {
    const wholeBeat = Math.abs(beat - Math.round(beat)) < .0001
    const x = screenX(beat); parts.push(`<line class="grid-line snap-grid ${wholeBeat ? 'beat' : 'subdivision'}" x1="${x}" y1="0" x2="${x}" y2="${height}"/>`)
  }
  for (let bar = 0; bar <= project.bars; bar++) {
    const x = screenX(bar * beatsPerBar()); if (x >= -renderMargin && x <= width + renderMargin) parts.push(`<line class="grid-line bar" x1="${x}" y1="0" x2="${x}" y2="${height}"/>`)
  }
  const tonic = 261.625565 * 2 ** (project.pitchTonic / 12)
  const scalePitches = tuningPitches(project)
  for (let octave = -8; octave <= 8; octave++) scalePitches.forEach(pitch => {
    const y = screenY(tonic * pitch.value * 2 ** octave)
    if (y > -10 && y < height + 10) parts.push(`<line class="pitch-guide ${Math.abs(pitch.value - 1) < 1e-9 ? 'tonic-line' : ''}" x1="${-renderMargin}" y1="${y}" x2="${width + renderMargin}" y2="${y}"/>`)
  })
  if (!globalPianoMode) for (const otherTrack of project.tracks) {
    if (otherTrack.id === track.id || (otherTrack.type ?? 'instrument') !== 'instrument') continue
    const otherById = new Map(otherTrack.notes.map(note => [note.id, note]))
    const otherFrequencyCache = new Map<string, number>()
    const noteSegments: string[] = [], bandSegments: string[] = []
    const curveSegments = new Map<number, string[]>()
    for (const note of otherTrack.notes) {
      if (!note.parentId || !note.ratio || note.ghost) continue
      const parent = otherById.get(note.parentId); if (!parent || parent.ghost) continue
      const style = intervalConnectionStyle(note.ratio), limit = primeLimit(note.ratio)
      const childBaseX = screenX(note.beat), childLength = note.duration * 48 * view.scale
      const parentBaseX = screenX(parent.beat), parentLength = parent.duration * 48 * view.scale
      const cap = (anchor: number) => anchor === 0 ? style.width / 2 : anchor === 1 ? -style.width / 2 : 0
      const childX = childBaseX + childLength * style.childAnchor + cap(style.childAnchor)
      let parentX = parentBaseX + parentLength * style.parentAnchor + cap(style.parentAnchor)
      if (limit === 3 || limit === 5) parentX = childX
      const childY = screenY(effectiveNoteFrequency(note, otherTrack, otherFrequencyCache)), parentY = screenY(effectiveNoteFrequency(parent, otherTrack, otherFrequencyCache))
      if (Math.max(childBaseX + childLength, parentBaseX + parentLength) < -renderMargin || Math.min(childBaseX, parentBaseX) > width + renderMargin || (childY < -100 && parentY < -100) || (childY > height + 100 && parentY > height + 100)) continue
      if (limit === 7 || limit === 11) {
        const half = style.width / 2
        bandSegments.push(`M ${childX - half} ${childY} L ${childX + half} ${childY} L ${parentX + half} ${parentY} L ${parentX - half} ${parentY} Z`)
      } else {
        const middleX = (childX + parentX) / 2 + style.middleOffset * view.scale, middleY = (childY + parentY) / 2
        const controlX = 2 * middleX - (childX + parentX) / 2
        const segments = curveSegments.get(style.width) ?? []
        segments.push(`M ${childX} ${childY} Q ${controlX} ${middleY}, ${parentX} ${parentY}`); curveSegments.set(style.width, segments)
      }
    }
    for (const note of otherTrack.notes) {
      if (note.ghost) continue
      const x1 = screenX(note.beat), x2 = screenX(note.beat + note.duration), y = screenY(effectiveNoteFrequency(note, otherTrack, otherFrequencyCache))
      if (x2 < -renderMargin || x1 > width + renderMargin || y < -50 || y > height + 50) continue
      noteSegments.push(`M ${x1} ${y} L ${x2} ${y}`)
    }
    if (bandSegments.length) parts.push(`<path class="other-track-interval interval-band" d="${bandSegments.join(' ')}"/>`)
    for (const [strokeWidth, segments] of curveSegments) if (segments.length) parts.push(`<path class="other-track-interval" stroke-width="${strokeWidth}" d="${segments.join(' ')}"/>`)
    if (noteSegments.length) parts.push(`<path class="other-track-note" d="${noteSegments.join(' ')}"/>`)
  }
  const byId = new Map(track.notes.map(note => [note.id, note]))
  const frequencyCache = new Map<string, number>()
  const noteIdsWithChildren = new Set(track.notes.map(note => note.parentId).filter((id): id is string => Boolean(id)))
  const nameCache = new Map<string, SpelledPitch>()
  for (const note of track.notes) {
    if (!note.parentId || !note.ratio) continue
    const parent = byId.get(note.parentId); if (!parent) continue
    const style = intervalConnectionStyle(note.ratio), limit = primeLimit(note.ratio)
    const childBaseX = screenX(note.beat), childLength = note.duration * 48 * view.scale
    const parentBaseX = screenX(parent.beat), parentLength = parent.duration * 48 * view.scale
    const cap = (anchor: number) => anchor === 0 ? style.width / 2 : anchor === 1 ? -style.width / 2 : 0
    const childX = childBaseX + childLength * style.childAnchor + cap(style.childAnchor)
    let parentX = parentBaseX + parentLength * style.parentAnchor + cap(style.parentAnchor)
    if (limit === 3 || limit === 5) parentX = childX
    const childY = screenY(effectiveNoteFrequency(note, track, frequencyCache)), parentY = screenY(effectiveNoteFrequency(parent, track, frequencyCache))
    if (Math.max(childBaseX + childLength, parentBaseX + parentLength) < -renderMargin || Math.min(childBaseX, parentBaseX) > width + renderMargin || (childY < -100 && parentY < -100) || (childY > height + 100 && parentY > height + 100)) continue
    const middleX = (childX + parentX) / 2 + style.middleOffset * view.scale
    const middleY = (childY + parentY) / 2
    const controlX = 2 * middleX - (childX + parentX) / 2
    const ghostClass = note.ghost || parent.ghost ? 'ghost' : ''
    if (limit === 7 || limit === 11) {
      const half = style.width / 2
      parts.push(`<polygon class="interval-curve interval-band ${ghostClass}" data-prime-limit="${limit}" data-child-anchor="${style.childAnchor}" data-parent-anchor="${style.parentAnchor}" data-middle-offset="${style.middleOffset}" style="--interval-color:${style.color};fill:${style.color};stroke:none" points="${childX - half},${childY} ${childX + half},${childY} ${parentX + half},${parentY} ${parentX - half},${parentY}"/>`)
    } else {
      parts.push(`<path class="interval-curve ${ghostClass}" data-prime-limit="${limit}" data-child-anchor="${style.childAnchor}" data-parent-anchor="${style.parentAnchor}" data-middle-offset="${style.middleOffset}" style="--interval-color:${style.color}" stroke-width="${style.width}" d="M ${childX} ${childY} Q ${controlX} ${middleY}, ${parentX} ${parentY}"/>`)
    }
  }
  for (const note of track.notes) {
    const x1 = screenX(note.beat), x2 = screenX(note.beat + note.duration), y = screenY(effectiveNoteFrequency(note, track, frequencyCache))
    if (x2 < -renderMargin || x1 > width + renderMargin || y < -50 || y > height + 50) continue
    const label = noteName(note, track, nameCache)
    const noteColor = note.color || '#ffffff'
    if (!note.parentId && noteIdsWithChildren.has(note.id)) parts.push(`<polygon class="root-marker" style="--note-color:${noteColor}" points="${x1 - 13},${y} ${x1 - 5},${y - 5} ${x1 - 5},${y + 5}"/>`)
    const labelSize = clamp(6, 9 * view.scale, 12), labelStroke = clamp(1.25, 2.25 * view.scale, 2.75)
    const ratioLabel = note.ratio && !DEFAULT_INTERVAL_RATIOS.has(`${note.ratio.numerator}/${note.ratio.denominator}`)
      ? `<tspan class="ratio-text"> · ${ratioText(note)}</tspan>` : ''
    parts.push(`<g data-note-id="${note.id}" data-ghost="${Boolean(note.ghost)}" style="--note-color:${noteColor}"><line class="pitch-line ${note.muted ? 'muted' : ''} ${note.ghost ? 'ghost' : ''} ${selectedNoteIds.has(note.id) ? 'selected' : ''}" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><line class="note-hit" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><text class="piano-label" style="font-size:${labelSize}px;stroke-width:${labelStroke}px" x="${x1 + 5 * view.scale}" y="${y + labelSize * .34}">${label}${ratioLabel}</text></g>`)
  }
  for (const annotation of track.annotations) {
    const x = screenX(annotation.beat), y = screenY(annotation.frequency)
    if (x < -renderMargin - 260 || x > width + renderMargin || y < -130 || y > height + 20) continue
    const editing = annotation.id === editingAnnotationId
    parts.push(`<foreignObject class="annotation-object" data-annotation-id="${annotation.id}" x="${x}" y="${y}" width="260" height="96"><div xmlns="http://www.w3.org/1999/xhtml" class="piano-annotation" data-annotation-id="${annotation.id}" ${editing ? 'contenteditable="true" spellcheck="true" data-editing="true"' : ''}>${sanitizeRichText(annotation.html)}</div></foreignObject>`)
  }
  if (selectionBox) {
    const x = Math.min(selectionBox.x1, selectionBox.x2), y = Math.min(selectionBox.y1, selectionBox.y2)
    parts.push(`<rect class="selection-marquee" x="${x}" y="${y}" width="${Math.abs(selectionBox.x2 - selectionBox.x1)}" height="${Math.abs(selectionBox.y2 - selectionBox.y1)}"/>`)
  }
  pianoSvg.innerHTML = `<g id="piano-world">${parts.join('')}</g><line id="piano-playhead" class="play-indicator" x1="${screenX(currentBeat)}" y1="0" x2="${screenX(currentBeat)}" y2="${height}"/>`
  renderPianoRuler()
}

function centrePiano(track: Track): void {
  if (track.type === 'drum') {
    view.scale = 1; view.offsetX = DRUM_PAD_WIDTH + 24
    view.offsetY = Math.max(58, (innerHeight - 61 - DRUM_VOICES.length * DRUM_ROW_HEIGHT) / 2)
    return
  }
  const frequencyCache = new Map<string, number>()
  const pitches = track.notes.length ? track.notes.map(note => hzToY(effectiveNoteFrequency(note, track, frequencyCache))).sort((a, b) => a - b) : [hzToY(440)]
  const middle = pitches[Math.floor(pitches.length / 2)]
  view.scale = 1; view.offsetX = 85 - Math.min(...track.notes.map(note => note.beat), 0) * 48; view.offsetY = innerHeight * .47 - middle
}
function openPiano(trackId: string, noteId?: string): void {
  const track = project.tracks.find(item => item.id === trackId)
  if (!track || track.type === 'audio') { if (track) activeTrackId = track.id; selectOnly(null); renderOverview(); return }
  globalPianoMode = false; activeTrackId = trackId; selectOnly(noteId ?? null); if (track.type === 'drum' && activeTool === 'text') activeTool = 'pen'; centrePiano(track)
  $('#track-view').classList.add('hidden'); $('#piano-view').classList.remove('hidden'); closePopups(); updateToolUi(false); renderPiano(); renderSettings()
}
function openGlobalPiano(): void {
  const instrumentTracks = project.tracks.filter(track => (track.type ?? 'instrument') === 'instrument')
  if (!instrumentTracks.length) return toast('当前工程没有可显示的有音高乐器轨', true)
  if ((activeTrack().type ?? 'instrument') !== 'instrument') activeTrackId = instrumentTracks[0].id
  globalPianoMode = true; selectOnly(null); selectionBox = null; centrePiano(pianoDisplayTrack())
  $('#track-view').classList.add('hidden'); $('#piano-view').classList.remove('hidden'); closePopups(); updateToolUi(false); renderPiano()
}
function closePiano(): void {
  closePopups(); globalPianoMode = false
  $('#piano-view').classList.add('hidden'); $('#piano-view').classList.remove('global-readonly'); $('#track-view').classList.remove('hidden'); renderOverview()
}

function descendants(track: Track, parentId: string): JiNote[] {
  const ids = new Set([parentId]); let changed = true
  while (changed) { changed = false; for (const note of track.notes) if (note.parentId && ids.has(note.parentId) && !ids.has(note.id)) { ids.add(note.id); changed = true } }
  return track.notes.filter(note => ids.has(note.id) && note.id !== parentId)
}
function recalculateChildren(track: Track, parentId: string): void {
  recalculateRatioDescendants(project, track, parentId)
}
function addRootAt(clientX: number, clientY: number): void {
  const track = activeTrack(); checkpoint()
  const rawFrequency = clamp(8, yToHz(worldPitchY(clientY)), 24000)
  const beat = clamp(0, snap(worldBeat(clientX)), totalBeats() - MIN_NOTE_DURATION)
  const note: JiNote = { id: uid('note'), trackId: track.id, beat, duration: Math.min(currentNoteDuration, totalBeats() - beat), frequency: snapFrequency(rawFrequency), velocity: .8 }
  track.notes.push(note); selectOnly(note.id); renderPiano(); commit(); void auditionNote(track, note)
}

let noteMenuAnchor: { menu: HTMLElement; clientX: number; clientY: number } | null = null
function positionNoteMenu(menu: HTMLElement, clientX: number, clientY: number): void {
  const margin = 8, safeTop = 55, safeBottom = 98
  const maxHeight = Math.max(180, innerHeight - safeTop - safeBottom)
  menu.style.maxHeight = `${maxHeight}px`
  const width = menu.offsetWidth || 390, height = Math.min(menu.offsetHeight || 270, maxHeight)
  menu.style.left = `${clamp(margin, clientX - width / 2, Math.max(margin, innerWidth - width - margin))}px`
  menu.style.top = `${clamp(safeTop, clientY - 25, Math.max(safeTop, innerHeight - safeBottom - height))}px`
}
function repositionOpenNoteMenu(): void {
  if (!noteMenuAnchor?.menu.classList.contains('open')) return
  positionNoteMenu(noteMenuAnchor.menu, noteMenuAnchor.clientX, noteMenuAnchor.clientY)
}
function showNoteMenu(noteId: string, clientX: number, clientY: number): void {
  const found = findNote(noteId); if (!found) return
  selectOnly(noteId); renderPiano(); closePopups(false)
  const { note } = found; const menu = $(note.parentId ? '#note-menu' : '#root-menu')
  const isDrum = found.track.type === 'drum'
  menu.classList.toggle('drum-menu', isDrum)
  $('#root-hz').contentEditable = isDrum ? 'false' : 'true'
  $('#drum-note-voice').value = note.drumId || 'kick'
  const frequency = effectiveNoteFrequency(note, found.track)
  if (note.parentId && note.ratio) {
    const frequencyText = frequency.toFixed(3), hzField = $('#note-hz')
    hzField.textContent = frequencyText; hzField.dataset.displayedValue = frequencyText; hzField.dataset.noteId = note.id; $('#note-name-ratio').textContent = `${noteName(note, found.track)} · ${ratioText(note)}`
    renderEdoPosition('#note-edo-position', note, frequency)
    $('#note-volume').value = String(Math.round(note.velocity * 100)); $('#note-mute').classList.toggle('active', Boolean(note.muted)); $('#note-color').value = note.color || '#ffffff'
  } else {
    const frequencyText = frequency.toFixed(3), hzField = $('#root-hz')
    hzField.textContent = frequencyText; hzField.dataset.displayedValue = frequencyText; hzField.dataset.noteId = note.id; $('#root-note-name').textContent = isDrum ? drumVoice(note.drumId).name : noteName(note, found.track)
    renderEdoPosition('#root-edo-position', note, frequency)
    $('#root-volume').value = String(Math.round(note.velocity * 100)); $('#root-mute').classList.toggle('active', Boolean(note.muted)); $('#root-color').value = note.color || '#ffffff'
  }
  menu.classList.add('open'); $('#piano-overlay').style.visibility = 'visible'
  noteMenuAnchor = { menu, clientX, clientY }; positionNoteMenu(menu, clientX, clientY)
  void auditionNote(found.track, note)
}
function annotationEditorElement(): HTMLElement | null {
  return editingAnnotationId ? document.querySelector<HTMLElement>(`.piano-annotation[data-annotation-id="${CSS.escape(editingAnnotationId)}"]`) : null
}
function placeCaretAtPoint(editor: HTMLElement, clientX: number, clientY: number): void {
  const documentWithCaret = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null }
  const range = document.createRange(), position = documentWithCaret.caretPositionFromPoint?.(clientX, clientY)
  if (position && editor.contains(position.offsetNode)) range.setStart(position.offsetNode, position.offset)
  else {
    const pointRange = documentWithCaret.caretRangeFromPoint?.(clientX, clientY)
    if (pointRange && editor.contains(pointRange.startContainer)) range.setStart(pointRange.startContainer, pointRange.startOffset)
    else { range.selectNodeContents(editor); range.collapse(false) }
  }
  range.collapse(true); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
}
function hideAnnotationFormat(): void { $('#annotation-format').classList.remove('open'); annotationSelection = null }
function finishInlineAnnotation(render = true): void {
  if (!editingAnnotationId) return
  const found = findAnnotation(editingAnnotationId), track = found?.track, annotation = found?.annotation, editor = annotationEditorElement()
  let finalHtml = sanitizeRichText(editor?.innerHTML ?? annotation?.html ?? '')
  const probe = document.createElement('div'); probe.innerHTML = finalHtml
  const empty = !probe.textContent?.trim()
  const changed = annotationWasNew ? !empty : empty || finalHtml !== annotationOriginalHtml
  if (annotation && track) {
    if (empty) track.annotations = track.annotations.filter(item => item.id !== annotation.id)
    else annotation.html = finalHtml
  }
  editingAnnotationId = null; annotationOriginalHtml = ''; annotationWasNew = false; hideAnnotationFormat()
  if (changed) commit()
  if (render) renderPiano()
}
function openInlineAnnotationEditor(annotationId: string | null, clientX: number, clientY: number): void {
  if (editingAnnotationId === annotationId && annotationId) return
  finishInlineAnnotation(false); closePopups(false)
  audio.stop(); setPlayState(false)
  if (!annotationId) selectOnly(null)
  const found = findAnnotation(annotationId)
  const track = found?.track ?? activeTrack(); let annotation = found?.annotation
  checkpoint(); annotationWasNew = !annotation
  if (!annotation) {
    annotation = {
      id: uid('annotation'), trackId: track.id,
      beat: clamp(0, snap(worldBeat(clientX)), totalBeats()), frequency: clamp(8, yToHz(worldPitchY(clientY)), 24000), html: '<br>'
    }
    track.annotations.push(annotation)
  }
  editingAnnotationId = annotation.id; annotationOriginalHtml = annotationWasNew ? '' : sanitizeRichText(annotation.html)
  hideAnnotationFormat(); renderPiano()
  requestAnimationFrame(() => {
    const editor = annotationEditorElement(); if (!editor) return
    editor.focus(); placeCaretAtPoint(editor, clientX, clientY)
  })
}
function closePopups(clearSelection = false): void {
  finishInlineAnnotation(false)
  document.querySelectorAll('.note-menu,.settings-menu,.scale-menu').forEach(menu => menu.classList.remove('open'))
  document.querySelectorAll('.ratio-preset-panel').forEach(panel => panel.classList.remove('open'))
  noteMenuAnchor = null
  $('#piano-overlay').style.visibility = 'hidden'
  $('#global-overlay').classList.remove('open')
  if (clearSelection) { selectOnly(null); renderPiano() }
}

function addRatioChild(parent: JiNote, track: Track, numeratorId: string, denominatorId: string, directionId: string): void {
  try {
    const ratio = parseRatio($(numeratorId).value, $(denominatorId).value, $(directionId).value === 'down' ? 'down' : 'up')
    const frequency = parent.frequency * ratioValue(ratio)
    if (frequency < 8 || frequency > 24000) throw new Error('结果频率超出可播放范围')
    checkpoint(); const child: JiNote = { id: uid('note'), trackId: track.id, parentId: parent.id, ratio, beat: parent.beat, duration: parent.duration, frequency, velocity: parent.velocity }
    track.notes.push(child); selectOnly(child.id); closePopups(); renderPiano(); commit(); void auditionNote(track, child)
  } catch (error) { toast(error instanceof Error ? error.message : '音程比无效', true) }
}
function moveSelectedByRatio(numeratorId: string, denominatorId: string, directionId: string): void {
  const found = findNote(selectedNoteId); if (!found) return
  try {
    const ratio = parseRatio($(numeratorId).value, $(denominatorId).value, $(directionId).value === 'down' ? 'down' : 'up')
    const frequency = found.note.frequency * ratioValue(ratio)
    if (frequency < 8 || frequency > 24000) throw new Error('结果频率超出可播放范围')
    checkpoint()
    found.note.ghost = true
    const moved: JiNote = { id: uid('note'), trackId: found.track.id, parentId: found.note.id, ratio, beat: found.note.beat, duration: found.note.duration, frequency, velocity: found.note.velocity }
    found.track.notes.push(moved); selectOnly(moved.id)
    closePopups(); renderPiano(); commit(); void auditionNote(found.track, moved)
  } catch (error) { toast(error instanceof Error ? error.message : '音程比无效', true) }
}
function deleteSelected(): void {
  const track = activeTrack(); if (!selectedNoteIds.size) return
  checkpoint(); const remove = new Set<string>()
  for (const id of selectedNoteIds) {
    const note = track.notes.find(item => item.id === id); if (!note) continue
    remove.add(id); for (const child of descendants(track, id)) remove.add(child.id)
  }
  track.notes = track.notes.filter(note => !remove.has(note.id)); selectOnly(null); closePopups(); renderAll(); commit()
}
function copySelectedNotes(): void {
  const track = activeTrack(), selected = track.notes.filter(note => selectedNoteIds.has(note.id))
  if (!selected.length) return toast('请先选择音符', true)
  clipboardNotes = selected.map(note => ({ ...note, ratio: note.ratio ? { ...note.ratio } : undefined }))
  clipboardTrackType = track.type ?? 'instrument'
  closePopups(false); toast(`已复制 ${selected.length} 个音符`)
}
function selectAllNotes(): void {
  const notes = activeTrack().notes
  selectedNoteIds = new Set(notes.map(note => note.id)); selectedNoteId = notes.at(-1)?.id ?? null
  closePopups(false); renderAll()
  if (!notes.length) toast('当前轨道没有音符', true)
}
function cutSelectedNotes(): void {
  const track = activeTrack(); if (!selectedNoteIds.size) return toast('请先选择音符', true)
  const remove = new Set<string>()
  for (const id of selectedNoteIds) {
    const note = track.notes.find(item => item.id === id); if (!note) continue
    remove.add(id); for (const child of descendants(track, id)) remove.add(child.id)
  }
  const cutNotes = track.notes.filter(note => remove.has(note.id))
  if (!cutNotes.length) return toast('请先选择音符', true)
  clipboardNotes = cutNotes.map(note => ({ ...note, ratio: note.ratio ? { ...note.ratio } : undefined }))
  clipboardTrackType = track.type ?? 'instrument'
  checkpoint(); track.notes = track.notes.filter(note => !remove.has(note.id)); selectOnly(null)
  closePopups(false); renderAll(); commit(`已剪切 ${cutNotes.length} 个音符`)
}
function pasteSelectedNotes(): void {
  if (!clipboardNotes?.length) return toast('剪贴板中没有音符', true)
  const track = activeTrack(), source = clipboardNotes
  if ((track.type ?? 'instrument') !== clipboardTrackType) return toast('鼓击与有音高音符不能跨类型粘贴', true)
  const firstBeat = Math.min(...source.map(note => note.beat)), lastBeat = Math.max(...source.map(note => note.beat + note.duration))
  const targetBeat = clamp(0, snap(currentBeat), Math.max(0, totalBeats() - (lastBeat - firstBeat)))
  const ids = new Map(source.map(note => [note.id, uid('note')]))
  checkpoint()
  const copies = source.map(note => {
    const internalParent = note.parentId ? ids.get(note.parentId) : undefined
    return { ...note, id: ids.get(note.id)!, trackId: track.id, beat: targetBeat + note.beat - firstBeat, parentId: internalParent, ratio: internalParent && note.ratio ? { ...note.ratio } : undefined }
  })
  track.notes.push(...copies); selectedNoteIds = new Set(copies.map(note => note.id)); selectedNoteId = copies.at(-1)?.id ?? null
  closePopups(false); renderAll(); commit(`已粘贴 ${copies.length} 个音符`)
}

function updatePosition(beat: number): void {
  const previousBeat = currentBeat
  currentBeat = clamp(0, beat, totalBeats()); const barLength = beatsPerBar(), bar = Math.floor(currentBeat / barLength) + 1, inside = currentBeat % barLength, beatNo = Math.floor(inside) + 1, tick = Math.floor((inside % 1) * 96)
  if ((audio.playing || currentBeat === 0) && !$('#piano-view').classList.contains('hidden')) {
    const pixelsPerBeat = 48 * view.scale
    if (playbackFollowMode === 'locked') {
      view.offsetX = pianoCanvas.clientWidth * .25 - currentBeat * pixelsPerBeat
      const shift = view.offsetX - renderedOffsetX
      const world = document.querySelector<SVGGElement>('#piano-world')
      if (!world || Math.abs(shift) >= Math.max(240, pianoCanvas.clientWidth * .48)) renderPiano()
      else {
        world.setAttribute('transform', `translate(${shift} 0)`)
        pianoRulerContent.style.transform = `translateX(${shift}px)`
      }
    } else if (playbackFollowMode === 'page' && audio.playing) {
      if (currentBeat + .001 < previousBeat) {
        view.offsetX = 0
        renderPiano()
      } else {
        const leftBeat = -view.offsetX / pixelsPerBeat
        const rightBeat = (pianoCanvas.clientWidth - view.offsetX) / pixelsPerBeat
        const lastBarAtRight = Math.floor((rightBeat - .0001) / barLength) * barLength
        if (lastBarAtRight > leftBeat + .0001 && lastBarAtRight < totalBeats() && currentBeat >= lastBarAtRight) {
          view.offsetX = -lastBarAtRight * pixelsPerBeat
          renderPiano()
        }
      }
    }
  }
  const text = `${String(bar).padStart(3, '0')}:${String(beatNo).padStart(2, '0')}:${String(tick).padStart(3, '0')}`
  $('#overview-position').textContent = text; $('#piano-position').textContent = text
  $('#overview-playhead').style.transform = `translateX(${currentBeat * 44}px)`
  const line = document.querySelector<SVGLineElement>('#piano-playhead'); if (line) { const x = screenX(currentBeat); line.setAttribute('x1', String(x)); line.setAttribute('x2', String(x)) }
  $('#piano-ruler-playhead').style.left = `${screenX(currentBeat)}px`
}
function cyclePlaybackFollow(): void {
  const modes: PlaybackFollowMode[] = ['off', 'locked', 'page']
  playbackFollowMode = modes[(modes.indexOf(playbackFollowMode) + 1) % modes.length]
  const button = $('#piano-follow')
  const labels: Record<PlaybackFollowMode, { text: string; title: string; toast: string }> = {
    off: { text: '⌖', title: '播放跟随：关闭（点击切换）', toast: '播放跟随已关闭' },
    locked: { text: '锁', title: '播放跟随：光标锁定（点击切换）', toast: '播放跟随：光标锁定' },
    page: { text: '页', title: '播放跟随：按小节翻页（点击切换）', toast: '播放跟随：按小节翻页' }
  }
  const state = labels[playbackFollowMode]
  button.textContent = state.text; button.title = state.title
  button.classList.toggle('active', playbackFollowMode !== 'off')
  button.dataset.followMode = playbackFollowMode
  updatePosition(currentBeat); toast(state.toast)
}
function seekToBeat(beat: number): void { audio.stop(); setPlayState(false); updatePosition(clamp(0, beat, totalBeats())) }
async function togglePlay(): Promise<void> {
  if (audio.playing) { audio.stop(); setPlayState(false); return }
  try { setPlayState(true); await audio.play(projectWithEffectiveFrequencies(), currentBeat >= totalBeats() ? 0 : currentBeat, updatePosition, () => setPlayState(false)) }
  catch (error) { setPlayState(false); toast(error instanceof Error ? error.message : '无法播放', true) }
}
function setPlayState(playing: boolean): void {
  for (const selector of ['#overview-play', '#piano-play']) { $(selector).textContent = playing ? 'Ⅱ' : '▶'; $(selector).classList.toggle('playing', playing) }
}
function stopPlayback(): void { audio.stop(); setPlayState(false); updatePosition(0) }

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value && typeof value === 'object' && 'data' in value && Array.isArray((value as { data: unknown }).data)) return Uint8Array.from((value as { data: number[] }).data)
  throw new Error('无法读取二进制数据')
}
async function importAudioTrack(): Promise<void> {
  try {
    let result: { path?: string; name: string; bytes: Uint8Array } | null = null
    if (window.desktop) {
      const file = await window.desktop.openAudio()
      if (file?.bytes) result = { path: file.path, name: file.name || '音频', bytes: toBytes(file.bytes) }
    } else {
      const input = $('#fallback-file') as HTMLInputElement; input.accept = 'audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.webm'; input.value = ''
      const file = await new Promise<File | null>(resolve => { input.onchange = () => resolve(input.files?.[0] ?? null); input.click() })
      if (file) result = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
    }
    if (!result) return
    const track = makeAudioTrack(project.tracks.length, result.name, result.path), clip = track.audioClips[0]
    await audio.loadAudioClip(clip, result.bytes)
    checkpoint(); project.tracks.push(track); activeTrackId = track.id; selectOnly(null)
    const clipEndBeat = clip.beat + clip.sourceDuration * project.bpm / 60
    project.bars = clamp(4, Math.max(project.bars, Math.ceil(clipEndBeat / beatsPerBar())), 256)
    renderAll(); commit(`已导入音频轨：${track.name}`)
  } catch (error) { toast(`音频导入失败：${error instanceof Error ? error.message : '无法解码音频'}`, true) }
}
async function chooseSf2(track: Track): Promise<void> {
  try {
    let result: { path?: string; name?: string; bytes: Uint8Array } | null = null
    if (window.desktop) { const file = await window.desktop.openSf2(); if (file?.bytes) result = { path: file.path, name: file.name, bytes: toBytes(file.bytes) } }
    else {
      const input = $('#fallback-file') as HTMLInputElement; input.accept = '.sf2'; input.value = ''
      const file = await new Promise<File | null>(resolve => { input.onchange = () => resolve(input.files?.[0] ?? null); input.click() })
      if (file) result = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
    }
    if (!result) return
    const recovering = track.instrument.kind === 'sf2' && (track.instrument.missing || !audio.hasFont(track.id))
    const targets = recovering ? project.tracks.filter(item => item.instrument.kind === 'sf2' && item.instrument.name === track.instrument.name && (item.instrument.missing || !audio.hasFont(item.id))) : [track]
    checkpoint()
    for (const [index, target] of targets.entries()) {
      const instrument: Track['instrument'] = { kind: 'sf2', name: result.name ?? 'SoundFont', path: result.path, programIndex: recovering ? target.instrument.programIndex : 0, missing: false }
      const candidate = { ...target, instrument }
      const programs = await audio.loadSf2(candidate, result.bytes, result.path, index ? targets[0].id : undefined)
      const byName = recovering ? programs.findIndex(program => program.name === target.instrument.programName) : -1
      const percussion = target.type === 'drum' && !recovering ? programs.findIndex(program => program.bank === 128) : -1
      const programIndex = byName >= 0 ? byName : percussion >= 0 ? percussion : clamp(0, instrument.programIndex, programs.length - 1)
      audio.selectProgram(target.id, programIndex)
      target.instrument = { ...instrument, programIndex, programName: programs[programIndex]?.name }
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    renderAll(); commit(`已加载 ${track.instrument.name}`)
  } catch (error) { renderAll(); toast(`SF2 加载失败：${error instanceof Error ? error.message : '未知错误'}`, true) }
}
let restoringFonts: Promise<void> | undefined
async function chooseBundledSf2(track: Track): Promise<void> {
  try {
    const candidate = { ...track, instrument: { kind: 'sf2' as const, bundledId: 'touhou' as const, name: 'Touhou.sf2', programIndex: 0 } }
    toast('正在加载 Touhou.sf2…')
    const programs = await audio.loadBundledSf2(candidate)
    const percussion = track.type === 'drum' ? programs.findIndex(program => program.bank === 128) : -1
    const programIndex = Math.max(0, percussion)
    audio.selectProgram(track.id, programIndex)
    checkpoint(); track.instrument = { ...candidate.instrument, programIndex, programName: programs[programIndex]?.name, missing: false }
    renderAll(); commit('已加载预制音源 Touhou.sf2')
  } catch (error) { renderAll(); toast(`Touhou.sf2 加载失败：${error instanceof Error ? error.message : '未知错误'}`, true) }
}
function restoreFonts(log?: ExportLog): Promise<void> {
  if (restoringFonts) { log?.record('等待当前音源加载完成'); return restoringFonts }
  restoringFonts = restoreFontsNow(log).finally(() => { restoringFonts = undefined })
  return restoringFonts
}
async function restoreFontsNow(log?: ExportLog): Promise<void> {
  const files = new Map<string, { path: string; bytes: Uint8Array }>()
  for (const track of project.tracks) if (track.instrument.kind === 'sf2') {
    if (audio.hasFont(track.id) && !track.instrument.missing) continue
    try {
      if (track.instrument.bundledId === 'touhou') {
        const programs = await audio.loadBundledSf2(track)
        const byName = programs.findIndex(program => program.name === track.instrument.programName)
        track.instrument.programIndex = byName >= 0 ? byName : clamp(0, track.instrument.programIndex, programs.length - 1)
        audio.selectProgram(track.id, track.instrument.programIndex); track.instrument.missing = false
        continue
      }
      if (!window.desktop) continue
      const resolved = await window.desktop.resolveAsset?.({ path: track.instrument.path, name: track.instrument.name, projectPath, kind: 'sf2' })
      const path = resolved?.path ?? track.instrument.path
      if (!path) { track.instrument.missing = true; log?.record('SF2 路径缺失', { track: track.name, instrument: track.instrument }); continue }
      log?.record('加载 SF2', { track: track.name, path, programIndex: track.instrument.programIndex })
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      let file = files.get(path)
      if (!file) {
        const value = await window.desktop.readSf2(path)
        if (!value?.bytes) throw new Error('SF2 文件为空')
        file = { path: value.path, bytes: toBytes(value.bytes) }; files.set(path, file)
      }
      const programs = await audio.loadSf2(track, file.bytes, file.path); track.instrument.missing = false; track.instrument.path = file.path
      const byName = programs.findIndex(program => program.name === track.instrument.programName)
      if (byName >= 0) track.instrument.programIndex = byName
      track.instrument.programIndex = clamp(0, track.instrument.programIndex, Math.max(0, programs.length - 1)); audio.selectProgram(track.id, track.instrument.programIndex)
      log?.record('SF2 已就绪', { track: track.name, programIndex: track.instrument.programIndex, programName: programs[track.instrument.programIndex]?.name })
    } catch (error) { track.instrument.missing = true; log?.error(`SF2 加载失败：${track.name}`, error) }
  }
  renderAll()
}
async function restoreAudioClips(): Promise<void> {
  if (!window.desktop) return
  let changed = false
  for (const track of project.tracks) for (const clip of track.audioClips ?? []) {
    if (audio.hasAudioClip(clip.id)) { clip.missing = false; continue }
    if (!clip.path) { clip.missing = true; continue }
    try {
      const resolved = await window.desktop.resolveAsset?.({ path: clip.path, name: clip.name, projectPath, kind: 'audio' })
      const file = await window.desktop.readAudio(resolved?.path ?? clip.path); if (!file?.bytes) throw new Error('音频文件为空')
      clip.path = file.path
      await audio.loadAudioClip(clip, toBytes(file.bytes)); changed = true
    } catch { clip.missing = true; changed = true }
  }
  if (changed) renderAll()
}

function renderSettings(): void {
  $('#settings-snap').value = String(project.snap)
}
function openSettings(): void { closePopups(false); renderSettings(); $('#settings-menu').classList.add('open'); $('#piano-overlay').style.visibility = 'visible' }
function renderGlobalSettings(): void {
  $('#global-bpm').value = String(project.bpm); $('#global-signature').value = project.signature; $('#global-bars').value = String(project.bars); $('#global-snap').value = String(project.snap)
  const swingToggle = $('#global-swing') as HTMLInputElement, swingAmount = $('#global-swing-amount') as HTMLInputElement
  swingToggle.checked = project.swingEnabled; swingAmount.value = String(project.swingAmount); swingAmount.disabled = !project.swingEnabled; $('#global-swing-value').textContent = `${Math.round(project.swingAmount)}%`
  ;($('#global-metronome') as HTMLInputElement).checked = project.metronome
}
function openGlobalSettings(): void {
  closePopups(false); renderGlobalSettings(); $('#global-settings-menu').classList.add('open'); $('#global-overlay').classList.add('open')
}
function renderScaleMenu(): void {
  $('#scale-tonic').value = String(project.pitchTonic)
  $('#scale-system').value = project.tuningSystem
  $('#scale-mode').value = project.pitchMode
  $('#scale-edo').value = String(project.tuningEdo)
  ;($('#scale-harmonize') as HTMLInputElement).checked = project.harmonizeRatiosToEdo
  $('#scale-interval-list').innerHTML = project.tuningIntervals.map(interval => tuningIntervalMarkup(project.tuningSystem, interval)).join('')
  updateScaleEditor()
}

function tuningIntervalMarkup(system: TuningSystem, interval?: TuningInterval): string {
  if (system === 'edo') return `<div class="tuning-interval-row" data-tuning-row><strong data-tuning-name>—</strong><div class="tuning-value-fields"><input data-part="steps" type="number" step="1" value="${interval?.steps ?? 1}"><span>步</span></div><span data-tuning-cents>—</span><button class="tuning-remove" data-action="remove-tuning" title="删除音程">×</button></div>`
  return `<div class="tuning-interval-row" data-tuning-row><strong data-tuning-name>—</strong><div class="tuning-value-fields"><input data-part="n" type="number" min="1" step="1" value="${interval?.numerator ?? 3}"><span>/</span><input data-part="d" type="number" min="1" step="1" value="${interval?.denominator ?? 2}"></div><span data-tuning-cents>—</span><button class="tuning-remove" data-action="remove-tuning" title="删除音程">×</button></div>`
}

function updateScaleEditor(): void {
  const system = $('#scale-system').value as TuningSystem
  $('#scale-preset-panel').classList.toggle('hidden', system !== 'preset')
  $('#scale-custom-panel').classList.toggle('hidden', system === 'preset')
  $('#scale-edo-row').classList.toggle('hidden', system !== 'edo')
  $('#scale-harmonize-row').classList.toggle('hidden', system !== 'edo')
  const tonic = Number($('#scale-tonic').value)
  $('#scale-root-name').textContent = pitchNameForOffset(tonic, 0, 'chromatic')
  $('#scale-root-value').textContent = system === 'edo' ? '0 步' : '1/1'
  if (system === 'preset') {
    const mode = $('#scale-mode').value, active = new Set(PITCH_MODES[mode] || PITCH_MODES.chromatic)
    const ratios = generateTwelveToneRatios(mode)
    $('#scale-preset-list').innerHTML = ratios.map(([numerator, denominator], index) => active.has(index)
      ? `<div class="tuning-preview-item"><strong>${pitchNameForOffset(tonic, index, mode)}</strong><span>${numerator}/${denominator}</span></div>` : '').join('')
  } else updateCustomTuningNames()
}

function updateCustomTuningNames(): void {
  const system = $('#scale-system').value as TuningSystem, tonic = Number($('#scale-tonic').value)
  const edo = clamp(2, Math.round(Number($('#scale-edo').value) || 12), 9999)
  document.querySelectorAll<HTMLElement>('#scale-interval-list [data-tuning-row]').forEach(row => {
    let value = NaN
    if (system === 'ratio') value = Number(row.querySelector<HTMLInputElement>('[data-part="n"]')?.value) / Number(row.querySelector<HTMLInputElement>('[data-part="d"]')?.value)
    else value = 2 ** (Number(row.querySelector<HTMLInputElement>('[data-part="steps"]')?.value) / edo)
    const valid = Number.isFinite(value) && value > 1 && value < 2
    row.querySelector<HTMLElement>('[data-tuning-name]')!.textContent = valid ? tuningPitchName(tonic, value) : '无效音程'
    row.querySelector<HTMLElement>('[data-tuning-cents]')!.textContent = valid ? `${(1200 * Math.log2(value)).toFixed(1)}¢` : '—'
  })
}

function addTuningInterval(): void {
  const system = $('#scale-system').value as TuningSystem, list = $('#scale-interval-list')
  if (list.children.length >= 512) return toast('一个调律表最多包含 512 个音程', true)
  let interval: TuningInterval | undefined
  if (system === 'edo') {
    const edo = clamp(2, Math.round(Number($('#scale-edo').value) || 12), 9999)
    const used = new Set([...list.querySelectorAll<HTMLInputElement>('[data-part="steps"]')].map(input => Number(input.value)))
    const steps = Array.from({ length: edo - 1 }, (_unused, index) => index + 1).find(value => !used.has(value))
    if (!steps) return toast('该 EDO 的所有步数都已添加', true)
    interval = { steps }
  } else {
    const defaults: Array<[number, number]> = [[16, 15], [9, 8], [6, 5], [5, 4], [4, 3], [45, 32], [3, 2], [8, 5], [5, 3], [7, 4], [15, 8]]
    const used = new Set([...list.querySelectorAll<HTMLElement>('[data-tuning-row]')].map(row => `${row.querySelector<HTMLInputElement>('[data-part="n"]')?.value}/${row.querySelector<HTMLInputElement>('[data-part="d"]')?.value}`))
    const ratio = defaults.find(([numerator, denominator]) => !used.has(`${numerator}/${denominator}`)) || [3, 2]
    interval = { numerator: ratio[0], denominator: ratio[1] }
  }
  list.insertAdjacentHTML('beforeend', tuningIntervalMarkup(system, interval)); updateCustomTuningNames()
}
function openScaleMenu(): void {
  const fromTrackView = !$('#track-view').classList.contains('hidden')
  closePopups(false); renderScaleMenu(); $('#scale-menu').classList.add('open')
  if (fromTrackView) $('#global-overlay').classList.add('open'); else $('#piano-overlay').style.visibility = 'visible'
}

function tuningDefinitionFromForm(): TuningDefinition {
  const system = $('#scale-system').value as TuningSystem, tonic = Number($('#scale-tonic').value)
  const mode = $('#scale-mode').value, edo = clamp(2, Math.round(Number($('#scale-edo').value) || 12), 9999)
  const harmonizeRatiosToEdo = system === 'edo' && ($('#scale-harmonize') as HTMLInputElement).checked
  const intervals: TuningInterval[] = []
  document.querySelectorAll<HTMLElement>('#scale-interval-list [data-tuning-row]').forEach(row => {
    if (system === 'ratio') {
      const ratio = parseRatio(row.querySelector<HTMLInputElement>('[data-part="n"]')?.value ?? '', row.querySelector<HTMLInputElement>('[data-part="d"]')?.value ?? '', 'up')
      const value = ratioValue(ratio); if (value <= 1 || value >= 2) throw new Error('自由纯律比例必须大于 1/1 且小于 2/1')
      intervals.push({ numerator: ratio.numerator, denominator: ratio.denominator })
    } else if (system === 'edo') {
      const steps = Number(row.querySelector<HTMLInputElement>('[data-part="steps"]')?.value)
      if (!Number.isInteger(steps) || steps <= 0 || steps >= edo) throw new Error(`EDO 步数必须是 1 到 ${edo - 1} 的整数`)
      intervals.push({ steps })
    }
  })
  const normalized = sanitizeTuningIntervals(intervals, system, edo)
  if (normalized.length !== intervals.length) throw new Error('调律表中存在重复音程')
  return normalizeTuningDefinition({ version: 1, tonic, system, mode, edo, harmonizeRatiosToEdo, intervals: normalized })
}

function applyScaleForm(): void {
  try { const definition = tuningDefinitionFromForm(); checkpoint(); applyTuningDefinition(project, definition); closePopups(); renderAll(); commit('调律表已应用') }
  catch (error) { toast(error instanceof Error ? error.message : '调律表无效', true) }
}

async function exportTuning(): Promise<void> {
  try {
    const definition = tuningDefinitionFromForm(), systemName = definition.system === 'preset' ? definition.mode : definition.system === 'ratio' ? '纯律' : `${definition.edo}EDO`
    const text = JSON.stringify({ ...definition, name: `${pitchNameForOffset(definition.tonic, 0)} ${systemName}` }, null, 2)
    if (window.desktop) { const result = await window.desktop.saveTuning({ name: systemName, text }); if (!result) return }
    else download(new TextEncoder().encode(text), `${systemName}.jituning`, 'application/json')
    toast('调律表已导出')
  } catch (error) { toast(error instanceof Error ? error.message : '调律表无效', true) }
}

async function importTuning(): Promise<void> {
  try {
    let text = ''
    if (window.desktop) { const file = await window.desktop.openTuning(); if (!file?.text) return; text = file.text }
    else {
      const input = $('#fallback-file') as HTMLInputElement; input.accept = '.jituning,.json'; input.value = ''
      const file = await new Promise<File | null>(resolve => { input.onchange = () => resolve(input.files?.[0] ?? null); input.click() }); if (!file) return; text = await file.text()
    }
    const definition = normalizeTuningDefinition(JSON.parse(text))
    checkpoint(); applyTuningDefinition(project, definition); renderScaleMenu(); renderAll(); commit(`已导入调律表${definition.name ? `：${definition.name}` : ''}`)
  } catch (error) { toast(`调律表导入失败：${error instanceof Error ? error.message : '文件无效'}`, true) }
}

function setDefaultTuning(): void {
  try {
    const definition = tuningDefinitionFromForm(); localStorage.setItem(DEFAULT_TUNING_KEY, JSON.stringify(definition))
    checkpoint(); applyTuningDefinition(project, definition); renderAll(); commit('已应用并设为新工程默认调律表')
  } catch (error) { toast(error instanceof Error ? error.message : '调律表无效', true) }
}

async function saveProject(): Promise<void> {
  try {
    project.name = $('#project-name').value.trim() || '未命名工程'
    if (window.desktop) { const result = await window.desktop.saveProject({ path: projectPath, name: project.name, text: serialize() }); if (!result) return; projectPath = result.path }
    else { const blob = new Blob([serialize()], { type: 'application/json' }), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `${project.name}.jidaw`; link.click(); URL.revokeObjectURL(url) }
    dirty = false; document.title = `${project.name} — 纯律和音图 DAW`; toast('工程已保存')
  } catch (error) { toast(error instanceof Error ? error.message : '保存失败', true) }
}
async function openProject(): Promise<void> {
  try {
    let text = '', path: string | undefined
    if (window.desktop) { const file = await window.desktop.openProject(); if (!file?.text) return; text = file.text; path = file.path }
    else {
      const input = $('#fallback-file') as HTMLInputElement; input.accept = '.jidaw,.json'; input.value = ''
      const file = await new Promise<File | null>(resolve => { input.onchange = () => resolve(input.files?.[0] ?? null); input.click() }); if (!file) return; text = await file.text()
    }
    audio.stop(); project = sanitizeProject(JSON.parse(text)); projectPath = path; activeTrackId = project.tracks[0].id; selectOnly(null); currentBeat = 0; history.length = 0; future.length = 0; dirty = false
    renderAll(); await Promise.all([restoreFonts(), restoreAudioClips()]); document.title = `${project.name} — 纯律和音图 DAW`; toast('工程已打开')
  } catch (error) { toast(`打开失败：${error instanceof Error ? error.message : '文件无效'}`, true) }
}

async function importMidi(): Promise<void> {
  try {
    if (dirty && !await confirmAction('导入 MIDI', '导入 MIDI 将替换当前工程。')) return
    let bytes: Uint8Array | null = null, fileName = 'MIDI 工程'
    if (window.desktop) {
      const file = await window.desktop.openMidi(); if (!file?.bytes) return
      bytes = toBytes(file.bytes); fileName = file.name || fileName
    } else {
      const input = $('#fallback-file') as HTMLInputElement; input.accept = '.mid,.midi,audio/midi'; input.value = ''
      const file = await new Promise<File | null>(resolve => { input.onchange = () => resolve(input.files?.[0] ?? null); input.click() }); if (!file) return
      bytes = new Uint8Array(await file.arrayBuffer()); fileName = file.name
    }
    const currentTuning: TuningDefinition = { version: 1, tonic: project.pitchTonic, system: project.tuningSystem, mode: project.pitchMode, edo: project.tuningEdo, harmonizeRatiosToEdo: project.harmonizeRatiosToEdo, intervals: project.tuningIntervals.map(interval => ({ ...interval })) }
    const midi = parseMidi(bytes), importedTracks: Track[] = []
    midi.tracks.forEach((source, sourceIndex) => {
      const channels = new Map<number, typeof source.notes>()
      for (const note of source.notes) { const notes = channels.get(note.channel) ?? []; notes.push(note); channels.set(note.channel, notes) }
      for (const [channel, notes] of channels) {
        const baseName = source.name || `轨道 ${sourceIndex + 1}`
        const track = channel === 9
          ? makeDrumTrack(importedTracks.length, channels.size > 1 ? `${baseName} · 鼓组` : baseName)
          : makeTrack(importedTracks.length, channels.size > 1 ? `${baseName} · Ch ${channel + 1}` : baseName)
        track.instrument.programIndex = notes[0]?.program ?? 0
        track.notes = notes.map(note => {
          const voice = channel === 9 ? drumVoiceFromMidi(note.pitch) : null
          return {
            id: uid('note'), trackId: track.id, beat: note.tick / midi.division,
            duration: Math.max(MIN_NOTE_DURATION, note.durationTicks / midi.division),
            frequency: voice ? 440 * 2 ** ((voice.midi - 69) / 12) : tunedFrequencyForMidiPitch(note.pitch + note.bendSemitones, project),
            velocity: Math.max(.01, note.velocity / 127), drumId: voice?.id
          }
        })
        importedTracks.push(track)
      }
    })
    if (!importedTracks.length) throw new Error('MIDI 文件中没有可导入的音符')
    checkpoint()
    const imported = makeProject(false), supportedSignatures = ['4/4', '3/4', '5/4', '6/8', '7/8']
    applyTuningDefinition(imported, currentTuning)
    imported.name = fileName.replace(/\.(mid|midi)$/i, '') || 'MIDI 工程'; imported.bpm = midi.bpm
    imported.signature = midi.signature && supportedSignatures.includes(midi.signature) ? midi.signature : '4/4'; imported.tracks = importedTracks
    const [top, bottom] = imported.signature.split('/').map(Number), barLength = top * 4 / bottom
    const endBeat = Math.max(...importedTracks.flatMap(track => track.notes.map(note => note.beat + note.duration)))
    imported.bars = clamp(4, Math.ceil(endBeat / barLength), 256)
    audio.stop(); project = imported; projectPath = undefined; activeTrackId = project.tracks[0].id; selectOnly(null); currentBeat = 0; currentNoteDuration = 1
    renderAll(); commit(`已导入 ${importedTracks.length} 条 MIDI 轨道`)
  } catch (error) { toast(`MIDI 导入失败：${error instanceof Error ? error.message : '文件无效'}`, true) }
}

function trackCodeDialog(): HTMLDialogElement { return $('#track-code-dialog') as HTMLDialogElement }

async function openTrackCodeExport(track: Track): Promise<void> {
  try {
    const code = await encodeTrackCode(project, track)
    $('#track-code-title').textContent = `轨道码 · ${track.name}`
    const field = $('#track-code-value') as HTMLTextAreaElement
    field.value = code; field.readOnly = true
    $('#track-code-import').classList.add('hidden'); $('#track-code-copy').classList.remove('hidden')
    const dialog = trackCodeDialog(); if (!dialog.open) dialog.showModal()
    field.select()
  } catch (error) { toast(`轨道码生成失败：${error instanceof Error ? error.message : '未知错误'}`, true) }
}

function openTrackCodeImport(): void {
  $('#track-code-title').textContent = '导入轨道码'
  const field = $('#track-code-value') as HTMLTextAreaElement
  field.value = ''; field.readOnly = false
  $('#track-code-import').classList.remove('hidden'); $('#track-code-copy').classList.add('hidden')
  const dialog = trackCodeDialog(); if (!dialog.open) dialog.showModal()
  requestAnimationFrame(() => field.focus())
}

function projectFromTrackCode(payload: TrackCodePayload): JiProject {
  const base = makeProject(false), context = payload.context || base
  const source = payload.track
  const rawTrack: Track = {
    id: uid('track'), type: source.type === 'drum' ? 'drum' : 'instrument', name: source.name, color: source.color, volume: source.volume, pan: source.pan,
    muted: false, solo: false, height: 78, instrument: source.instrument, eq: source.eq, reverb: source.reverb, drumVolumes: source.drumVolumes,
    notes: source.notes, annotations: source.annotations || [], audioClips: []
  }
  return sanitizeProject({
    ...base, name: source.name || '轨道码', bpm: context.bpm, signature: context.signature,
    snap: context.snap, bars: context.bars, swingEnabled: context.swingEnabled, swingAmount: context.swingAmount, pitchRatios: context.pitchRatios,
    pitchMode: context.pitchMode, pitchTonic: context.pitchTonic, tuningSystem: context.tuningSystem,
    tuningEdo: context.tuningEdo, harmonizeRatiosToEdo: context.harmonizeRatiosToEdo,
    tuningIntervals: context.tuningIntervals, tracks: [rawTrack]
  })
}

async function importTrackCode(): Promise<void> {
  const code = ($('#track-code-value') as HTMLTextAreaElement).value.trim()
  if (!code) return toast('请粘贴轨道码', true)
  try {
    const payload = await decodeTrackCode(code)
    if (dirty && !await confirmAction('导入轨道码', '导入轨道码将替换当前工程。')) return
    audio.stop(); project = projectFromTrackCode(payload)
    const [top, bottom] = project.signature.split('/').map(Number), barLength = top * 4 / bottom
    const endBeat = Math.max(0, ...project.tracks[0].notes.map(note => note.beat + note.duration))
    project.bars = clamp(4, Math.max(project.bars, Math.ceil(endBeat / barLength)), 256)
    projectPath = undefined; activeTrackId = project.tracks[0].id; selectOnly(null); currentBeat = 0; currentNoteDuration = 1
    history.length = 0; future.length = 0; trackCodeDialog().close(); renderAll(); void restoreFonts(); commit('轨道码已导入')
  } catch (error) { toast(`轨道码导入失败：${error instanceof Error ? error.message : '内容无效'}`, true) }
}

async function copyTrackCode(): Promise<void> {
  const field = $('#track-code-value') as HTMLTextAreaElement
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(field.value)
    else { field.select(); document.execCommand('copy') }
    toast('轨道码已复制')
  } catch { field.select(); document.execCommand('copy'); toast('轨道码已复制') }
}

function toast(message: string, error = false): void {
  const element = $('#toast'); element.textContent = message; element.style.borderColor = error ? '#b14a60' : '#ffffff25'; element.classList.add('show')
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => element.classList.remove('show'), 2500)
}
function confirmAction(title: string, message: string): Promise<boolean> {
  const dialog = $('#confirm-dialog') as unknown as HTMLDialogElement; $('#confirm-title').textContent = title; $('#confirm-message').textContent = message; dialog.showModal()
  return new Promise(resolve => {
    const finish = (value: boolean) => { dialog.close(); $('#confirm-ok').onclick = null; $('#confirm-cancel').onclick = null; resolve(value) }
    $('#confirm-ok').onclick = () => finish(true); $('#confirm-cancel').onclick = () => finish(false)
  })
}

// 多轨入口交互
trackRows.addEventListener('click', async event => {
  const target = event.target as HTMLElement, row = target.closest<HTMLElement>('[data-track-id]'); if (!row) return
  const track = project.tracks.find(item => item.id === row.dataset.trackId); if (!track) return
  activeTrackId = track.id; const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
  if (action === 'mixer') { openMixer(); return }
  if (action === 'resize' || action === 'instrument' || action === 'name' || action === 'volume') return
  if (action === 'export') { await openTrackCodeExport(track); return }
  if (action === 'mute' || action === 'solo') { checkpoint(); track[action === 'mute' ? 'muted' : 'solo'] = !track[action === 'mute' ? 'muted' : 'solo']; renderAll(); commit(); return }
  if (action === 'remove') {
    if (project.tracks.length === 1) return toast('至少保留一条轨道', true)
    if ((track.notes.length || track.audioClips.length) && !await confirmAction('删除轨道', `“${track.name}”中的内容也会删除。`)) return
    checkpoint(); project.tracks = project.tracks.filter(item => item.id !== track.id); activeTrackId = project.tracks[0].id; renderAll(); commit(); return
  }
  renderOverview()
})
trackRows.addEventListener('pointerdown', event => {
  const target = event.target as HTMLElement, action = target.closest<HTMLElement>('[data-action]')?.dataset.action
  if (action === 'volume') { checkpoint(); return }
  if (action !== 'resize') return
  const row = target.closest<HTMLElement>('[data-track-id]'), track = project.tracks.find(item => item.id === row?.dataset.trackId); if (!track) return
  event.preventDefault(); event.stopPropagation(); const startY = event.clientY, startHeight = track.height; let moved = false
  const move = (moveEvent: PointerEvent) => {
    if (!moved && Math.abs(moveEvent.clientY - startY) > 2) { checkpoint(); moved = true }
    track.height = clamp(56, startHeight + moveEvent.clientY - startY, 280); renderOverview()
  }
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); if (moved) commit() }
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up, { once: true })
})
trackRows.addEventListener('keydown', event => {
  if ((event.target as HTMLElement).matches('[data-action="volume"]') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) checkpoint()
})
trackRows.addEventListener('input', event => {
  const input = event.target as HTMLInputElement, row = input.closest<HTMLElement>('[data-track-id]'), track = project.tracks.find(item => item.id === row?.dataset.trackId); if (!track) return
  if (input.dataset.action === 'volume') { track.volume = Number(input.value); audio.syncTracks(project.tracks); commit() }
})
trackRows.addEventListener('change', async event => {
  const input = event.target as HTMLInputElement | HTMLSelectElement, row = input.closest<HTMLElement>('[data-track-id]'), track = project.tracks.find(item => item.id === row?.dataset.trackId); if (!track) return
  if (input.dataset.action === 'name') { checkpoint(); track.name = input.value.trim() || track.name; commit(); renderOverview(); return }
  if (input.dataset.action !== 'instrument') return
  activeTrackId = track.id
  if (input.value === 'bundled:touhou') { await chooseBundledSf2(track); return }
  if (track.type === 'drum' && DRUM_KITS.some(kit => kit.id === input.value)) {
    const kit = drumKit(input.value)
    checkpoint(); track.instrument = { kind: 'synth', synthId: kit.id, name: kit.name, programIndex: 0 }
    renderAll(); commit(`已切换为${kit.name}`); return
  }
  if (input.value === 'sf2-import') { await chooseSf2(track); renderOverview(); return }
  if (input.value.startsWith('sf2-program:')) {
    if (track.instrument.kind !== 'sf2' || !audio.hasFont(track.id)) return renderOverview()
    const index = Number(input.value.split(':')[1]), program = audio.getPrograms(track.id)[index]; if (!program) return renderOverview()
    checkpoint(); audio.selectProgram(track.id, index); track.instrument.programIndex = index; track.instrument.programName = program.name; track.instrument.missing = false
    renderAll(); commit(`已切换为 ${program.name || `SF2 音色 ${index + 1}`}`); return
  }
  checkpoint()
  if (input.value.startsWith('synth:')) {
    const definition = synthPreset(input.value.slice(6))
    track.instrument = { kind: 'synth', synthId: definition.id, name: definition.name, programIndex: 0 }
  }
  else {
    const definition = BUILTIN_INSTRUMENTS.find(item => item.id === input.value)
    if (!definition) return renderOverview()
    track.instrument = { kind: 'builtin', builtinId: definition.id, name: definition.name, programIndex: 0 }
  }
  renderAll(); commit(`已切换为${track.instrument.name}`)
})
overviewLanes.addEventListener('click', event => {
  const noteElement = (event.target as HTMLElement).closest<HTMLElement>('[data-note-id]'), lane = (event.target as HTMLElement).closest<HTMLElement>('[data-track-id]'); if (!lane) return
  const trackId = lane.dataset.trackId!
  const track = project.tracks.find(item => item.id === trackId)
  if (!track) return
  if (track.type === 'audio') { activeTrackId = track.id; selectOnly(null); renderOverview(); return }
  if ((event.ctrlKey || event.metaKey) && noteElement?.dataset.noteId) {
    if (activeTrackId !== trackId) selectOnly(null)
    activeTrackId = trackId
    const id = noteElement.dataset.noteId
    if (selectedNoteIds.has(id)) selectedNoteIds.delete(id); else selectedNoteIds.add(id)
    selectedNoteId = [...selectedNoteIds].at(-1) ?? null
    renderOverview(); return
  }
  openPiano(trackId, noteElement?.dataset.noteId)
})
overviewScroll.addEventListener('scroll', () => { trackRows.scrollTop = overviewScroll.scrollTop })
overviewRuler.addEventListener('pointerdown', event => {
  event.preventDefault(); event.stopPropagation(); const rect = overviewScroll.getBoundingClientRect()
  seekToBeat((event.clientX - rect.left + overviewScroll.scrollLeft) / 44)
})
$('#add-track').addEventListener('click', () => { checkpoint(); const track = makeTrack(project.tracks.length); project.tracks.push(track); activeTrackId = track.id; renderAll(); commit() })
$('#add-drum-track').addEventListener('click', () => { checkpoint(); const track = makeDrumTrack(project.tracks.length); project.tracks.push(track); activeTrackId = track.id; renderAll(); commit('已建立 FC 8-bit 808 鼓轨') })
$('#import-audio-track').addEventListener('click', importAudioTrack)

function makeDrumNote(track: Track, drumId: unknown, beat: number, velocity = .86): JiNote {
  const voice = drumVoice(drumId)
  return {
    id: uid('note'), trackId: track.id, drumId: voice.id, beat,
    duration: Math.max(MIN_NOTE_DURATION, Math.min(currentNoteDuration, totalBeats() - beat)),
    frequency: 440 * 2 ** ((voice.midi - 69) / 12), velocity
  }
}
function addDrumAt(clientX: number, clientY: number): void {
  const track = activeTrack(), rect = pianoCanvas.getBoundingClientRect(), voice = drumVoiceAt(clientY)
  if (track.type !== 'drum' || !voice || clientX - rect.left < DRUM_PAD_WIDTH) return
  const beat = clamp(0, snap(worldBeat(clientX)), totalBeats() - MIN_NOTE_DURATION)
  checkpoint()
  const note = makeDrumNote(track, voice.id, beat)
  track.notes.push(note); selectOnly(note.id); void auditionNote(track, note)
  renderPiano(); commit()
}
function handleDrumPad(event: PointerEvent): boolean {
  const target = event.target as HTMLElement
  if (target.closest('[data-drum-volume]')) { event.stopPropagation(); return true }
  const pad = target.closest<SVGGElement>('[data-drum-pad]')
  if (!pad?.dataset.drumPad) return false
  event.preventDefault(); event.stopPropagation()
  void auditionNote(activeTrack(), makeDrumNote(activeTrack(), pad.dataset.drumPad, 0, .92))
  return true
}

// 钢琴窗：点击添加、拖动编辑、拖动空白平移、滚轮缩放
pianoCanvas.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  const annotationElement = (event.target as HTMLElement).closest<HTMLElement>('[data-annotation-id]')
  const noteElement = (event.target as HTMLElement).closest<SVGGElement>('[data-note-id]')
  if (annotationElement) {
    event.stopPropagation()
    if (effectiveTool() === 'text') {
      const annotationId = annotationElement.dataset.annotationId || null
      if (annotationId !== editingAnnotationId) { event.preventDefault(); openInlineAnnotationEditor(annotationId, event.clientX, event.clientY) }
    } else event.preventDefault()
    return
  }
  if (globalPianoMode) {
    event.preventDefault(); event.stopPropagation()
    const startX = event.clientX, startY = event.clientY, originalX = view.offsetX, originalY = view.offsetY
    let panning = false
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX, dy = moveEvent.clientY - startY
      if (Math.abs(dx) + Math.abs(dy) > 4) panning = true
      if (panning) { pianoCanvas.classList.add('panning'); view.offsetX = originalX + dx; view.offsetY = originalY + dy; renderPiano() }
    }
    const up = (upEvent: PointerEvent) => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); pianoCanvas.classList.remove('panning')
      if (!panning) openInlineAnnotationEditor(null, upEvent.clientX, upEvent.clientY)
    }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up, { once: true })
    return
  }
  if (activeTrack().type === 'drum' && handleDrumPad(event)) return
  if (effectiveTool() === 'text') { event.preventDefault(); event.stopPropagation(); openInlineAnnotationEditor(null, event.clientX, event.clientY); return }
  if (effectiveTool() === 'select') {
    event.preventDefault(); event.stopPropagation()
    const rect = pianoCanvas.getBoundingClientRect(), startX = event.clientX - rect.left, startY = event.clientY - rect.top
    let moved = false
    selectionBox = { x1: startX, y1: startY, x2: startX, y2: startY }
    const move = (moveEvent: PointerEvent) => {
      const x = moveEvent.clientX - rect.left, y = moveEvent.clientY - rect.top
      if (Math.abs(x - startX) + Math.abs(y - startY) > 3) moved = true
      selectionBox = { x1: startX, y1: startY, x2: x, y2: y }; renderPiano()
    }
    const up = (upEvent: PointerEvent) => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up)
      const x = upEvent.clientX - rect.left, y = upEvent.clientY - rect.top
      if (moved) {
        const left = Math.min(startX, x), right = Math.max(startX, x), top = Math.min(startY, y), bottom = Math.max(startY, y)
        const selectionTrack = activeTrack(), frequencyCache = new Map<string, number>()
        const hits = selectionTrack.notes.filter(note => {
          const y = selectionTrack.type === 'drum' ? drumRowY(note.drumId) : screenY(effectiveNoteFrequency(note, selectionTrack, frequencyCache))
          return y >= top && y <= bottom && screenX(note.beat + note.duration) >= left && screenX(note.beat) <= right
        }).map(note => note.id)
        for (const id of hits) selectedNoteIds.add(id)
        selectedNoteId = hits.at(-1) ?? selectedNoteId
      } else if (noteElement?.dataset.noteId) {
        const id = noteElement.dataset.noteId
        selectedNoteIds.add(id); selectedNoteId = id
      }
      selectionBox = null; renderPiano()
    }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up, { once: true }); return
  }
  if (noteElement) {
    event.preventDefault(); event.stopPropagation(); const track = activeTrack(), note = track.notes.find(item => item.id === noteElement.dataset.noteId); if (!note) return
    if (selectedNoteIds.has(note.id)) selectedNoteId = note.id
    else selectOnly(note.id)
    renderPiano()
    const startX = event.clientX, startY = event.clientY, originalBeat = note.beat, originalDuration = note.duration
    const lineStart = screenX(note.beat), lineEnd = screenX(note.beat + note.duration)
    const pointerX = event.clientX - pianoCanvas.getBoundingClientRect().left
    const mode = Math.abs(pointerX - lineStart) <= Math.min(12, (lineEnd - lineStart) / 3) ? 'head' : Math.abs(pointerX - lineEnd) <= Math.min(12, (lineEnd - lineStart) / 3) ? 'tail' : 'body'
    const selectedNotes = track.notes.filter(item => selectedNoteIds.has(item.id))
    const selectedIds = new Set(selectedNotes.map(item => item.id)), timeIds = new Set(selectedIds)
    for (const selected of selectedNotes) for (const child of descendants(track, selected.id)) timeIds.add(child.id)
    const timeNotes = track.notes.filter(item => timeIds.has(item.id))
    const originalStates = new Map(timeNotes.map(item => [item.id, { beat: item.beat, duration: item.duration, frequency: item.frequency, drumId: item.drumId }]))
    const pitchRoots = selectedNotes.filter(item => !item.parentId)
    const shifted = $('#shift-mode').checked ? track.notes.filter(item => item.beat > originalBeat && !timeIds.has(item.id)) : []
    const shiftedBeats = new Map(shifted.map(item => [item.id, item.beat])); let moved = false, saved = false
    let appliedDelta = 0
    const applyHorizontalDelta = (requestedDelta: number) => {
      let minimum = -Infinity, maximum = Infinity
      if (mode === 'tail') {
        minimum = Math.max(...selectedNotes.map(item => MIN_NOTE_DURATION - originalStates.get(item.id)!.duration))
        maximum = Math.min(...selectedNotes.map(item => totalBeats() - originalStates.get(item.id)!.beat - originalStates.get(item.id)!.duration))
      } else if (mode === 'head') {
        minimum = Math.max(...timeNotes.map(item => -originalStates.get(item.id)!.beat))
        maximum = Math.min(
          ...selectedNotes.map(item => originalStates.get(item.id)!.duration - MIN_NOTE_DURATION),
          ...timeNotes.filter(item => !selectedIds.has(item.id)).map(item => totalBeats() - originalStates.get(item.id)!.beat - originalStates.get(item.id)!.duration)
        )
      } else {
        minimum = Math.max(...timeNotes.map(item => -originalStates.get(item.id)!.beat))
        maximum = Math.min(...timeNotes.map(item => totalBeats() - originalStates.get(item.id)!.beat - originalStates.get(item.id)!.duration))
      }
      if (shifted.length) {
        minimum = Math.max(minimum, ...shifted.map(item => -(shiftedBeats.get(item.id) ?? item.beat)))
        maximum = Math.min(maximum, ...shifted.map(item => totalBeats() - (shiftedBeats.get(item.id) ?? item.beat) - item.duration))
      }
      appliedDelta = clamp(minimum, requestedDelta, Math.max(minimum, maximum))
      if (mode === 'tail') for (const item of selectedNotes) item.duration = originalStates.get(item.id)!.duration + appliedDelta
      else if (mode === 'head') for (const item of timeNotes) {
        const original = originalStates.get(item.id)!
        item.beat = original.beat + appliedDelta
        if (selectedIds.has(item.id)) item.duration = original.duration - appliedDelta
      }
      else for (const item of timeNotes) item.beat = originalStates.get(item.id)!.beat + appliedDelta
      for (const item of shifted) item.beat = (shiftedBeats.get(item.id) ?? item.beat) + appliedDelta
    }
    const move = (moveEvent: PointerEvent) => {
      const dxBeats = (moveEvent.clientX - startX) / (48 * view.scale), dyWorld = (moveEvent.clientY - startY) / view.scale
      if (Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) > 3) moved = true
      if (!moved) return
      if (!saved) { checkpoint(); saved = true }
      applyHorizontalDelta(dxBeats)
      if (mode === 'body' && track.type === 'drum') {
        const indexOf = (item: JiNote) => DRUM_VOICES.findIndex(voice => voice.id === originalStates.get(item.id)!.drumId)
        const delta = clamp(-Math.min(...selectedNotes.map(indexOf)), Math.round(dyWorld / DRUM_ROW_HEIGHT), DRUM_VOICES.length - 1 - Math.max(...selectedNotes.map(indexOf)))
        for (const item of selectedNotes) {
          const voice = DRUM_VOICES[indexOf(item) + delta]
          item.drumId = voice.id; item.frequency = 440 * 2 ** ((voice.midi - 69) / 12)
        }
      }
      else if (mode === 'body') for (const root of pitchRoots) {
        const original = originalStates.get(root.id)!
        root.frequency = clamp(8, yToHz(hzToY(original.frequency) + dyWorld), 24000)
        recalculateChildren(track, root.id)
      }
      renderPiano()
    }
    const up = (upEvent: PointerEvent) => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up)
      if (!moved) return showNoteMenu(note.id, upEvent.clientX, upEvent.clientY)
      const snappedDelta = mode === 'tail'
        ? Math.max(project.snap || MIN_NOTE_DURATION, snap(originalDuration + appliedDelta)) - originalDuration
        : snap(originalBeat + appliedDelta) - originalBeat
      applyHorizontalDelta(snappedDelta)
      if (mode === 'body' && track.type !== 'drum') for (const root of pitchRoots) { root.frequency = snapFrequency(root.frequency); recalculateChildren(track, root.id) }
      if (mode === 'tail' || mode === 'head') currentNoteDuration = note.duration
      renderPiano(); commit()
    }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up, { once: true }); return
  }
  const startX = event.clientX, startY = event.clientY, originalX = view.offsetX, originalY = view.offsetY; let panning = false
  const move = (moveEvent: PointerEvent) => {
    const dx = moveEvent.clientX - startX, dy = moveEvent.clientY - startY
    if (Math.abs(dx) + Math.abs(dy) > 4) panning = true
    if (panning) { pianoCanvas.classList.add('panning'); view.offsetX = originalX + dx; view.offsetY = originalY + dy; renderPiano() }
  }
  const up = (upEvent: PointerEvent) => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); pianoCanvas.classList.remove('panning')
    if (!panning) { if (activeTrack().type === 'drum') addDrumAt(upEvent.clientX, upEvent.clientY); else addRootAt(upEvent.clientX, upEvent.clientY) }
  }
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up, { once: true })
})
pianoCanvas.addEventListener('wheel', event => {
  event.preventDefault(); finishInlineAnnotation(false); const rect = pianoCanvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top
  const old = view.scale, next = clamp(.45, old * Math.exp(-event.deltaY * .001), 2.6), worldX = (x - view.offsetX) / old, worldY = (y - view.offsetY) / old
  view.scale = next; view.offsetX = x - worldX * next; view.offsetY = y - worldY * next; renderPiano()
}, { passive: false })
pianoRuler.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); seekToBeat(worldBeat(event.clientX)) })

// 钢琴窗内联文本注释；仅在拖选文字后显示格式栏。
function syncInlineAnnotation(): void {
  const editor = annotationEditorElement(); if (!editor || !editingAnnotationId) return
  const found = findAnnotation(editingAnnotationId); if (!found) return
  found.annotation.html = editor.innerHTML; dirty = true
}
function updateAnnotationFormat(): void {
  const editor = annotationEditorElement(), selection = getSelection(), format = $('#annotation-format')
  if (!editor || !selection?.rangeCount || selection.isCollapsed || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) {
    if (annotationSelection && format.contains(document.activeElement)) return
    return hideAnnotationFormat()
  }
  const range = selection.getRangeAt(0), rect = range.getBoundingClientRect()
  if (!rect.width && !rect.height) return hideAnnotationFormat()
  annotationSelection = range.cloneRange(); format.classList.add('open')
  const width = format.offsetWidth || 190, height = format.offsetHeight || 38
  format.style.left = `${clamp(8, rect.left + rect.width / 2 - width / 2, Math.max(8, innerWidth - width - 8))}px`
  const below = rect.bottom + 8, above = rect.top - height - 8
  format.style.top = `${above >= 54 ? above : clamp(54, below, innerHeight - height - 70)}px`
}
function restoreAnnotationSelection(): void {
  const editor = annotationEditorElement(); if (!editor || !annotationSelection) return
  editor.focus(); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(annotationSelection)
}
pianoCanvas.addEventListener('input', event => {
  if (!(event.target as HTMLElement).closest('.piano-annotation[data-editing="true"]')) return
  syncInlineAnnotation(); updateAnnotationFormat()
})
pianoCanvas.addEventListener('keyup', event => {
  if (!(event.target as HTMLElement).closest('.piano-annotation[data-editing="true"]')) return
  if (event.key === 'Escape') { event.preventDefault(); finishInlineAnnotation(); return }
  updateAnnotationFormat()
})
pianoCanvas.addEventListener('mouseup', event => {
  if ((event.target as HTMLElement).closest('.piano-annotation[data-editing="true"]')) requestAnimationFrame(updateAnnotationFormat)
})
document.addEventListener('selectionchange', () => requestAnimationFrame(updateAnnotationFormat))
document.querySelectorAll<HTMLButtonElement>('#annotation-format [data-rich-command]').forEach(button => {
  button.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation() })
  button.addEventListener('click', event => {
    event.stopPropagation(); restoreAnnotationSelection(); document.execCommand(button.dataset.richCommand || '', false); syncInlineAnnotation(); updateAnnotationFormat()
  })
})
$('#annotation-color').addEventListener('pointerdown', event => event.stopPropagation())
$('#annotation-color').addEventListener('input', event => {
  event.stopPropagation(); restoreAnnotationSelection(); document.execCommand('foreColor', false, $('#annotation-color').value); syncInlineAnnotation(); updateAnnotationFormat()
})
document.addEventListener('pointerdown', event => {
  if (!editingAnnotationId) return
  const target = event.target as HTMLElement
  if (target.closest('#annotation-format,.piano-annotation[data-editing="true"]')) return
  finishInlineAnnotation()
})

// 音符菜单
document.querySelectorAll('.audition-button').forEach(button => button.addEventListener('click', () => { const found = findNote(selectedNoteId); if (found) void auditionNote(found.track, found.note) }))
$('#piano-overlay').addEventListener('pointerdown', () => {
  if (document.activeElement === $('#root-hz')) commitFrequencyEdit('#root-hz')
  else if (document.activeElement === $('#note-hz')) commitFrequencyEdit('#note-hz')
  closePopups(true)
}); document.querySelectorAll('.close-popup').forEach(button => button.addEventListener('click', () => closePopups()))
$('#root-add-ratio').addEventListener('click', () => { const found = findNote(selectedNoteId); if (found) addRatioChild(found.note, found.track, '#root-numerator', '#root-denominator', '#root-direction') })
$('#root-move-ratio').addEventListener('click', () => moveSelectedByRatio('#root-move-numerator', '#root-move-denominator', '#root-move-direction'))
$('#note-move-ratio').addEventListener('click', () => moveSelectedByRatio('#note-move-numerator', '#note-move-denominator', '#note-move-direction'))
$('#note-extend-ratio').addEventListener('click', () => { const found = findNote(selectedNoteId); if (found) addRatioChild(found.note, found.track, '#extend-numerator', '#extend-denominator', '#extend-direction') })
const ratioTargetFields: Record<string, [string, string]> = {
  root: ['#root-numerator', '#root-denominator'], 'root-move': ['#root-move-numerator', '#root-move-denominator'],
  'note-move': ['#note-move-numerator', '#note-move-denominator'], 'note-add': ['#extend-numerator', '#extend-denominator']
}
function fillPresetRatio(target: string, ratio: string): void {
  const ids = ratioTargetFields[target]; if (!ids) return
  const [numerator, denominator] = ratio.split('/'); $(ids[0]).value = numerator; $(ids[1]).value = denominator
}
document.querySelectorAll<HTMLButtonElement>('.ratio-quick [data-prime]').forEach(button => button.addEventListener('click', () => {
  const group = button.closest<HTMLElement>('.ratio-quick')!, target = group.dataset.target || '', prime = Number(button.dataset.prime)
  document.querySelectorAll('.ratio-preset-panel').forEach(panel => panel.classList.remove('open'))
  group.querySelectorAll('button').forEach(item => item.classList.toggle('selected', item === button))
  const defaultRatio = PRIME_DEFAULT_RATIOS[prime]; if (defaultRatio) fillPresetRatio(target, defaultRatio)
  if (prime === 2) { requestAnimationFrame(repositionOpenNoteMenu); return }
  const panel = document.querySelector<HTMLElement>(`.ratio-preset-panel[data-for="${target}"]`); if (!panel) return
  panel.innerHTML = (INTERVAL_PRESETS[prime] || []).map(([ratio, name]) => `<button class="${ratio === defaultRatio ? 'selected' : ''}" data-preset-ratio="${ratio}"><strong>${ratio}</strong><span>${name}</span></button>`).join('')
  panel.classList.add('open'); requestAnimationFrame(repositionOpenNoteMenu)
  panel.querySelectorAll<HTMLButtonElement>('[data-preset-ratio]').forEach(preset => preset.addEventListener('click', () => {
    fillPresetRatio(target, preset.dataset.presetRatio!); panel.classList.remove('open'); requestAnimationFrame(repositionOpenNoteMenu)
  }))
}))
$('#root-delete').addEventListener('click', deleteSelected); $('#note-delete').addEventListener('click', deleteSelected)
for (const selector of ['#root-copy', '#copy-note', '#overview-copy']) $(selector).addEventListener('click', copySelectedNotes)
for (const selector of ['#paste-note', '#overview-paste']) $(selector).addEventListener('click', pasteSelectedNotes)
function commitFrequencyEdit(fieldSelector: '#root-hz' | '#note-hz'): void {
  const field = $(fieldSelector), found = findNote(field.dataset.noteId || selectedNoteId); if (!found) return
  const entered = field.textContent?.trim() || ''
  if (entered === field.dataset.displayedValue) return
  const value = Number(entered)
  if (!Number.isFinite(value) || value < 8 || value > 24000) return showNoteMenu(found.note.id, innerWidth / 2, innerHeight / 2)
  let root = found.note, parent = found.note
  const visited = new Set<string>()
  while (parent.parentId && parent.ratio && !visited.has(parent.id)) {
    visited.add(parent.id)
    const next = found.track.notes.find(note => note.id === parent.parentId); if (!next) break
    root = next; parent = next
  }
  const currentFrequency = effectiveNoteFrequency(found.note, found.track)
  const nextRootFrequency = root.frequency * value / currentFrequency
  if (!Number.isFinite(nextRootFrequency) || nextRootFrequency < 8 || nextRootFrequency > 24000) {
    toast('调整后根音频率超出 8–24000 Hz', true); return showNoteMenu(found.note.id, innerWidth / 2, innerHeight / 2)
  }
  checkpoint(); root.frequency = nextRootFrequency; recalculateChildren(found.track, root.id); renderPiano(); commit()
  const frequency = effectiveNoteFrequency(found.note, found.track), text = frequency.toFixed(3)
  field.textContent = text; field.dataset.displayedValue = text
  if (found.note.parentId && found.note.ratio) {
    $('#note-name-ratio').textContent = `${noteName(found.note, found.track)} · ${ratioText(found.note)}`
    renderEdoPosition('#note-edo-position', found.note, frequency)
  } else {
    $('#root-note-name').textContent = noteName(found.note, found.track)
    renderEdoPosition('#root-edo-position', found.note, frequency)
  }
}
for (const selector of ['#root-hz', '#note-hz'] as const) {
  $(selector).addEventListener('blur', () => commitFrequencyEdit(selector))
  $(selector).addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); commitFrequencyEdit(selector); $(selector).blur() }
    else if (event.key === 'Escape') { event.preventDefault(); $(selector).textContent = $(selector).dataset.displayedValue || ''; $(selector).blur() }
  })
}
function bindVolume(inputId: string): void { $(inputId).addEventListener('change', () => { const found = findNote(selectedNoteId); if (!found) return; checkpoint(); found.note.velocity = Number($(inputId).value) / 100; found.note.muted = false; renderPiano(); commit() }) }
bindVolume('#root-volume'); bindVolume('#note-volume')
function bindMute(buttonId: string): void { $(buttonId).addEventListener('click', () => { const found = findNote(selectedNoteId); if (!found) return; checkpoint(); found.note.muted = !found.note.muted; $(buttonId).classList.toggle('active', Boolean(found.note.muted)); renderPiano(); commit() }) }
bindMute('#root-mute'); bindMute('#note-mute')
function bindNoteColor(inputId: string, resetId: string): void {
  $(inputId).addEventListener('change', () => { const found = findNote(selectedNoteId); if (!found) return; checkpoint(); found.note.color = $(inputId).value; renderAll(); commit('音符颜色已更新') })
  $(resetId).addEventListener('click', () => { const found = findNote(selectedNoteId); if (!found) return; checkpoint(); delete found.note.color; $(inputId).value = '#ffffff'; renderAll(); commit('已恢复默认音符颜色') })
}
bindNoteColor('#root-color', '#root-color-reset'); bindNoteColor('#note-color', '#note-color-reset')

// 设置与运输栏
$('#settings-snap').addEventListener('change', () => { checkpoint(); project.snap = Number($('#settings-snap').value); $('#snap-select').value = String(project.snap); renderPiano(); commit() })
$('#settings-reset-view').addEventListener('click', () => { centrePiano(activeTrack()); renderPiano(); closePopups(false) })
$('#global-settings').addEventListener('click', openGlobalSettings); $('#global-overlay').addEventListener('pointerdown', () => closePopups(false)); $('#global-scale').addEventListener('click', openScaleMenu)
$('#global-bpm').addEventListener('change', () => { const value = Number($('#global-bpm').value); if (value < 20 || value > 400) return toast('BPM 范围为 20–400', true); checkpoint(); project.bpm = value; renderAll(); commit() })
$('#global-signature').addEventListener('change', () => { checkpoint(); project.signature = $('#global-signature').value; renderAll(); commit() })
$('#global-bars').addEventListener('change', () => { checkpoint(); project.bars = clamp(4, Math.round(Number($('#global-bars').value) || project.bars), 256); renderAll(); commit() })
$('#global-snap').addEventListener('change', () => { checkpoint(); project.snap = Number($('#global-snap').value); renderAll(); commit() })
$('#global-swing').addEventListener('change', () => { checkpoint(); project.swingEnabled = ($('#global-swing') as HTMLInputElement).checked; renderGlobalSettings(); commit() })
$('#global-swing-amount').addEventListener('input', () => { $('#global-swing-value').textContent = `${Math.round(Number($('#global-swing-amount').value))}%` })
$('#global-swing-amount').addEventListener('change', () => { checkpoint(); project.swingAmount = clamp(0, Number($('#global-swing-amount').value), 100); renderGlobalSettings(); commit() })
$('#global-metronome').addEventListener('change', () => { checkpoint(); project.metronome = ($('#global-metronome') as HTMLInputElement).checked; commit() })
$('#scale-apply').addEventListener('click', applyScaleForm); $('#scale-import').addEventListener('click', importTuning); $('#scale-export').addEventListener('click', exportTuning); $('#scale-default').addEventListener('click', setDefaultTuning)
$('#scale-mode').addEventListener('change', updateScaleEditor); $('#scale-tonic').addEventListener('change', updateScaleEditor); $('#scale-edo').addEventListener('input', updateCustomTuningNames)
$('#scale-system').addEventListener('change', () => { $('#scale-interval-list').innerHTML = ''; updateScaleEditor() }); $('#scale-add-interval').addEventListener('click', addTuningInterval)
$('#scale-interval-list').addEventListener('input', updateCustomTuningNames); $('#scale-interval-list').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="remove-tuning"]'); if (!button) return; button.closest('[data-tuning-row]')?.remove(); updateCustomTuningNames() })
$('#piano-settings').addEventListener('click', openSettings); $('#back-to-tracks').addEventListener('click', closePiano); $('#open-global-piano').addEventListener('click', openGlobalPiano)
$('#tool-pen').addEventListener('click', () => { activeTool = 'pen'; updateToolUi() })
$('#tool-select').addEventListener('click', () => { activeTool = 'select'; updateToolUi() })
$('#tool-text').addEventListener('click', () => { activeTool = 'text'; updateToolUi() })
$('#piano-follow').addEventListener('click', cyclePlaybackFollow)
for (const selector of ['#overview-play', '#piano-play']) $(selector).addEventListener('click', togglePlay)
for (const selector of ['#overview-stop', '#piano-stop']) $(selector).addEventListener('click', stopPlayback)
for (const selector of ['#overview-loop', '#piano-loop']) $(selector).addEventListener('click', () => { checkpoint(); project.loop = !project.loop; renderAll(); commit() })
$('#piano-undo').addEventListener('click', undo); $('#undo-button').addEventListener('click', undo); $('#redo-button').addEventListener('click', redo)

// 工程与全局设置
$('#save-project').addEventListener('click', saveProject); $('#open-project').addEventListener('click', openProject); $('#import-midi').addEventListener('click', importMidi); $('#export-midi').addEventListener('click', exportMidiFile); $('#export-mp3').addEventListener('click', exportMp3File)
$('#save-export-log').addEventListener('click', () => { void saveExportLog() })
$('#import-track-code').addEventListener('click', openTrackCodeImport)
$('#track-code-close').addEventListener('click', () => trackCodeDialog().close())
$('#track-code-copy').addEventListener('click', copyTrackCode)
$('#track-code-import').addEventListener('click', importTrackCode)
$('#new-project').addEventListener('click', async () => { if (dirty && !await confirmAction('新建工程', '当前未保存的修改将被清空。')) return; audio.stop(); project = makeProject(false); activeTrackId = project.tracks[0].id; selectOnly(null); projectPath = undefined; history.length = 0; future.length = 0; currentBeat = 0; renderAll(); commit() })
$('#project-name').addEventListener('change', () => { checkpoint(); project.name = $('#project-name').value.trim() || '未命名工程'; commit() })
$('#bpm-input').addEventListener('change', () => { const value = Number($('#bpm-input').value); if (value < 20 || value > 400) { $('#bpm-input').value = String(project.bpm); return toast('BPM 范围为 20–400', true) } checkpoint(); project.bpm = value; commit() })
$('#signature-select').addEventListener('change', () => { checkpoint(); project.signature = $('#signature-select').value; renderAll(); commit() })
$('#snap-select').addEventListener('change', () => { checkpoint(); project.snap = Number($('#snap-select').value); renderPiano(); commit() })

document.addEventListener('keydown', event => {
  if (event.key === 'Control') { controlHeld = true; updateToolUi(); return }
  const editing = ['INPUT', 'SELECT'].includes((event.target as HTMLElement).tagName) || (event.target as HTMLElement).isContentEditable
  if (event.key === 'Escape') { closePopups(true); return }
  if (editing) return
  if (event.code === 'Space') { event.preventDefault(); togglePlay() }
  if (globalPianoMode) {
    if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); saveProject() }
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected()
  if (!event.ctrlKey && event.key.toLowerCase() === 'p') { activeTool = 'pen'; updateToolUi() }
  if (!event.ctrlKey && event.key.toLowerCase() === 'v') { activeTool = 'select'; updateToolUi() }
  if (!event.ctrlKey && event.key.toLowerCase() === 't') { activeTool = 'text'; updateToolUi() }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelectedNotes() }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); selectAllNotes() }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'x') { event.preventDefault(); cutSelectedNotes() }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteSelectedNotes() }
  if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); saveProject() }
  if (event.ctrlKey && event.key.toLowerCase() === 'o') { event.preventDefault(); openProject() }
  if (event.ctrlKey && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
})
document.addEventListener('keyup', event => { if (event.key === 'Control') { controlHeld = false; updateToolUi(false) } })
window.addEventListener('blur', () => { controlHeld = false; updateToolUi(false) })
new ResizeObserver(() => repositionOpenNoteMenu()).observe($('#root-menu'))
new ResizeObserver(() => repositionOpenNoteMenu()).observe($('#note-menu'))
window.addEventListener('resize', () => { renderOverview(); renderPiano(); repositionOpenNoteMenu() })
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = '' } })

updateToolUi(); renderAll(); void Promise.all([restoreFonts(), restoreAudioClips()])
