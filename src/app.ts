import { AudioEngine, BUILTIN_INSTRUMENTS } from './audio'
import { parseMidi } from './midi'
import { exportMidi } from './midi-export'
import { intervalConnectionStyle, parseRatio, primeLimit, ratioValue } from './ratio'
import { decodeTrackCode, encodeTrackCode, type TrackCodePayload } from './track-code'
import { generateTwelveToneRatios, isLegacyPitchRatios, NATURAL_PITCH_CLASSES, pitchClassSpelling, pitchNameForOffset } from './tuning'
import type { JiAnnotation, JiNote, JiProject, RatioSpec, Track } from './types'

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
const PITCH_MODES: Record<string, number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 9, 10, 11], locrian: [0, 1, 3, 5, 6, 8, 10],
  'major-pentatonic': [0, 2, 4, 7, 9], 'minor-pentatonic': [0, 3, 5, 7, 10]
}
const audio = new AudioEngine()

function makeTrack(index: number, name = `轨道 ${index + 1}`): Track {
  return { id: uid('track'), name, color: TRACK_COLORS[index % TRACK_COLORS.length], volume: .8, pan: 0, muted: false, solo: false, height: 78, instrument: { kind: 'builtin', builtinId: 'salamander-piano', name: 'Salamander Grand Piano', programIndex: 0 }, notes: [], annotations: [] }
}

