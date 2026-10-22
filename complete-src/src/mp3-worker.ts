import { Mp3Encoder } from '@breezystack/lamejs'

// Keep one encoder and one partial MPEG frame for the entire export. Padding
// intermediate render chunks would insert silence at every boundary.
let encoder: Mp3Encoder | undefined
const leftFrame = new Int16Array(1152), rightFrame = new Int16Array(1152)
let used = 0
let parts: Uint8Array<ArrayBuffer>[] = []

function collect(bytes: Int8Array | Uint8Array): void {
  if (bytes.length) parts.push(new Uint8Array(bytes))
}

function pcm16(raw: number): number {
  const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0
  return Math.round(sample * (sample < 0 ? 32768 : 32767))
}

self.onmessage = (event: MessageEvent) => {
  try {
    const { type, id, sampleRate, kbps, left, right } = event.data
    if (type === 'init') {
      encoder = new Mp3Encoder(2, sampleRate, kbps)
      used = 0; parts = []
    } else if (type === 'pcm') {
      if (!encoder) throw new Error('MP3 编码器尚未初始化')
      for (let i = 0; i < left.length; i++) {
        leftFrame[used] = pcm16(left[i]); rightFrame[used] = pcm16(right[i]); used++
        if (used === 1152) {
          collect(encoder.encodeBuffer(leftFrame, rightFrame)); used = 0
        }
      }
    } else if (type === 'finish') {
      if (!encoder) throw new Error('MP3 编码器尚未初始化')
      if (used) {
        leftFrame.fill(0, used); rightFrame.fill(0, used)
        collect(encoder.encodeBuffer(leftFrame, rightFrame))
      }
      collect(encoder.flush())
      const blob = new Blob(parts, { type: 'audio/mpeg' })
      if (blob.size < 4) throw new Error('MP3 编码器没有产生有效数据')
      parts = []; encoder = undefined
      self.postMessage({ id, blob }); return
    } else throw new Error('未知 MP3 编码请求')
    self.postMessage({ id })
  } catch (error) {
    self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) })
  }
}
