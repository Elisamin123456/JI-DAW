import { AudioEngine, BUILTIN_INSTRUMENTS } from './audio'
import { parseMidi } from './midi'
import { exportMidi } from './midi-export'
import { intervalConnectionStyle, parseRatio, primeLimit, ratioValue } from './ratio'
import { decodeTrackCode, encodeTrackCode, type TrackCodePayload } from './track-code'
import { generateTwelveToneRatios, isLegacyPitchRatios, NATURAL_PITCH_CLASSES, nearestTunedFrequency, PITCH_MODES, pitchClassSpelling, pitchNameForOffset, tunedFrequencyForMidiPitch, tuningPitches, tuningPitchName } from './tuning'
import type { JiAnnotation, JiNote, JiProject, RatioSpec, Track, TuningInterval, TuningSystem } from './types'

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
  target.tuningIntervals = definition.intervals.map(interval => ({ ...interval }))
  target.pitchMode = definition.mode
  if (definition.system === 'preset') target.pitchRatios = generateTwelveToneRatios(definition.mode)
}

function makeTrack(index: number, name = `轨道 ${index + 1}`): Track {
  return { id: uid('track'), name, color: TRACK_COLORS[index % TRACK_COLORS.length], volume: .8, pan: 0, muted: false, solo: false, height: 78, instrument: { kind: 'builtin', builtinId: 'salamander-piano', name: 'Salamander Grand Piano', programIndex: 0 }, notes: [], annotations: [] }
}

