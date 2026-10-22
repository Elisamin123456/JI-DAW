import type { JiProject } from './types'

const storageKey = 'ji-daw-last-mp3-export-log'
let latest = ''

export function lastExportLog(): string {
  try { return latest || localStorage.getItem(storageKey) || '' } catch { return latest }
}

export class ExportLog {
  readonly id = `mp3-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`
  private started = performance.now()
  private entries: object[] = []
  private pending = Promise.resolve()
  path?: string
  readonly context: object

  constructor(project: JiProject, projectPath: string | undefined) {
    this.context = {
      format: 'JI-DAW MP3 export log v1', id: this.id, startedAt: new Date().toISOString(),
      project: project.name, projectPath, bpm: project.bpm, bars: project.bars, signature: project.signature,
      environment: { userAgent: navigator.userAgent, url: location.href, desktop: Boolean(window.desktop) },
      tracks: project.tracks.map(track => ({ id: track.id, name: track.name, type: track.type, muted: track.muted, solo: track.solo,
        instrument: track.instrument, notes: track.notes.length, audioClips: track.audioClips }))
    }
  }

  record(stage: string, details?: unknown): void {
    this.entries.push({ at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - this.started), stage, details })
    if (this.entries.length > 500) this.entries.splice(1, 1)
    latest = this.text()
    try { localStorage.setItem(storageKey, latest) } catch { /* Download remains available if storage is full. */ }
    const write = window.desktop?.writeExportLog
    if (write) {
      const text = latest
      this.pending = this.pending.then(async () => {
        try { this.path = (await write({ id: this.id, text })).path } catch { /* Keep the browser copy and manual save. */ }
      })
    }
  }

  error(stage: string, error: unknown): void {
    this.record(stage, error instanceof Error ? { name: error.name, message: error.message, stack: error.stack,
      cause: error.cause instanceof Error ? { message: error.cause.message, stack: error.cause.stack } : String(error.cause ?? '') } : String(error))
  }

  text(): string { return JSON.stringify({ ...this.context, events: this.entries }, null, 2) }
  async flush(): Promise<void> { await this.pending }
}
