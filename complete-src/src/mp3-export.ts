import type { RenderChunk } from './audio'

export interface Mp3ExportOptions {
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
  kbps?: number
}

/** Transfer small PCM blocks with backpressure; never queue a whole song. */
export async function encodeMp3(chunks: AsyncIterable<RenderChunk>, options: Mp3ExportOptions = {}): Promise<Blob> {
  const { signal, onProgress, kbps = 192 } = options
  signal?.throwIfAborted()
  const worker = new Worker(new URL('./mp3-worker.ts', import.meta.url), { type: 'module' })
  let sequence = 0
  let pending: { resolve: (blob?: Blob) => void; reject: (error: Error) => void } | undefined
  let failure: Error | undefined
  const fail = (error: Error) => { failure = error; pending?.reject(error); pending = undefined }
  const abort = () => { fail(new DOMException('已取消导出', 'AbortError')); worker.terminate() }
  worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'MP3 编码线程启动失败')) }
  worker.onmessageerror = () => fail(new Error('无法读取 MP3 编码结果'))
  worker.onmessage = event => {
    if (event.data.error) fail(new Error(event.data.error))
    else { pending?.resolve(event.data.blob); pending = undefined }
  }
  signal?.addEventListener('abort', abort, { once: true })
  const request = (payload: object, transfers: Transferable[] = []) => new Promise<Blob | undefined>((resolve, reject) => {
    signal?.throwIfAborted()
    if (failure) { reject(failure); return }
    pending = { resolve, reject }
    worker.postMessage({ ...payload, id: sequence++ }, transfers)
  })
  try {
    await request({ type: 'init', sampleRate: 44100, kbps })
    for await (const chunk of chunks) {
      signal?.throwIfAborted()
      if (failure) throw failure
      const { buffer, from, length, completedFrames, totalFrames } = chunk
      if (buffer.sampleRate !== 44100) throw new Error('MP3 渲染采样率必须为 44100 Hz')
      const left = buffer.getChannelData(0), right = buffer.getChannelData(1)
      for (let offset = 0; offset < length; offset += 65536) {
        const size = Math.min(65536, length - offset)
        const l = left.slice(from + offset, from + offset + size)
        const r = right.slice(from + offset, from + offset + size)
        await request({ type: 'pcm', left: l, right: r }, [l.buffer, r.buffer])
        onProgress?.((completedFrames + offset + size) / totalFrames)
      }
    }
    const blob = await request({ type: 'finish' })
    if (!blob) throw new Error('MP3 编码器没有返回文件')
    return blob
  } finally {
    signal?.removeEventListener('abort', abort)
    worker.terminate()
  }
}
