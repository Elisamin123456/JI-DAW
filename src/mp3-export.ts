import { Mp3Encoder } from '@breezystack/lamejs'

function pcm16(source: Float32Array, from: number, to: number): Int16Array {
  const result = new Int16Array(to - from)
  for (let input = from, output = 0; input < to; input++, output++) {
    const sample = Math.max(-1, Math.min(1, source[input]))
    result[output] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767)
  }
  return result
}

export async function encodeMp3(buffer: AudioBuffer, kbps = 192): Promise<Uint8Array> {
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
    const end = Math.min(encodeLength, offset + blockSize)
    const encoded = encoder.encodeBuffer(pcm16(left, offset, end), pcm16(right, offset, end))
    if (encoded.length) { const copy = encoded.slice(); chunks.push(copy); total += copy.length }
    if (block % 128 === 127) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
  const final = encoder.flush()
  if (final.length) { const copy = final.slice(); chunks.push(copy); total += copy.length }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
  return output
}