function makeProject(_demo = false): JiProject {
  const tracks = [makeTrack(0, '钢琴')]
  return { version: 2, name: '我的纯律工程', bpm: 120, signature: '4/4', snap: 1, bars: 16, loop: true, metronome: false, pitchRatios: generateTwelveToneRatios('chromatic'), pitchMode: 'chromatic', pitchTonic: 0, tracks }
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
  const project: JiProject = {
    version: 2, name: typeof input.name === 'string' ? input.name.slice(0, 120) : '未命名工程',
    bpm: clamp(20, Number(input.bpm) || 120, 400), signature: ['4/4', '3/4', '5/4', '6/8', '7/8'].includes(input.signature ?? '') ? input.signature! : '4/4',
    snap: [0, .25, .5, 1, 2].includes(Number(input.snap)) ? Number(input.snap) : 1,
    bars: clamp(4, Math.round(Number(input.bars) || 16), 256), loop: input.loop !== false, metronome: Boolean(input.metronome),
    pitchRatios, pitchMode,
    pitchTonic: clamp(0, Math.round(Number(input.pitchTonic) || 0), 11), tracks: []
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
        muted: Boolean(note.muted), ghost: Boolean(note.ghost), parentId: typeof note.parentId === 'string' ? note.parentId : undefined, ratio
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
  try { const value = localStorage.getItem('ji-daw-web-autosave-v1'); return value ? sanitizeProject(JSON.parse(value)) : null } catch { return null }
}

let project = loadAutosave() ?? makeProject()
let activeTrackId = project.tracks[0].id
let selectedNoteId: string | null = null
let selectedNoteIds = new Set<string>()
let activeTool: 'pen' | 'select' | 'text' = 'pen'
let controlHeld = false
let selectionBox: { x1: number; y1: number; x2: number; y2: number } | null = null
let currentBeat = 0
let currentNoteDuration = 1
let playbackFollow = false
let lastFollowRender = 0
let editingAnnotationId: string | null = null
let annotationSelection: Range | null = null
let annotationOriginalHtml = ''
let annotationWasNew = false
let dirty = false
let toastTimer = 0
let clipboardNotes: JiNote[] | null = null
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
  const { letter, accidental } = pitchClassSpelling(project.pitchTonic, relative, project.pitchMode)
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
  const tonic = 261.625565 * 2 ** (project.pitchTonic / 12)
  let best = value
  let bestDistance = Infinity
  const activePitches = new Set(PITCH_MODES[project.pitchMode] || PITCH_MODES.chromatic)
  for (let octave = -8; octave <= 8; octave++) for (const [index, [numerator, denominator]] of project.pitchRatios.entries()) {
    if (!activePitches.has(index)) continue
    const candidate = tonic * (numerator / denominator) * 2 ** octave
    if (candidate < 8 || candidate > 24000) continue
    const distance = Math.abs(Math.log2(value / candidate))
    if (distance < bestDistance) { best = candidate; bestDistance = distance }
  }
  return best
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

function checkpoint(): void {
  const now = JSON.stringify(project)
  if (history.at(-1) !== now) history.push(now)
  if (history.length > 100) history.shift()
  future.length = 0
}
function commit(message?: string): void {
  dirty = true; localStorage.setItem('ji-daw-web-autosave-v1', JSON.stringify(project)); document.title = `● ${project.name} — 纯律和音图 Web`
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
  const activePitches = new Set(PITCH_MODES[project.pitchMode] || PITCH_MODES.chromatic)
  const tonic = 261.625565 * 2 ** (project.pitchTonic / 12)
  for (let octave = -8; octave <= 8; octave++) project.pitchRatios.forEach(([numerator, denominator], index) => {
    if (!activePitches.has(index)) return
    const y = screenY(tonic * (numerator / denominator) * 2 ** octave)
    if (y > -10 && y < height + 10) parts.push(`<line class="pitch-guide ${index === 0 ? 'tonic-line' : ''}" x1="0" y1="${y}" x2="${width}" y2="${y}"/>`)
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
    if (!note.parentId && noteIdsWithChildren.has(note.id)) parts.push(`<polygon class="root-marker" points="${x1 - 13},${y} ${x1 - 5},${y - 5} ${x1 - 5},${y + 5}"/>`)
    const labelSize = clamp(6, 9 * view.scale, 12), labelStroke = clamp(1.25, 2.25 * view.scale, 2.75)
    const ratioLabel = note.ratio && !DEFAULT_INTERVAL_RATIOS.has(`${note.ratio.numerator}/${note.ratio.denominator}`)
      ? `<tspan class="ratio-text"> · ${ratioText(note)}</tspan>` : ''
    parts.push(`<g data-note-id="${note.id}" data-ghost="${Boolean(note.ghost)}"><line class="pitch-line ${note.muted ? 'muted' : ''} ${note.ghost ? 'ghost' : ''} ${selectedNoteIds.has(note.id) ? 'selected' : ''}" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><line class="note-hit" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><text class="piano-label" style="font-size:${labelSize}px;stroke-width:${labelStroke}px" x="${x1 + 5 * view.scale}" y="${y + labelSize * .34}">${label}${ratioLabel}</text></g>`)
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
    $('#note-volume').value = String(Math.round(note.velocity * 100)); $('#note-mute').classList.toggle('active', Boolean(note.muted))
  } else {
    $('#root-hz').textContent = note.frequency.toFixed(3); $('#root-note-name').textContent = noteName(note, found.track)
    $('#root-volume').value = String(Math.round(note.velocity * 100)); $('#root-mute').classList.toggle('active', Boolean(note.muted))
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
  currentBeat = clamp(0, beat, totalBeats()); const barLength = beatsPerBar(), bar = Math.floor(currentBeat / barLength) + 1, inside = currentBeat % barLength, beatNo = Math.floor(inside) + 1, tick = Math.floor((inside % 1) * 96)
  if (playbackFollow && (audio.playing || currentBeat === 0) && !$('#piano-view').classList.contains('hidden')) {
    view.offsetX = pianoCanvas.clientWidth * .25 - currentBeat * 48 * view.scale
    const now = performance.now(); if (now - lastFollowRender >= 32) { lastFollowRender = now; renderPiano() }
  }
  const text = `${String(bar).padStart(3, '0')}:${String(beatNo).padStart(2, '0')}:${String(tick).padStart(3, '0')}`
  $('#piano-position').textContent = text
  const line = document.querySelector<SVGLineElement>('#piano-playhead'); if (line) { const x = screenX(currentBeat); line.setAttribute('x1', String(x)); line.setAttribute('x2', String(x)) }
  $('#piano-ruler-playhead').style.left = `${screenX(currentBeat)}px`
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
  $('#scale-mode').value = project.pitchMode
  $('#scale-tonic').value = String(project.pitchTonic)
  const activePitches = new Set(PITCH_MODES[project.pitchMode] || PITCH_MODES.chromatic)
  $('#scale-ratio-list').innerHTML = project.pitchRatios.map(([numerator, denominator], index) => `<label class="scale-ratio-row ${activePitches.has(index) ? '' : 'inactive'}" data-pitch-index="${index}"><span>${pitchNameForOffset(project.pitchTonic, index, project.pitchMode)}</span><input data-scale-index="${index}" data-part="n" value="${numerator}" ${index === 0 ? 'readonly' : ''}><span>/</span><input data-scale-index="${index}" data-part="d" value="${denominator}" ${index === 0 ? 'readonly' : ''}></label>`).join('')
}
function updateScaleModePreview(): void {
  const activePitches = new Set(PITCH_MODES[$('#scale-mode').value] || PITCH_MODES.chromatic)
  const tonic = Number($('#scale-tonic').value)
  const mode = $('#scale-mode').value
  document.querySelectorAll<HTMLElement>('.scale-ratio-row').forEach(row => {
    const index = Number(row.dataset.pitchIndex)
    row.classList.toggle('inactive', !activePitches.has(index))
    const name = row.querySelector('span'); if (name) name.textContent = pitchNameForOffset(tonic, index, mode)
  })
}
function openScaleMenu(): void {
  closePopups(false); renderScaleMenu(); $('#scale-menu').classList.add('open')
  $('#global-overlay').classList.add('open')
}
function resetScaleForm(): void {
  generateTwelveToneRatios($('#scale-mode').value).forEach(([numerator, denominator], index) => {
    ;($(`[data-scale-index="${index}"][data-part="n"]`) as HTMLInputElement).value = String(numerator)
    ;($(`[data-scale-index="${index}"][data-part="d"]`) as HTMLInputElement).value = String(denominator)
  })
}
function applyScaleForm(): void {
  try {
    const tonicIndex = Number($('#scale-tonic').value)
    const ratios = Array.from({ length: 12 }, (_unused, index) => {
      const ratio = parseRatio($(`[data-scale-index="${index}"][data-part="n"]`).value, $(`[data-scale-index="${index}"][data-part="d"]`).value, 'up')
      const value = ratioValue(ratio)
      if (value < 1 || value >= 2) throw new Error(`${pitchNameForOffset(tonicIndex, index, $('#scale-mode').value)} 的比例必须处于 1/1（含）到 2/1（不含）之间`)
      return [ratio.numerator, ratio.denominator] as [number, number]
    })
    if (ratios[0][0] !== ratios[0][1]) throw new Error('主音必须保持为 1/1')
    for (let index = 1; index < ratios.length; index++) if (ratios[index][0] / ratios[index][1] <= ratios[index - 1][0] / ratios[index - 1][1]) throw new Error('十二音比例必须从主音起依次升高')
    checkpoint(); project.pitchRatios = ratios; project.pitchMode = $('#scale-mode').value; project.pitchTonic = tonicIndex; closePopups(); renderPiano(); commit('主音、调式与十二音吸附比例已更新')
  } catch (error) { toast(error instanceof Error ? error.message : '比例无效', true) }
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
    centrePiano(activeTrack()); renderAll(); document.title = `${project.name} — 纯律和音图 Web`; toast('工程已打开')
  } catch (error) { toast(`打开失败：${error instanceof Error ? error.message : '文件无效'}`, true) }
}

async function importMidi(): Promise<void> {
  try {
    const file = await pickFile('.mid,.midi,audio/midi'); if (!file) return
    if (dirty && !await confirmAction('导入 MIDI', '导入 MIDI 将替换当前工程。')) return
    const midi = parseMidi(new Uint8Array(await file.arrayBuffer()))
    const imported = makeProject(), supportedSignatures = ['4/4', '3/4', '5/4', '6/8', '7/8']
    imported.name = file.name.replace(/\.(mid|midi)$/i, '') || 'MIDI 工程'; imported.bpm = midi.bpm
    imported.signature = midi.signature && supportedSignatures.includes(midi.signature) ? midi.signature : '4/4'
    const track = imported.tracks[0]
    track.notes = midi.tracks.flatMap(source => source.notes.map(note => ({
      id: uid('note'), trackId: track.id, beat: note.tick / midi.division,
      duration: Math.max(.05, note.durationTicks / midi.division),
      frequency: 440 * 2 ** ((note.pitch + note.bendSemitones - 69) / 12), velocity: Math.max(.01, note.velocity / 127)
    })))
    if (!track.notes.length) throw new Error('MIDI 文件中没有可导入的音符')
    track.instrument.programIndex = midi.tracks.flatMap(source => source.notes)[0]?.program ?? 0
    const [top, bottom] = imported.signature.split('/').map(Number), barLength = top * 4 / bottom
    const endBeat = Math.max(...track.notes.map(note => note.beat + note.duration))
    imported.bars = clamp(4, Math.ceil(endBeat / barLength), 256)
    audio.stop(); project = imported; activeTrackId = track.id; selectOnly(null); currentBeat = 0; currentNoteDuration = 1
    history.length = 0; future.length = 0; centrePiano(track); renderAll(); commit(`已导入 ${track.notes.length} 个 MIDI 音符`)
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
    pitchMode: context.pitchMode, pitchTonic: context.pitchTonic, tracks: [rawTrack]
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
$('#scale-reset').addEventListener('click', resetScaleForm); $('#scale-apply').addEventListener('click', applyScaleForm)
$('#scale-mode').addEventListener('change', () => { resetScaleForm(); updateScaleModePreview() })
$('#scale-tonic').addEventListener('change', updateScaleModePreview)
$('#piano-settings').addEventListener('click', openSettings)
$('#tool-pen').addEventListener('click', () => { activeTool = 'pen'; updateToolUi() })
$('#tool-select').addEventListener('click', () => { activeTool = 'select'; updateToolUi() })
$('#tool-text').addEventListener('click', () => { activeTool = 'text'; updateToolUi() })
$('#piano-follow').addEventListener('click', () => { playbackFollow = !playbackFollow; $('#piano-follow').classList.toggle('active', playbackFollow); lastFollowRender = 0; updatePosition(currentBeat) })
$('#piano-play').addEventListener('click', togglePlay)
$('#piano-stop').addEventListener('click', stopPlayback)
$('#piano-loop').addEventListener('click', () => { checkpoint(); project.loop = !project.loop; renderAll(); commit() })
$('#piano-undo').addEventListener('click', undo); $('#redo-button').addEventListener('click', redo)

// 工程与全局设置
$('#save-project').addEventListener('click', saveProject); $('#open-project').addEventListener('click', openProject); $('#import-midi').addEventListener('click', importMidi)
$('#export-midi').addEventListener('click', exportMidiFile)
$('#import-track-code').addEventListener('click', openTrackCodeImport)
$('#export-track-code').addEventListener('click', () => openTrackCodeExport(activeTrack()))
$('#track-code-close').addEventListener('click', () => trackCodeDialog().close())
$('#track-code-copy').addEventListener('click', copyTrackCode)
$('#track-code-import').addEventListener('click', importTrackCode)
$('#new-project').addEventListener('click', async () => { if (dirty && !await confirmAction('新建工程', '当前未保存的修改将被清空。')) return; audio.stop(); project = makeProject(); activeTrackId = project.tracks[0].id; selectOnly(null); history.length = 0; future.length = 0; currentBeat = 0; centrePiano(activeTrack()); renderAll(); commit() })
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
window.addEventListener('resize', () => { renderPiano(); repositionOpenNoteMenu() })
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = '' } })

centrePiano(activeTrack()); updateToolUi(); renderAll()
