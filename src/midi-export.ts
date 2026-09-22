import type { JiProject } from './types'

const PPQN = 960
const CHANNELS = Array.from({ length: 16 }, (_, index) => index).filter(index => index !== 9)
type MidiEvent = { tick: number; order: number; bytes: number[] }

function variableLength(value: number): number[] {
  let remaining = Math.max(0, Math.floor(value)), output = [remaining & 0x7f]
  while ((remaining >>= 7) > 0) output.unshift((remaining & 0x7f) | 0x80)
  return output
}

function chunk(id: string, data: number[]): number[] {
  const length = data.length
  return [...id].map(character => character.charCodeAt(0)).concat([
    (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255, ...data
  ])
}

export function exportMidi(project: JiProject): Uint8Array {
  const anySolo = project.tracks.some(track => track.solo)
  const sourceTracks = project.tracks.filter(track => !track.muted && (!anySolo || track.solo))
  if (!sourceTracks.length) throw new Error('没有可导出的轨道')
  const events: MidiEvent[] = []
  const add = (tick: number, order: number, ...bytes: number[]) => events.push({ tick, order, bytes })
  const meta = (tick: number, type: number, data: number[]) => add(tick, 0, 0xff, type, ...variableLength(data.length), ...data)
  meta(0, 0x03, [...new TextEncoder().encode(project.name)])
  const microseconds = Math.round(60_000_000 / project.bpm)
  meta(0, 0x51, [(microseconds >>> 16) & 255, (microseconds >>> 8) & 255, microseconds & 255])
  const [top, bottom] = project.signature.split('/').map(Number)
  meta(0, 0x58, [top, Math.round(Math.log2(bottom)), 24, 8])

  const states = CHANNELS.map(channel => ({ channel, bend: 8192, program: -1, active: [] as Array<{ pitch: number; end: number }> }))
  for (const state of states) {
    const channel = state.channel
    // RPN 0：弯音范围设为 ±2 个半音。每个复音通道独立设置。
    add(0, 0, 0xb0 | channel, 101, 0)
    add(0, 0, 0xb0 | channel, 100, 0)
    add(0, 0, 0xb0 | channel, 6, 2)
    add(0, 0, 0xb0 | channel, 38, 0)
    add(0, 0, 0xb0 | channel, 101, 127)
    add(0, 0, 0xb0 | channel, 100, 127)
  }

  const playable = sourceTracks.flatMap(track => {
    const program = Math.max(0, Math.min(127, Math.round(track.instrument.programIndex || 0)))
    return track.notes.filter(note => !note.ghost && !note.muted && Number.isFinite(note.frequency) && note.frequency > 0)
      .map(note => ({ note, program }))
  }).sort((a, b) => a.note.beat - b.note.beat || a.note.frequency - b.note.frequency)
  for (const { note, program } of playable) {
    const start = Math.max(0, Math.round(note.beat * PPQN))
    const end = Math.max(start + 1, Math.round((note.beat + note.duration) * PPQN))
    const exactPitch = 69 + 12 * Math.log2(note.frequency / 440)
    const pitch = Math.round(exactPitch)
    const bendSemitones = exactPitch - pitch
    if (pitch < 0 || pitch > 127) throw new Error('音符超出 MIDI 0–127 音域，无法无损导出')
    const bend = Math.max(0, Math.min(16383, Math.round(8192 + bendSemitones * 4096)))
    for (const state of states) state.active = state.active.filter(item => item.end > start)
    const state = states.find(item => item.program === program && item.bend === bend && !item.active.some(active => active.pitch === pitch))
      ?? states.find(item => item.active.length === 0)
    if (!state) throw new Error('同时发声且弯音不同的音符超过 15 个，MIDI 1.0 无法完整导出')
    if (state.program !== program) {
      add(start, 2, 0xc0 | state.channel, program)
      state.program = program
    }
    if (state.bend !== bend) {
      add(start, 3, 0xe0 | state.channel, bend & 0x7f, bend >>> 7)
      state.bend = bend
    }
    add(start, 4, 0x90 | state.channel, pitch, Math.max(1, Math.min(127, Math.round(note.velocity * 127))))
    add(end, 1, 0x80 | state.channel, pitch, 0)
    state.active.push({ pitch, end })
  }

  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  const data: number[] = []
  let previousTick = 0
  for (const event of events) {
    data.push(...variableLength(event.tick - previousTick), ...event.bytes)
    previousTick = event.tick
  }
  data.push(0, 0xff, 0x2f, 0)
  return Uint8Array.from([...chunk('MThd', [0, 0, 0, 1, 3, 192]), ...chunk('MTrk', data)])
}
