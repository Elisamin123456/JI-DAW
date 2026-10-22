export interface MidiNoteEvent {
  tick: number
  durationTicks: number
  pitch: number
  velocity: number
  channel: number
  program: number
  bendSemitones: number
}

export interface MidiTrackData {
  name: string
  notes: MidiNoteEvent[]
}

export interface ParsedMidi {
  format: number
  division: number
  bpm: number
  signature?: string
  tracks: MidiTrackData[]
}

class Reader {
  offset = 0
  constructor(readonly bytes: Uint8Array) {}
  remaining(): number { return this.bytes.length - this.offset }
  u8(): number {
    if (this.remaining() < 1) throw new Error('MIDI 文件意外结束')
    return this.bytes[this.offset++]
  }
  u16(): number { return this.u8() * 0x100 + this.u8() }
  u32(): number { return this.u16() * 0x10000 + this.u16() }
  take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.remaining() < length) throw new Error('MIDI 数据块长度无效')
    const value = this.bytes.subarray(this.offset, this.offset + length); this.offset += length; return value
  }
  id(): string { return String.fromCharCode(...this.take(4)) }
}

function variableLength(reader: Reader): number {
  let value = 0
  for (let index = 0; index < 4; index++) {
    const byte = reader.u8(); value = value * 128 + (byte & 0x7f)
    if (!(byte & 0x80)) return value
  }
  throw new Error('MIDI 可变长度数值无效')
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0+$/g, '').trim()
}

function parseTrack(bytes: Uint8Array, division: number, tempos: Array<{ tick: number; microseconds: number }>, signatures: Array<{ tick: number; value: string }>): MidiTrackData {
  const reader = new Reader(bytes), notes: MidiNoteEvent[] = [], programs = Array<number>(16).fill(0)
  const bends = Array<number>(16).fill(8192), bendRanges = Array<number>(16).fill(2)
  const rpnMsb = Array<number>(16).fill(127), rpnLsb = Array<number>(16).fill(127)
  const open = new Map<string, Array<{ tick: number; velocity: number; program: number; bendSemitones: number }>>()
  let tick = 0, runningStatus = 0, name = '', lastTick = 0
  const finish = (channel: number, pitch: number) => {
    const key = `${channel}:${pitch}`, queue = open.get(key), start = queue?.shift(); if (!start) return
    notes.push({ tick: start.tick, durationTicks: Math.max(1, tick - start.tick), pitch, velocity: start.velocity, channel, program: start.program, bendSemitones: start.bendSemitones })
    if (!queue?.length) open.delete(key)
  }
  while (reader.remaining() > 0) {
    tick += variableLength(reader); lastTick = Math.max(lastTick, tick)
    let status = reader.u8(), firstData: number | undefined
    if (status < 0x80) {
      if (runningStatus < 0x80) throw new Error('MIDI Running Status 无效')
      firstData = status; status = runningStatus
    } else if (status < 0xf0) runningStatus = status
    if (status === 0xff) {
      runningStatus = 0
      const type = reader.u8(), data = reader.take(variableLength(reader))
      if (type === 0x03 && !name) name = text(data)
      else if (type === 0x51 && data.length === 3) tempos.push({ tick, microseconds: data[0] * 0x10000 + data[1] * 0x100 + data[2] })
      else if (type === 0x58 && data.length >= 2) signatures.push({ tick, value: `${data[0]}/${2 ** data[1]}` })
      if (type === 0x2f) break
      continue
    }
    if (status === 0xf0 || status === 0xf7) { runningStatus = 0; reader.take(variableLength(reader)); continue }
    if (status >= 0xf0) throw new Error(`不支持的 MIDI 系统事件：0x${status.toString(16)}`)
    const command = status & 0xf0, channel = status & 0x0f
    const data1 = firstData ?? reader.u8()
    if (command === 0xc0) { programs[channel] = data1; continue }
    if (command === 0xd0) continue
    const data2 = reader.u8()
    if (command === 0xe0) { bends[channel] = data1 | (data2 << 7); continue }
    if (command === 0xb0) {
      if (data1 === 101) rpnMsb[channel] = data2
      else if (data1 === 100) rpnLsb[channel] = data2
      else if (data1 === 6 && rpnMsb[channel] === 0 && rpnLsb[channel] === 0) bendRanges[channel] = data2
      continue
    }
    if (command === 0x90 && data2 > 0) {
      const key = `${channel}:${data1}`, queue = open.get(key) ?? []
      queue.push({ tick, velocity: data2, program: programs[channel], bendSemitones: (bends[channel] - 8192) / 8192 * bendRanges[channel] }); open.set(key, queue)
    } else if (command === 0x80 || (command === 0x90 && data2 === 0)) finish(channel, data1)
  }
  const closingTick = Math.max(lastTick, ...[...open.values()].flat().map(item => item.tick + division))
  tick = closingTick
  for (const key of [...open.keys()]) {
    const [channel, pitch] = key.split(':').map(Number)
    while (open.has(key)) finish(channel, pitch)
  }
  notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
  return { name, notes }
}

export function parseMidi(bytes: Uint8Array): ParsedMidi {
  const reader = new Reader(bytes)
  if (reader.id() !== 'MThd') throw new Error('不是标准 MIDI 文件')
  const headerLength = reader.u32(); if (headerLength < 6) throw new Error('MIDI 头无效')
  const header = new Reader(reader.take(headerLength)), format = header.u16(), trackCount = header.u16(), division = header.u16()
  if (format > 2) throw new Error(`不支持的 MIDI 格式：${format}`)
  if (division & 0x8000) throw new Error('暂不支持 SMPTE 时间格式的 MIDI')
  if (!division) throw new Error('MIDI PPQN 无效')
  const tempos: Array<{ tick: number; microseconds: number }> = [], signatures: Array<{ tick: number; value: string }> = [], tracks: MidiTrackData[] = []
  while (reader.remaining() >= 8 && tracks.length < trackCount) {
    const id = reader.id(), length = reader.u32(), data = reader.take(length)
    if (id === 'MTrk') tracks.push(parseTrack(data, division, tempos, signatures))
  }
  if (!tracks.length) throw new Error('MIDI 文件中没有轨道')
  tempos.sort((a, b) => a.tick - b.tick); signatures.sort((a, b) => a.tick - b.tick)
  const microseconds = tempos[0]?.microseconds || 500000
  return { format, division, bpm: Math.max(20, Math.min(400, 60000000 / microseconds)), signature: signatures[0]?.value, tracks }
}
