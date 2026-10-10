export type Direction = 'up' | 'down'

export interface RatioSpec {
  numerator: number
  denominator: number
  direction: Direction
}

export interface JiNote {
  id: string
  trackId: string
  beat: number
  duration: number
  frequency: number
  velocity: number
  muted?: boolean
  /** “移动音程”后保留的原位置参考音；只显示，不参与播放。 */
  ghost?: boolean
  parentId?: string
  ratio?: RatioSpec
  /** 可选的单音显示颜色；未设置时沿用界面默认色。 */
  color?: string
}

export type TuningSystem = 'preset' | 'ratio' | 'edo'

export interface TuningInterval {
  numerator?: number
  denominator?: number
  steps?: number
}

export interface JiAnnotation {
  id: string
  trackId: string
  beat: number
  frequency: number
  html: string
}

export interface InstrumentState {
  kind: 'builtin' | 'synth' | 'sf2'
  name: string
  builtinId?: string
  synthId?: string
  path?: string
  programIndex: number
  programName?: string
  missing?: boolean
}

export interface Track {
  id: string
  name: string
  color: string
  volume: number
  pan: number
  muted: boolean
  solo: boolean
  height: number
  instrument: InstrumentState
  notes: JiNote[]
  annotations: JiAnnotation[]
}

export interface JiProject {
  version: 2
  name: string
  bpm: number
  signature: string
  snap: number
  bars: number
  loop: boolean
  metronome: boolean
  /** 是否在播放与导出时应用八分音符 Swing。 */
  swingEnabled: boolean
  /** Swing 强度：0 为直拍，100 为最强延迟。 */
  swingAmount: number
  /** 十二个半音相对所选主音的纯律比例，从主音到大七度排列。 */
  pitchRatios: Array<[number, number]>
  /** 决定十二音中哪些音参与音高吸附。 */
  pitchMode: string
  /** 主音的十二平均律音级编号：C=0，C♯=1……B=11。 */
  pitchTonic: number
  /** 固定调式、自由纯律比例或自由 N-EDO。 */
  tuningSystem: TuningSystem
  /** EDO 模式的八度等分数。 */
  tuningEdo: number
  /** 在 EDO 模式下，非破坏地把全部音符投影到完整 N-EDO 格点。 */
  harmonizeRatiosToEdo: boolean
  /** 自由调律的音程列表；基音 1/1（或 0 步）始终隐含存在。 */
  tuningIntervals: TuningInterval[]
  tracks: Track[]
}

export interface DesktopFileResult {
  path: string
  name?: string
  text?: string
  bytes?: Uint8Array | { data: number[] }
}

export interface DesktopBridge {
  openProject(): Promise<DesktopFileResult | null>
  openMidi(): Promise<DesktopFileResult | null>
  saveProject(payload: { path?: string; name: string; text: string }): Promise<{ path: string } | null>
  openSf2(): Promise<DesktopFileResult | null>
  readSf2(path: string): Promise<DesktopFileResult | null>
  readBuiltinSound(path: string): Promise<DesktopFileResult | null>
}

declare global {
  interface Window {
    desktop?: DesktopBridge
  }
}
