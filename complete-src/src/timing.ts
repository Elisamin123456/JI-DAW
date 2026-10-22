import type { JiProject } from './types'

/** FL Studio 式十六分 Swing：只延迟每两个十六分中的第二个触发点。 */
export function swungBeat(beat: number, project: Pick<JiProject, 'swingEnabled' | 'swingAmount'>): number {
  if (!project.swingEnabled || project.swingAmount <= 0 || !Number.isFinite(beat)) return beat
  const sixteenth = Math.round(beat * 4)
  if (Math.abs(beat - sixteenth / 4) > 1e-6 || Math.abs(sixteenth % 2) !== 1) return beat
  return beat + Math.min(100, Math.max(0, project.swingAmount)) / 1200
}
