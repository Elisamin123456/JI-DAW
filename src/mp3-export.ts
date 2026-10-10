import { Mp3Encoder } from '@breezystack/lamejs'

function pcm16Block(source: Float32Array, from: number, size: number): Int16Array {
  const result = new Int16Array(size)
  const to = Math.min(source.length, from + size)
  for (let input = from, output = 0; input < to; input++, output++) {
    const raw = source[input]
    const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0
    result[output] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767)
  }
  return result
}

export async function encodeMp3(buffer: AudioBuffer, kbps = 192): Promise<Uint8Array> {
  if (!buffer.length || !Number.isFinite(buffer.sampleRate) || buffer.sampleRate < 8000 || buffer.sampleRate > 48000) throw new Error('音频缓冲区无法编码为 MP3')
  const left = buffer.getChannelData(0)
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left
  const encoder = new Mp3Encoder(2, buffer.sampleRate, kbps)
  const chunks: Uint8Array[] = []
  const blockSize = 1152
  let lastAudible = buffer.length - 1
  while (lastAudible > 0 && Math.abs(left[lastAudible]) < .00001 && Math.abs(right[lastAudible]) < .00001) lastAudible--
  const encodeLength = Math.min(buffer.length, lastAudible + 1 + Math.round(buffer.sampleRate * .2))
  let total = 0
  for (let offset = 0, block = 0; offset < encodeLength; offset += blockSize, block++) {
    const encoded = encoder.encodeBuffer(pcm16Block(left, offset, blockSize), pcm16Block(right, offset, blockSize))
    if (encoded.length) { const copy = encoded.slice(); chunks.push(copy); total += copy.length }
    if (block % 96 === 95) await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  const final = encoder.flush()
  if (final.length) { const copy = final.slice(); chunks.push(copy); total += copy.length }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
  if (output.length < 4) throw new Error('MP3 编码器没有产生有效数据')
  return output
}