function makeProject(_demo = false): JiProject {
  const tracks = [makeTrack(0, '钢琴')]
  const created: JiProject = { version: 2, name: '我的纯律工程', bpm: 120, signature: '4/4', snap: 1, bars: 16, loop: true, metronome: false, pitchRatios: generateTwelveToneRatios('chromatic'), pitchMode: 'chromatic', pitchTonic: 0, tuningSystem: 'preset', tuningEdo: 12, tuningIntervals: [], tracks }
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
    snap: [0, .25, .5, 1, 2].includes(Number(input.snap)) ? Number(input.snap) : 1,
    bars: clamp(4, Math.round(Number(input.bars) || 16), 256), loop: input.loop !== false, metronome: Boolean(input.metronome),
    pitchRatios, pitchMode,
    pitchTonic: clamp(0, Math.round(Number(input.pitchTonic) || 0), 11), tuningSystem, tuningEdo, tuningIntervals, tracks: []
  }
  project.tracks = input.tracks.slice(0, 64).map((rawTrack, index) => {
    const source = rawTrack as Track
    const builtinId = source.instrument?.builtinId || 'salamander-piano'
    const builtin = BUILTIN_INSTRUMENTS.find(item => item.id === builtinId) || BUILTIN_INSTRUMENTS[0]
    const track: Track = {
      id: typeof source.id === 'string' ? source.id : uid('track'), name: typeof source.name === 'string' ? source.name.slice(0, 80) : `轨道 ${index + 1}`,
      color: /^#[0-9a-f]{6}$/i.test(source.color ?? '') ? source.color : TRACK_COLORS[index % TRACK_COLORS.length],
      volume: clamp(0, Number(source.volume) || 0, 1.25), pan: clamp(-1, Number(source.pan) || 0, 1), muted: Boolean(source.muted), solo: Boolean(source.solo), height: clamp(56, Number(source.height) || 78, 280),
      instrument: source.instrument?.kind === 'sf2'
        ? { kind: 'sf2', name: String(source.instrument.name || 'SoundFont'), path: source.instrument.path, programIndex: Math.max(0, Math.round(source.instrument.programIndex || 0)), programName: source.instrument.programName, missing: true }
        : source.instrument?.kind === 'synth'
          ? { kind: 'synth', name: '基础合成器', programIndex: 0 }
          : { kind: 'builtin', builtinId: builtin.id, name: builtin.name, programIndex: 0 }, notes: [], annotations: []
    }
    track.notes = Array.isArray(source.notes) ? source.notes.slice(0, 10000).map(rawNote => {
      const note = rawNote as JiNote
      let ratio: RatioSpec | undefined
      if (note.ratio) ratio = parseRatio(note.ratio.numerator, note.ratio.denominator, note.ratio.direction === 'down' ? 'down' : 'up')
      return {
        id: typeof note.id === 'string' ? note.id : uid('note'), trackId: track.id,
        beat: Math.max(0, Number(note.beat) || 0), duration: Math.max(.05, Number(note.duration) || 1),
        frequency: clamp(8, Number(note.frequency) || 440, 24000), velocity: clamp(.01, Number(note.velocity) || .8, 1),
        muted: Boolean(note.muted), ghost: Boolean(note.ghost), parentId: typeof note.parentId === 'string' ? note.parentId : undefined, ratio,
        color: /^#[0-9a-f]{6}$/i.test(note.color ?? '') ? note.color : undefined
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
    return track
  })
  if (!project.tracks.length) project.tracks.push(makeTrack(0))
  const first = project.tracks[0]
  for (const other of project.tracks.slice(1)) {
    first.notes.push(...other.notes.map(note => ({ ...note, trackId: first.id })))
    first.annotations.push(...other.annotations.map(annotation => ({ ...annotation, trackId: first.id })))
  }
  project.tracks = [first]
  return project
}

function loadAutosave(): JiProject | null {
  try { const value = localStorage.getItem('ji-daw-web-autosave-v2'); return value ? sanitizeProject(JSON.parse(value)) : null } catch { return null }
}

const autosavedProject = loadAutosave()
let project = autosavedProject ?? makeProject()
let activeTrackId = project.tracks[0].id
let selectedNoteId: string | null = null
let selectedNoteIds = new Set<string>()
let activeTool: 'pen' | 'select' | 'text' = 'pen'
let controlHeld = false
let selectionBox: { x1: number; y1: number; x2: number; y2: number } | null = null
let currentBeat = 0
let currentNoteDuration = 1
type PlaybackFollowMode = 'off' | 'locked' | 'page'
let playbackFollowMode: PlaybackFollowMode = 'off'
let lastFollowRender = 0
let editingAnnotationId: string | null = null
let annotationSelection: Range | null = null
let annotationOriginalHtml = ''
let annotationWasNew = false
let dirty = false
let toastTimer = 0
let clipboardNotes: JiNote[] | null = null
let tutorialIndex = -1
const history: string[] = []
const future: string[] = []
const view = { offsetX: 80, offsetY: 0, scale: 1 }

const pianoCanvas = $('#piano-canvas')
const pianoSvg = $('#piano-svg') as unknown as SVGSVGElement
const pianoRuler = $('#piano-ruler')
const pianoRulerContent = $('#piano-ruler-content')

function beatsPerBar(): number { const [top, bottom] = project.signature.split('/').map(Number); return top * 4 / bottom }
function totalBeats(): number { return project.bars * beatsPerBar() }
function activeTrack(): Track { return project.tracks.find(track => track.id === activeTrackId) ?? project.tracks[0] }
function findNote(id: string | null): { note: JiNote; track: Track } | null {
  if (!id) return null
  for (const track of project.tracks) { const note = track.notes.find(item => item.id === id); if (note) return { note, track } }
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
  if (!note.parentId || !note.ratio || visiting.has(note.id)) { const root = rootSpelling(note.frequency); cache.set(note.id, root); return root }
  const parent = track.notes.find(item => item.id === note.parentId)
  if (!parent) { const root = rootSpelling(note.frequency); cache.set(note.id, root); return root }
  visiting.add(note.id)
  const parentPitch = spelledNote(parent, track, cache, visiting)
  const direction = note.ratio.direction === 'down' ? -1 : 1
  const absoluteLetter = parentPitch.octave * 7 + parentPitch.letter + direction * intervalDiatonicSteps(note.ratio)
  const letter = ((absoluteLetter % 7) + 7) % 7, octave = Math.floor(absoluteLetter / 7)
  const midi = Math.round(69 + 12 * Math.log2(note.frequency / 440)), pitchClass = ((midi % 12) + 12) % 12
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
function ratioText(note: JiNote): string { return note.ratio ? `${note.ratio.direction === 'down' ? '↓' : ''}${note.ratio.numerator}/${note.ratio.denominator}` : '' }
function snap(value: number): number { return project.snap ? Math.round(value / project.snap) * project.snap : value }
function snapFrequency(value: number): number {
  return nearestTunedFrequency(value, project)
}
function selectOnly(id: string | null): void {
  selectedNoteId = id
  selectedNoteIds = id ? new Set([id]) : new Set()
}
function effectiveTool(): 'pen' | 'select' | 'text' { return controlHeld ? 'select' : activeTool }
function updateToolUi(): void {
  const tool = effectiveTool()
  if (pianoCanvas.dataset.tool === 'select' && tool !== 'select') {
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
  const url = URL.createObjectURL(new Blob([copy.buffer], { type })), link = document.createElement('a')
  link.href = url; link.download = fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
}
function pickFile(accept: string): Promise<File | null> {
  const input = $('#fallback-file') as HTMLInputElement; input.accept = accept; input.value = ''
  return new Promise(resolve => { input.onchange = () => resolve(input.files?.[0] ?? null); input.click() })
}
function exportMidiFile(): void {
  try { download(exportMidi(project), `${project.name || '未命名工程'}.mid`, 'audio/midi'); toast('MIDI 已导出') }
  catch (error) { toast(`MIDI 导出失败：${error instanceof Error ? error.message : '未知错误'}`, true) }
}
async function exportMp3File(): Promise<void> {
  const button = $('#export-mp3') as HTMLButtonElement
  if (button.disabled) return
  const label = button.textContent || '导出 MP3'
  button.disabled = true
  try {
    audio.stop(); setPlayState(false); button.textContent = '渲染中…'; toast('正在离线渲染音频…')
    const rendered = await audio.render(project)
    button.textContent = '编码中…'
    const { encodeMp3 } = await import('./mp3-export')
    const bytes = await encodeMp3(rendered)
    download(bytes, `${project.name || '未命名工程'}.mp3`, 'audio/mpeg'); toast('MP3 已导出')
  } catch (error) { toast(`MP3 导出失败：${error instanceof Error ? error.message : '未知错误'}`, true) }
  finally { button.disabled = false; button.textContent = label }
}

function checkpoint(): void {
  const now = JSON.stringify(project)
  if (history.at(-1) !== now) history.push(now)
  if (history.length > 100) history.shift()
  future.length = 0
}
function commit(message?: string): void {
  dirty = true; localStorage.setItem('ji-daw-web-autosave-v2', JSON.stringify(project)); document.title = `● ${project.name} — 纯律和音图 Web`
  if (message) toast(message)
}
function undo(): void {
  const previous = history.pop(); if (!previous) return toast('没有可撤销的操作')
  future.push(JSON.stringify(project)); project = sanitizeProject(JSON.parse(previous)); selectOnly(null)
  if (!project.tracks.some(track => track.id === activeTrackId)) activeTrackId = project.tracks[0].id
  audio.stop(); renderAll(); commit('已撤销')
}
function redo(): void {
  const next = future.pop(); if (!next) return toast('没有可重做的操作')
  history.push(JSON.stringify(project)); project = sanitizeProject(JSON.parse(next)); selectOnly(null)
  if (!project.tracks.some(track => track.id === activeTrackId)) activeTrackId = project.tracks[0].id
  audio.stop(); renderAll(); commit('已重做')
}

function renderAll(): void {
  renderPiano(); renderSettings(); renderGlobalSettings(); audio.syncTracks(project.tracks)
  $('#project-name').value = project.name; $('#bpm-input').value = String(project.bpm); $('#signature-select').value = project.signature; $('#snap-select').value = String(project.snap)
  $('#instrument-select').innerHTML = instrumentOptions(activeTrack())
  document.querySelectorAll('.toggle').forEach(button => button.classList.toggle('active', project.loop))
  updatePosition(currentBeat)
}

function instrumentOptions(track: Track): string {
  const value = track.instrument.kind === 'builtin' ? track.instrument.builtinId : track.instrument.kind === 'sf2' ? `sf2-program:${track.instrument.programIndex}` : 'synth'
  const options = BUILTIN_INSTRUMENTS.map(item => `<option value="${item.id}" ${value === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`)
  options.push(`<option value="synth" ${value === 'synth' ? 'selected' : ''}>基础合成器</option>`)
  if (track.instrument.kind === 'sf2') {
    const programs = audio.getPrograms(track.id)
    if (programs.length) programs.forEach((program, index) => options.push(`<option value="sf2-program:${index}" ${index === track.instrument.programIndex ? 'selected' : ''}>SF2 · ${escapeHtml(program.name || `音色 ${index + 1}`)}</option>`))
    else options.push(`<option value="sf2-program:${track.instrument.programIndex}" selected>${track.instrument.missing ? '⚠ ' : ''}SF2 · ${escapeHtml(track.instrument.programName || track.instrument.name)}</option>`)
  }
  options.push('<option value="sf2-import">导入 SF2…</option>')
  return options.join('')
}

function screenX(beat: number): number { return view.offsetX + beat * 48 * view.scale }
function screenY(hz: number): number { return view.offsetY + hzToY(hz) * view.scale }
function worldBeat(clientX: number): number { const rect = pianoCanvas.getBoundingClientRect(); return (clientX - rect.left - view.offsetX) / (48 * view.scale) }
function worldPitchY(clientY: number): number { const rect = pianoCanvas.getBoundingClientRect(); return (clientY - rect.top - view.offsetY) / view.scale }
function renderPianoRuler(): void {
  const parts: string[] = [], barLength = beatsPerBar()
  for (let beat = 0; beat <= totalBeats(); beat++) {
    const x = screenX(beat); if (x >= -20 && x <= innerWidth + 20) parts.push(`<span class="ruler-beat" style="left:${x}px"></span>`)
  }
  for (let bar = 0; bar <= project.bars; bar++) {
    const x = screenX(bar * barLength); if (x < -20 || x > innerWidth + 20) continue
    parts.push(`<span class="ruler-bar" style="left:${x}px"><b>${bar + 1}</b></span>`)
  }
  pianoRulerContent.innerHTML = parts.join('')
  $('#piano-ruler-playhead').style.left = `${screenX(currentBeat)}px`
}

function renderPiano(): void {
  const track = activeTrack(); if (!track) return
  const rect = pianoCanvas.getBoundingClientRect(); const width = rect.width || innerWidth; const height = rect.height || innerHeight
  const parts: string[] = []
  const leftBeat = (-view.offsetX / view.scale) / 48 - 1
  const rightBeat = ((width - view.offsetX) / view.scale) / 48 + 1
  const gridStep = project.snap || beatsPerBar()
  const firstGrid = Math.floor(leftBeat / gridStep) * gridStep
  for (let index = 0, beat = firstGrid; beat <= rightBeat && index < 4096; index++, beat = firstGrid + index * gridStep) {
    const wholeBeat = Math.abs(beat - Math.round(beat)) < .0001
    const x = screenX(beat); parts.push(`<line class="grid-line snap-grid ${wholeBeat ? 'beat' : 'subdivision'}" x1="${x}" y1="0" x2="${x}" y2="${height}"/>`)
  }
  for (let bar = 0; bar <= project.bars; bar++) {
    const x = screenX(bar * beatsPerBar()); parts.push(`<line class="grid-line bar" x1="${x}" y1="0" x2="${x}" y2="${height}"/>`)
  }
  const tonic = 261.625565 * 2 ** (project.pitchTonic / 12)
  const scalePitches = tuningPitches(project)
  for (let octave = -8; octave <= 8; octave++) scalePitches.forEach(pitch => {
    const y = screenY(tonic * pitch.value * 2 ** octave)
    if (y > -10 && y < height + 10) parts.push(`<line class="pitch-guide ${Math.abs(pitch.value - 1) < 1e-9 ? 'tonic-line' : ''}" x1="0" y1="${y}" x2="${width}" y2="${y}"/>`)
  })
  const byId = new Map(track.notes.map(note => [note.id, note]))
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
    const childY = screenY(note.frequency), parentY = screenY(parent.frequency)
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
    const x1 = screenX(note.beat), x2 = screenX(note.beat + note.duration), y = screenY(note.frequency)
    if (x2 < -50 || x1 > width + 50 || y < -50 || y > height + 50) continue
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
    if (x < -260 || x > width + 20 || y < -130 || y > height + 20) continue
    const editing = annotation.id === editingAnnotationId
    parts.push(`<foreignObject class="annotation-object" data-annotation-id="${annotation.id}" x="${x}" y="${y}" width="260" height="96"><div xmlns="http://www.w3.org/1999/xhtml" class="piano-annotation" data-annotation-id="${annotation.id}" ${editing ? 'contenteditable="true" spellcheck="true" data-editing="true"' : ''}>${sanitizeRichText(annotation.html)}</div></foreignObject>`)
  }
  if (selectionBox) {
    const x = Math.min(selectionBox.x1, selectionBox.x2), y = Math.min(selectionBox.y1, selectionBox.y2)
    parts.push(`<rect class="selection-marquee" x="${x}" y="${y}" width="${Math.abs(selectionBox.x2 - selectionBox.x1)}" height="${Math.abs(selectionBox.y2 - selectionBox.y1)}"/>`)
  }
  parts.push(`<line id="piano-playhead" class="play-indicator" x1="${screenX(currentBeat)}" y1="0" x2="${screenX(currentBeat)}" y2="${height}"/>`)
  pianoSvg.innerHTML = parts.join('')
  renderPianoRuler()
  if (tutorialIndex >= 0) requestAnimationFrame(positionTutorialStep)
}

function centrePiano(track: Track): void {
  const pitches = track.notes.length ? track.notes.map(note => hzToY(note.frequency)).sort((a, b) => a - b) : [hzToY(440)]
  const middle = pitches[Math.floor(pitches.length / 2)]
  view.scale = 1; view.offsetX = 85 - Math.min(...track.notes.map(note => note.beat), 0) * 48; view.offsetY = innerHeight * .47 - middle
}
function descendants(track: Track, parentId: string): JiNote[] {
  const ids = new Set([parentId]); let changed = true
  while (changed) { changed = false; for (const note of track.notes) if (note.parentId && ids.has(note.parentId) && !ids.has(note.id)) { ids.add(note.id); changed = true } }
  return track.notes.filter(note => ids.has(note.id) && note.id !== parentId)
}
function recalculateChildren(track: Track, parentId: string): void {
  const parent = track.notes.find(note => note.id === parentId); if (!parent) return
  for (const child of track.notes) if (child.parentId === parentId && child.ratio) { child.frequency = parent.frequency * ratioValue(child.ratio); recalculateChildren(track, child.id) }
}
function addRootAt(clientX: number, clientY: number): void {
  const track = activeTrack(); checkpoint()
  const rawFrequency = clamp(8, yToHz(worldPitchY(clientY)), 24000)
  const beat = clamp(0, snap(worldBeat(clientX)), totalBeats() - .05)
  const note: JiNote = { id: uid('note'), trackId: track.id, beat, duration: Math.min(currentNoteDuration, totalBeats() - beat), frequency: snapFrequency(rawFrequency), velocity: .8 }
  track.notes.push(note); selectOnly(note.id); renderPiano(); commit(); audio.audition(track, note)
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
  if (note.parentId && note.ratio) {
    $('#note-hz').textContent = note.frequency.toFixed(3); $('#note-name-ratio').textContent = `${noteName(note, found.track)} · ${ratioText(note)}`
    $('#note-volume').value = String(Math.round(note.velocity * 100)); $('#note-mute').classList.toggle('active', Boolean(note.muted)); $('#note-color').value = note.color || '#ffffff'
  } else {
    $('#root-hz').textContent = note.frequency.toFixed(3); $('#root-note-name').textContent = noteName(note, found.track)
    $('#root-volume').value = String(Math.round(note.velocity * 100)); $('#root-mute').classList.toggle('active', Boolean(note.muted)); $('#root-color').value = note.color || '#ffffff'
  }
  menu.classList.add('open'); $('#piano-overlay').style.visibility = 'visible'
  noteMenuAnchor = { menu, clientX, clientY }; positionNoteMenu(menu, clientX, clientY)
  audio.audition(found.track, note)
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
  const track = activeTrack(), annotation = track.annotations.find(item => item.id === editingAnnotationId), editor = annotationEditorElement()
  let finalHtml = sanitizeRichText(editor?.innerHTML ?? annotation?.html ?? '')
  const probe = document.createElement('div'); probe.innerHTML = finalHtml
  const empty = !probe.textContent?.trim()
  const changed = annotationWasNew ? !empty : empty || finalHtml !== annotationOriginalHtml
  if (annotation) {
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
  const track = activeTrack(); let annotation = annotationId ? track.annotations.find(item => item.id === annotationId) : undefined
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
    track.notes.push(child); selectOnly(child.id); closePopups(); renderPiano(); commit(); audio.audition(track, child)
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
    closePopups(); renderPiano(); commit(); audio.audition(found.track, moved)
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
  closePopups(false); toast(`已复制 ${selected.length} 个音符`)
}
function pasteSelectedNotes(): void {
  if (!clipboardNotes?.length) return toast('剪贴板中没有音符', true)
  const track = activeTrack(), source = clipboardNotes
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
      const now = performance.now(); if (now - lastFollowRender >= 32) { lastFollowRender = now; renderPiano() }
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
  $('#piano-position').textContent = text
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
  lastFollowRender = 0; updatePosition(currentBeat); toast(state.toast)
}
function seekToBeat(beat: number): void { audio.stop(); setPlayState(false); updatePosition(clamp(0, beat, totalBeats())) }
async function togglePlay(): Promise<void> {
  if (audio.playing) { audio.stop(); setPlayState(false); return }
  try { setPlayState(true); await audio.play(project, currentBeat >= totalBeats() ? 0 : currentBeat, updatePosition, () => setPlayState(false)) }
  catch (error) { setPlayState(false); toast(error instanceof Error ? error.message : '无法播放', true) }
}
function setPlayState(playing: boolean): void {
  $('#piano-play').textContent = playing ? 'Ⅱ' : '▶'; $('#piano-play').classList.toggle('playing', playing)
}
function stopPlayback(): void { audio.stop(); setPlayState(false); updatePosition(0) }

async function chooseSf2(track: Track): Promise<void> {
  try {
    const file = await pickFile('.sf2'); if (!file) return
    checkpoint(); track.instrument = { kind: 'sf2', name: file.name, programIndex: 0, missing: false }
    const programs = await audio.loadSf2(track, new Uint8Array(await file.arrayBuffer())); track.instrument.programName = programs[0]?.name
    renderAll(); commit(`已加载 ${track.instrument.name}`)
  } catch (error) { track.instrument.missing = true; renderAll(); toast(`SF2 加载失败：${error instanceof Error ? error.message : '未知错误'}`, true) }
}

function renderSettings(): void {
  $('#settings-snap').value = String(project.snap)
}
function openSettings(): void { closePopups(false); renderSettings(); $('#settings-menu').classList.add('open'); $('#piano-overlay').style.visibility = 'visible' }
function renderGlobalSettings(): void {
  $('#global-bpm').value = String(project.bpm); $('#global-signature').value = project.signature; $('#global-bars').value = String(project.bars); $('#global-snap').value = String(project.snap)
  $('#global-volume').value = String(activeTrack().volume)
  ;($('#global-mute') as HTMLInputElement).checked = activeTrack().muted
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
  closePopups(false); renderScaleMenu(); $('#scale-menu').classList.add('open')
  $('#global-overlay').classList.add('open')
}

function tuningDefinitionFromForm(): TuningDefinition {
  const system = $('#scale-system').value as TuningSystem, tonic = Number($('#scale-tonic').value)
  const mode = $('#scale-mode').value, edo = clamp(2, Math.round(Number($('#scale-edo').value) || 12), 9999)
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
  return normalizeTuningDefinition({ version: 1, tonic, system, mode, edo, intervals: normalized })
}

function applyScaleForm(): void {
  try { const definition = tuningDefinitionFromForm(); checkpoint(); applyTuningDefinition(project, definition); closePopups(); renderAll(); commit('调律表已应用') }
  catch (error) { toast(error instanceof Error ? error.message : '调律表无效', true) }
}

function exportTuning(): void {
  try {
    const definition = tuningDefinitionFromForm(), systemName = definition.system === 'preset' ? definition.mode : definition.system === 'ratio' ? '纯律' : `${definition.edo}EDO`
    download(new TextEncoder().encode(JSON.stringify({ ...definition, name: `${pitchNameForOffset(definition.tonic, 0)} ${systemName}` }, null, 2)), `${systemName}.jituning`, 'application/json')
    toast('调律表已导出')
  } catch (error) { toast(error instanceof Error ? error.message : '调律表无效', true) }
}

async function importTuning(): Promise<void> {
  try {
    const file = await pickFile('.jituning,.json'); if (!file) return
    const definition = normalizeTuningDefinition(JSON.parse(await file.text()))
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
    download(new TextEncoder().encode(serialize()), `${project.name}.jidaw`, 'application/json')
    dirty = false; document.title = `${project.name} — 纯律和音图 DAW`; toast('工程已保存')
  } catch (error) { toast(error instanceof Error ? error.message : '保存失败', true) }
}
async function openProject(): Promise<void> {
  try {
    const file = await pickFile('.jidaw,.json'); if (!file) return
    if (dirty && !await confirmAction('打开工程', '打开工程将替换当前未保存的内容。')) return
    const next = sanitizeProject(JSON.parse(await file.text()))
    audio.stop(); project = next; activeTrackId = project.tracks[0].id; selectOnly(null); currentBeat = 0; history.length = 0; future.length = 0; dirty = false
    closeTutorial(); centrePiano(activeTrack()); renderAll(); document.title = `${project.name} — 纯律和音图 Web`; toast('工程已打开')
    if (/^DEMO\.jidaw$/i.test(file.name)) requestAnimationFrame(() => startTutorial(true))
  } catch (error) { toast(`打开失败：${error instanceof Error ? error.message : '文件无效'}`, true) }
}

async function importMidi(): Promise<void> {
  try {
    const file = await pickFile('.mid,.midi,audio/midi'); if (!file) return
    if (dirty && !await confirmAction('导入 MIDI', '导入 MIDI 将替换当前工程。')) return
    const midi = parseMidi(new Uint8Array(await file.arrayBuffer()))
    const currentTuning = {
      pitchRatios: project.pitchRatios.map(([numerator, denominator]) => [numerator, denominator] as [number, number]),
      pitchMode: project.pitchMode,
      pitchTonic: project.pitchTonic, tuningSystem: project.tuningSystem, tuningEdo: project.tuningEdo,
      tuningIntervals: project.tuningIntervals.map(interval => ({ ...interval }))
    }
    const imported = makeProject(), supportedSignatures = ['4/4', '3/4', '5/4', '6/8', '7/8']
    imported.name = file.name.replace(/\.(mid|midi)$/i, '') || 'MIDI 工程'; imported.bpm = midi.bpm
    imported.signature = midi.signature && supportedSignatures.includes(midi.signature) ? midi.signature : '4/4'
    imported.pitchRatios = currentTuning.pitchRatios
    imported.pitchMode = currentTuning.pitchMode
    imported.pitchTonic = currentTuning.pitchTonic
    imported.tuningSystem = currentTuning.tuningSystem
    imported.tuningEdo = currentTuning.tuningEdo
    imported.tuningIntervals = currentTuning.tuningIntervals
    const track = imported.tracks[0]
    track.notes = midi.tracks.flatMap(source => source.notes.map(note => ({
      id: uid('note'), trackId: track.id, beat: note.tick / midi.division,
      duration: Math.max(.05, note.durationTicks / midi.division),
      frequency: tunedFrequencyForMidiPitch(note.pitch, currentTuning), velocity: Math.max(.01, note.velocity / 127)
    })))
    if (!track.notes.length) throw new Error('MIDI 文件中没有可导入的音符')
    track.instrument.programIndex = midi.tracks.flatMap(source => source.notes)[0]?.program ?? 0
    const [top, bottom] = imported.signature.split('/').map(Number), barLength = top * 4 / bottom
    const endBeat = Math.max(...track.notes.map(note => note.beat + note.duration))
    imported.bars = clamp(4, Math.ceil(endBeat / barLength), 256)
    audio.stop(); project = imported; activeTrackId = track.id; selectOnly(null); currentBeat = 0; currentNoteDuration = 1
    history.length = 0; future.length = 0; centrePiano(track); renderAll(); commit(`已按当前调律表导入 ${track.notes.length} 个 MIDI 音符`)
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
  const base = makeProject(), context = payload.context || base
  const source = payload.track
  const rawTrack: Track = {
    id: uid('track'), name: source.name, color: source.color, volume: source.volume, pan: source.pan,
    muted: false, solo: false, height: 78, instrument: source.instrument,
    notes: source.notes, annotations: source.annotations || []
  }
  return sanitizeProject({
    ...base, name: source.name || '轨道码', bpm: context.bpm, signature: context.signature,
    snap: context.snap, bars: context.bars, pitchRatios: context.pitchRatios,
    pitchMode: context.pitchMode, pitchTonic: context.pitchTonic, tuningSystem: context.tuningSystem,
    tuningEdo: context.tuningEdo, tuningIntervals: context.tuningIntervals, tracks: [rawTrack]
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
    activeTrackId = project.tracks[0].id; selectOnly(null); currentBeat = 0; currentNoteDuration = 1
    history.length = 0; future.length = 0; trackCodeDialog().close(); centrePiano(activeTrack()); renderAll(); commit('轨道码已导入')
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

const TUTORIAL_STEPS = [
  {
    target: '.web-brand', title: '欢迎来到单轨纯律钢琴窗',
    text: '当前已经加载 DEMO.jidaw。教程不会锁住界面；被高亮的控件仍然可以直接操作。'
  },
  {
    target: '[data-note-id]', title: '直接编辑音符',
    text: '点击演示音符可打开编辑菜单；拖动音符主体可移动，拖动两端可改变起点或时值。菜单中的“移动音程”和“从此音添加”支持任意分数。'
  },
  {
    target: '.tool-switch', title: '笔、框选与注释',
    text: 'P 是笔工具，V 是框选工具，T 是原位文本注释。按住 Ctrl 会临时切到框选；选择多个音符后可复制、粘贴或 Delete 删除。'
  },
  {
    target: '#piano-ruler', title: '时间与播放位置',
    text: '点击底部小节尺会移动播放光标，不会添加音符。滚轮以指针为中心缩放，拖动空白区域可平移视图。'
  },
  {
    target: '#piano-play', title: '播放与跟随',
    text: '使用播放、停止和循环按钮试听。跟随按钮依次切换“关闭、光标锁定、小节翻页”：锁定模式让光标固定在左侧约四分之一处；翻页模式在光标越过右侧最近的小节线后，把该小节起点移到最左侧。'
  },
  {
    target: '#global-settings', title: '完整全局设置',
    text: '设置中包含 BPM、拍号、小节数、吸附、音量、静音、节拍器，以及主音、调式和十二音纯律比例。底栏也保留了常用节拍设置。'
  },
  {
    target: '.web-actions', title: '工程、轨道码与 MIDI',
    text: '顶部可以新建、打开和保存工程，导入/导出轨道码与 MIDI，并将当前音色离线渲染为 MP3。MIDI 导出会使用多通道 Pitch Bend 保存纯律微分音高。点击右侧“?”可随时重新打开教程。'
  }
] as const

function positionTutorialStep(): void {
  if (tutorialIndex < 0) return
  const step = TUTORIAL_STEPS[tutorialIndex], target = document.querySelector<HTMLElement>(step.target)
  if (!target) return
  const rect = target.getBoundingClientRect(), padding = 7, highlight = $('#tutorial-highlight'), card = $('#tutorial-card')
  const left = clamp(6, rect.left - padding, innerWidth - 34), top = clamp(6, rect.top - padding, innerHeight - 34)
  highlight.style.left = `${left}px`; highlight.style.top = `${top}px`
  highlight.style.width = `${Math.max(28, Math.min(innerWidth - left - 6, rect.width + padding * 2))}px`
  highlight.style.height = `${Math.max(28, Math.min(innerHeight - top - 6, rect.height + padding * 2))}px`
  const cardWidth = card.offsetWidth || 350, cardHeight = card.offsetHeight || 210
  card.style.left = `${clamp(12, rect.left + rect.width / 2 - cardWidth / 2, Math.max(12, innerWidth - cardWidth - 12))}px`
  const below = rect.bottom + 15, above = rect.top - cardHeight - 15
  card.style.top = `${below + cardHeight <= innerHeight - 12 ? below : Math.max(12, above)}px`
}
function showTutorialStep(index: number): void {
  tutorialIndex = clamp(0, index, TUTORIAL_STEPS.length - 1)
  const step = TUTORIAL_STEPS[tutorialIndex]
  $('#tutorial-progress').textContent = `${tutorialIndex + 1} / ${TUTORIAL_STEPS.length}`
  $('#tutorial-title').textContent = step.title; $('#tutorial-text').textContent = step.text
  $('#tutorial-prev').toggleAttribute('disabled', tutorialIndex === 0)
  $('#tutorial-next').textContent = tutorialIndex === TUTORIAL_STEPS.length - 1 ? '完成' : '下一步'
  requestAnimationFrame(positionTutorialStep)
}
function startTutorial(force = false): void {
  if (!force && localStorage.getItem('ji-daw-web-tutorial-v1') === 'done') return
  closePopups(false); $('#tutorial-overlay').classList.add('open'); showTutorialStep(0)
}
function closeTutorial(): void {
  tutorialIndex = -1; $('#tutorial-overlay').classList.remove('open')
  localStorage.setItem('ji-daw-web-tutorial-v1', 'done')
}
async function loadBundledDemo(): Promise<boolean> {
  try {
    const response = await fetch(new URL('DEMO.jidaw', document.baseURI), { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    project = sanitizeProject(await response.json()); activeTrackId = project.tracks[0].id
    selectOnly(null); currentBeat = 0; dirty = false; return true
  } catch (error) {
    toast(`DEMO.jidaw 加载失败：${error instanceof Error ? error.message : '未知错误'}`, true); return false
  }
}

// 单轨音色选择；导入 SF2 后仍可选该 SoundFont 内的预置。
$('#instrument-select').addEventListener('change', async event => {
  const input = event.target as HTMLSelectElement, track = activeTrack()
  if (input.value === 'sf2-import') { await chooseSf2(track); renderAll(); return }
  if (input.value.startsWith('sf2-program:')) {
    if (track.instrument.kind !== 'sf2' || !audio.hasFont(track.id)) return renderAll()
    const index = Number(input.value.split(':')[1]), program = audio.getPrograms(track.id)[index]; if (!program) return renderAll()
    checkpoint(); audio.selectProgram(track.id, index); track.instrument.programIndex = index; track.instrument.programName = program.name; track.instrument.missing = false
    renderAll(); commit(`已切换为 ${program.name || `SF2 音色 ${index + 1}`}`); return
  }
  checkpoint()
  if (input.value === 'synth') track.instrument = { kind: 'synth', name: '基础合成器', programIndex: 0 }
  else {
    const definition = BUILTIN_INSTRUMENTS.find(item => item.id === input.value)
    if (!definition) return renderAll()
    track.instrument = { kind: 'builtin', builtinId: definition.id, name: definition.name, programIndex: 0 }
  }
  renderAll(); commit(`已切换为${track.instrument.name}`)
})

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
        const hits = activeTrack().notes.filter(note => screenY(note.frequency) >= top && screenY(note.frequency) <= bottom && screenX(note.beat + note.duration) >= left && screenX(note.beat) <= right).map(note => note.id)
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
    selectOnly(note.id); renderPiano()
    const startX = event.clientX, startY = event.clientY, originalBeat = note.beat, originalDuration = note.duration, originalFrequency = note.frequency
    const lineStart = screenX(note.beat), lineEnd = screenX(note.beat + note.duration)
    const mode = Math.abs(event.clientX - lineStart) <= 12 ? 'head' : Math.abs(event.clientX - lineEnd) <= 12 ? 'tail' : 'body'
    const childNotes = descendants(track, note.id), childBeats = new Map(childNotes.map(child => [child.id, child.beat]))
    const shifted = $('#shift-mode').checked ? track.notes.filter(item => item.beat > originalBeat && item.id !== note.id && !childBeats.has(item.id)) : []
    const shiftedBeats = new Map(shifted.map(item => [item.id, item.beat])); let moved = false, saved = false
    const move = (moveEvent: PointerEvent) => {
      const dxBeats = (moveEvent.clientX - startX) / (48 * view.scale), dyWorld = (moveEvent.clientY - startY) / view.scale
      if (Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) > 3) moved = true
      if (!moved) return
      if (!saved) { checkpoint(); saved = true }
      if (mode === 'tail') note.duration = clamp(.05, originalDuration + dxBeats, totalBeats() - note.beat)
      else if (mode === 'head') {
        const end = originalBeat + originalDuration; note.beat = clamp(0, originalBeat + dxBeats, end - .05); note.duration = end - note.beat
        const delta = note.beat - originalBeat; for (const child of childNotes) child.beat = (childBeats.get(child.id) ?? child.beat) + delta
      } else {
        note.beat = clamp(0, originalBeat + dxBeats, totalBeats() - note.duration); const delta = note.beat - originalBeat
        for (const child of childNotes) child.beat = (childBeats.get(child.id) ?? child.beat) + delta
        if (!note.parentId) { note.frequency = clamp(8, yToHz(hzToY(originalFrequency) + dyWorld), 24000); recalculateChildren(track, note.id) }
      }
      const shiftDelta = mode === 'tail' ? note.duration - originalDuration : note.beat - originalBeat
      for (const item of shifted) item.beat = (shiftedBeats.get(item.id) ?? item.beat) + shiftDelta
      renderPiano()
    }
    const up = (upEvent: PointerEvent) => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up)
      if (!moved) return showNoteMenu(note.id, upEvent.clientX, upEvent.clientY)
      if (mode === 'tail') note.duration = clamp(project.snap || .05, Math.max(project.snap || .05, snap(note.duration)), totalBeats() - note.beat)
      else {
        const finalBeat = clamp(0, snap(note.beat), totalBeats() - .05), delta = finalBeat - originalBeat
        note.beat = finalBeat
        if (mode === 'head') note.duration = Math.max(.05, originalBeat + originalDuration - finalBeat)
        if (mode === 'body' && !note.parentId) { note.frequency = snapFrequency(note.frequency); recalculateChildren(track, note.id) }
        for (const child of childNotes) child.beat = (childBeats.get(child.id) ?? child.beat) + delta
      }
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
    if (!panning) addRootAt(upEvent.clientX, upEvent.clientY)
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
  const annotation = activeTrack().annotations.find(item => item.id === editingAnnotationId); if (!annotation) return
  annotation.html = editor.innerHTML; dirty = true
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
document.querySelectorAll('.audition-button').forEach(button => button.addEventListener('click', () => { const found = findNote(selectedNoteId); if (found) audio.audition(found.track, found.note) }))
$('#piano-overlay').addEventListener('pointerdown', () => closePopups(true)); document.querySelectorAll('.close-popup').forEach(button => button.addEventListener('click', () => closePopups()))
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
for (const selector of ['#root-copy', '#copy-note']) $(selector).addEventListener('click', copySelectedNotes)
$('#paste-note').addEventListener('click', pasteSelectedNotes)
$('#root-hz').addEventListener('blur', () => {
  const found = findNote(selectedNoteId); if (!found || found.note.parentId) return
  const value = Number($('#root-hz').textContent); if (!Number.isFinite(value) || value < 8 || value > 24000) return showNoteMenu(found.note.id, innerWidth / 2, innerHeight / 2)
  checkpoint(); found.note.frequency = value; recalculateChildren(found.track, found.note.id); renderPiano(); commit()
})
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
$('#global-volume').addEventListener('pointerdown', checkpoint)
$('#global-volume').addEventListener('input', () => { activeTrack().volume = Number($('#global-volume').value); audio.syncTracks(project.tracks) })
$('#global-volume').addEventListener('change', () => { activeTrack().volume = Number($('#global-volume').value); audio.syncTracks(project.tracks); commit() })
$('#global-mute').addEventListener('change', () => { checkpoint(); activeTrack().muted = ($('#global-mute') as HTMLInputElement).checked; commit() })
$('#global-metronome').addEventListener('change', () => { checkpoint(); project.metronome = ($('#global-metronome') as HTMLInputElement).checked; commit() })
$('#scale-apply').addEventListener('click', applyScaleForm); $('#scale-import').addEventListener('click', importTuning); $('#scale-export').addEventListener('click', exportTuning); $('#scale-default').addEventListener('click', setDefaultTuning)
$('#scale-mode').addEventListener('change', updateScaleEditor); $('#scale-tonic').addEventListener('change', updateScaleEditor); $('#scale-edo').addEventListener('input', updateCustomTuningNames)
$('#scale-system').addEventListener('change', () => { $('#scale-interval-list').innerHTML = ''; updateScaleEditor() }); $('#scale-add-interval').addEventListener('click', addTuningInterval)
$('#scale-interval-list').addEventListener('input', updateCustomTuningNames); $('#scale-interval-list').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="remove-tuning"]'); if (!button) return; button.closest('[data-tuning-row]')?.remove(); updateCustomTuningNames() })
$('#piano-settings').addEventListener('click', openSettings)
$('#tool-pen').addEventListener('click', () => { activeTool = 'pen'; updateToolUi() })
$('#tool-select').addEventListener('click', () => { activeTool = 'select'; updateToolUi() })
$('#tool-text').addEventListener('click', () => { activeTool = 'text'; updateToolUi() })
$('#piano-follow').addEventListener('click', cyclePlaybackFollow)
$('#piano-play').addEventListener('click', togglePlay)
$('#piano-stop').addEventListener('click', stopPlayback)
$('#piano-loop').addEventListener('click', () => { checkpoint(); project.loop = !project.loop; renderAll(); commit() })
$('#piano-undo').addEventListener('click', undo); $('#redo-button').addEventListener('click', redo)

// 工程与全局设置
$('#save-project').addEventListener('click', saveProject); $('#open-project').addEventListener('click', openProject); $('#import-midi').addEventListener('click', importMidi)
$('#export-midi').addEventListener('click', exportMidiFile)
$('#export-mp3').addEventListener('click', exportMp3File)
$('#import-track-code').addEventListener('click', openTrackCodeImport)
$('#export-track-code').addEventListener('click', () => openTrackCodeExport(activeTrack()))
$('#track-code-close').addEventListener('click', () => trackCodeDialog().close())
$('#track-code-copy').addEventListener('click', copyTrackCode)
$('#track-code-import').addEventListener('click', importTrackCode)
$('#tutorial-button').addEventListener('click', () => startTutorial(true))
$('#tutorial-close').addEventListener('click', closeTutorial)
$('#tutorial-prev').addEventListener('click', () => showTutorialStep(tutorialIndex - 1))
$('#tutorial-next').addEventListener('click', () => tutorialIndex === TUTORIAL_STEPS.length - 1 ? closeTutorial() : showTutorialStep(tutorialIndex + 1))
$('#new-project').addEventListener('click', async () => { if (dirty && !await confirmAction('新建工程', '当前未保存的修改将被清空。')) return; closeTutorial(); audio.stop(); project = makeProject(); activeTrackId = project.tracks[0].id; selectOnly(null); history.length = 0; future.length = 0; currentBeat = 0; centrePiano(activeTrack()); renderAll(); commit() })
$('#project-name').addEventListener('change', () => { checkpoint(); project.name = $('#project-name').value.trim() || '未命名工程'; commit() })
$('#bpm-input').addEventListener('change', () => { const value = Number($('#bpm-input').value); if (value < 20 || value > 400) { $('#bpm-input').value = String(project.bpm); return toast('BPM 范围为 20–400', true) } checkpoint(); project.bpm = value; commit() })
$('#signature-select').addEventListener('change', () => { checkpoint(); project.signature = $('#signature-select').value; renderAll(); commit() })
$('#snap-select').addEventListener('change', () => { checkpoint(); project.snap = Number($('#snap-select').value); renderPiano(); commit() })

document.addEventListener('keydown', event => {
  if (tutorialIndex >= 0 && event.key === 'ArrowRight') { event.preventDefault(); tutorialIndex === TUTORIAL_STEPS.length - 1 ? closeTutorial() : showTutorialStep(tutorialIndex + 1); return }
  if (tutorialIndex >= 0 && event.key === 'ArrowLeft') { event.preventDefault(); showTutorialStep(tutorialIndex - 1); return }
  if (tutorialIndex >= 0 && event.key === 'Escape') { event.preventDefault(); closeTutorial(); return }
  if (event.key === 'Control') { controlHeld = true; updateToolUi(); return }
  const editing = ['INPUT', 'SELECT'].includes((event.target as HTMLElement).tagName) || (event.target as HTMLElement).isContentEditable
  if (event.key === 'Escape') { closePopups(true); return }
  if (editing) return
  if (event.code === 'Space') { event.preventDefault(); togglePlay() }
  if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected()
  if (!event.ctrlKey && event.key.toLowerCase() === 'p') { activeTool = 'pen'; updateToolUi() }
  if (!event.ctrlKey && event.key.toLowerCase() === 'v') { activeTool = 'select'; updateToolUi() }
  if (!event.ctrlKey && event.key.toLowerCase() === 't') { activeTool = 'text'; updateToolUi() }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelectedNotes() }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteSelectedNotes() }
  if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); saveProject() }
  if (event.ctrlKey && event.key.toLowerCase() === 'o') { event.preventDefault(); openProject() }
  if (event.ctrlKey && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
})
document.addEventListener('keyup', event => { if (event.key === 'Control') { controlHeld = false; updateToolUi() } })
window.addEventListener('blur', () => { controlHeld = false; updateToolUi() })
new ResizeObserver(() => repositionOpenNoteMenu()).observe($('#root-menu'))
new ResizeObserver(() => repositionOpenNoteMenu()).observe($('#note-menu'))
window.addEventListener('resize', () => { renderPiano(); repositionOpenNoteMenu(); positionTutorialStep() })
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = '' } })

async function bootstrap(): Promise<void> {
  const demoLoaded = !autosavedProject && await loadBundledDemo()
  centrePiano(activeTrack()); updateToolUi(); renderAll()
  document.title = `${project.name} — 纯律和音图 Web`
  if (demoLoaded) requestAnimationFrame(() => startTutorial())
}
bootstrap()
