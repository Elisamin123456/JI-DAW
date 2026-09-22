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
  /** 十二个半音相对所选主音的纯律比例，从主音到大七度排列。 */
  pitchRatios: Array<[number, number]>
  /** 决定十二音中哪些音参与音高吸附。 */
  pitchMode: string
  /** 主音的十二平均律音级编号：C=0，C♯=1……B=11。 */
  pitchTonic: number
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
