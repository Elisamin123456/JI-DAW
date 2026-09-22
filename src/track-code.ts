import type { JiAnnotation, JiNote, InstrumentState, JiProject, Track } from './types'

export interface TrackCodePayload {
  version: 1
  track: {
    name: string
    color: string
    volume: number
    pan: number
    instrument: InstrumentState
    notes: JiNote[]
    annotations: JiAnnotation[]
  }
  context: Pick<JiProject, 'bpm' | 'signature' | 'snap' | 'bars' | 'pitchRatios' | 'pitchMode' | 'pitchTonic'>
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes)
  return copy.buffer
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  const stream = new Blob([ownedBuffer(bytes)]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持解压轨道码')
  const stream = new Blob([ownedBuffer(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function portableInstrument(instrument: InstrumentState): InstrumentState {
  if (instrument.kind !== 'sf2') return { ...instrument }
  return { kind: 'sf2', name: instrument.name, programIndex: instrument.programIndex, programName: instrument.programName, missing: true }
}

export async function encodeTrackCode(project: JiProject, track: Track): Promise<string> {
  const payload: TrackCodePayload = {
    version: 1,
    track: {
      name: track.name, color: track.color, volume: track.volume, pan: track.pan,
      instrument: portableInstrument(track.instrument),
      notes: track.notes.map(note => ({ ...note, ratio: note.ratio ? { ...note.ratio } : undefined })),
      annotations: track.annotations.map(annotation => ({ ...annotation }))
    },
    context: {
      bpm: project.bpm, signature: project.signature, snap: project.snap, bars: project.bars,
      pitchRatios: project.pitchRatios.map(ratio => [ratio[0], ratio[1]]), pitchMode: project.pitchMode, pitchTonic: project.pitchTonic
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload)), compressed = await gzip(bytes)
  return compressed ? `JIT1G.${base64Url(compressed)}` : `JIT1J.${base64Url(bytes)}`
}

export async function decodeTrackCode(code: string): Promise<TrackCodePayload> {
  const trimmed = code.trim(), separator = trimmed.indexOf('.')
  if (separator < 0) throw new Error('轨道码格式无效')
  const prefix = trimmed.slice(0, separator), encoded = trimmed.slice(separator + 1)
  const packed = fromBase64Url(encoded), bytes = prefix === 'JIT1G' ? await gunzip(packed) : prefix === 'JIT1J' ? packed : null
  if (!bytes) throw new Error('不支持的轨道码版本')
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as Partial<TrackCodePayload>
  if (payload.version !== 1 || !payload.track || !Array.isArray(payload.track.notes)) throw new Error('轨道码内容无效')
  if (payload.track.notes.length > 10000 || (payload.track.annotations?.length || 0) > 1000) throw new Error('轨道码内容过大')
  return payload as TrackCodePayload
}
