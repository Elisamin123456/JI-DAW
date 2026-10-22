import type { Direction, RatioSpec } from './types'

export const PRIME_COLORS: Record<number, string> = {
  2: '#aaaaaa',
  3: '#f27992',
  5: '#6cd985',
  7: '#b598ee',
  11: '#ffc247',
  13: '#b5b500',
  17: '#ed9877'
}

const COLOR_NAMES: Record<number, string> = {
  2: '灰色', 3: '红色', 5: '绿色', 7: '紫色', 11: '橙色', 13: '黄绿色', 17: '珊瑚色'
}

export interface IntervalConnectionStyle {
  color: string
  width: number
  /** 原工程 lineConfig.t：关联音音线上的连接位置，0/0.5/1 = 左/中/右。 */
  childAnchor: number
  /** 原工程 lineConfig.b：父音音线上的连接位置。 */
  parentAnchor: number
  /** 原工程 lineConfig.m：连接线中点的水平偏移。 */
  middleOffset: number
}

const INTERVAL_NAMES = new Map<string, string>([
  ['1/1', '纯一度'], ['16/15', '纯律小二度'], ['10/9', '小全音'], ['9/8', '大全音'],
  ['6/5', '纯律小三度'], ['5/4', '纯律大三度'], ['4/3', '纯四度'], ['45/32', '增四度'],
  ['64/45', '减五度'], ['3/2', '纯五度'], ['8/5', '纯律小六度'], ['5/3', '纯律大六度'],
  ['7/4', '自然七度'], ['15/8', '纯律大七度'], ['2/1', '纯八度'], ['11/8', '第 11 谐音'],
  ['13/8', '第 13 谐音'], ['81/80', '合成逗号'], ['64/63', '七限逗号'], ['33/32', '十一限微分音']
])

export function gcd(a: number, b: number): number {
  a = Math.abs(Math.trunc(a)); b = Math.abs(Math.trunc(b))
  while (b) [a, b] = [b, a % b]
  return a || 1
}

export function normalizeRatio(numerator: number, denominator: number): [number, number] {
  const g = gcd(numerator, denominator)
  return [Math.trunc(numerator / g), Math.trunc(denominator / g)]
}

export function parseRatio(numerator: string | number, denominator: string | number, direction: Direction): RatioSpec {
  const n = Number(numerator)
  const d = Number(denominator)
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n <= 0 || d <= 0) {
    throw new Error('分子与分母必须是正整数')
  }
  if (n > 1_000_000_000 || d > 1_000_000_000) throw new Error('分子与分母请勿超过 10 亿')
  let [nn, dd] = normalizeRatio(n, d)
  if (nn < dd) [nn, dd] = [dd, nn]
  return { numerator: nn, denominator: dd, direction }
}

export function ratioValue(ratio: RatioSpec): number {
  const value = ratio.numerator / ratio.denominator
  return ratio.direction === 'up' ? value : 1 / value
}

function largestPrimeFactor(value: number): number {
  let n = Math.abs(Math.trunc(value))
  let largest = 1
  while (n % 2 === 0) { largest = 2; n /= 2 }
  for (let factor = 3; factor * factor <= n; factor += 2) {
    while (n % factor === 0) { largest = factor; n /= factor }
  }
  return n > 1 ? Math.max(largest, n) : largest
}

export function primeLimit(ratio: RatioSpec): number {
  return Math.max(largestPrimeFactor(ratio.numerator), largestPrimeFactor(ratio.denominator), 2)
}

export function intervalColor(ratio?: RatioSpec): string {
  if (!ratio) return '#f2ad3f'
  const limit = primeLimit(ratio)
  if (PRIME_COLORS[limit]) return PRIME_COLORS[limit]
  return '#d6dde5'
}

/**
 * 逐项复现旧版 pitchIntervals 的 c/w/t/b/m，而不是使用统一曲线。
 * 7 限与 11 限在上下行时会交换左右端点；13/17 限保留原有外弯。
 */
export function intervalConnectionStyle(ratio: RatioSpec): IntervalConnectionStyle {
  const limit = primeLimit(ratio)
  const down = ratio.direction === 'down'
  switch (limit) {
    case 2: return { color: PRIME_COLORS[2], width: 3, childAnchor: .5, parentAnchor: .5, middleOffset: 0 }
    case 3: return { color: PRIME_COLORS[3], width: 7, childAnchor: 0, parentAnchor: 0, middleOffset: 0 }
    case 5: return { color: PRIME_COLORS[5], width: 7, childAnchor: 1, parentAnchor: 1, middleOffset: 0 }
    case 7: return { color: PRIME_COLORS[7], width: 7, childAnchor: down ? 0 : 1, parentAnchor: down ? 1 : 0, middleOffset: 0 }
    case 11: return { color: PRIME_COLORS[11], width: 7, childAnchor: down ? 1 : 0, parentAnchor: down ? 0 : 1, middleOffset: 0 }
    case 13: return { color: PRIME_COLORS[13], width: 7, childAnchor: 0, parentAnchor: 0, middleOffset: -16 }
    case 17: return { color: PRIME_COLORS[17], width: 7, childAnchor: 1, parentAnchor: 1, middleOffset: 16 }
    default: return { color: '#d6dde5', width: 7, childAnchor: .5, parentAnchor: .5, middleOffset: 0 }
  }
}

export function centsOf(ratio: RatioSpec): number {
  return 1200 * Math.log2(ratioValue(ratio))
}

function octaveReducedKey(ratio: RatioSpec): string {
  let n = ratio.direction === 'up' ? ratio.numerator : ratio.denominator
  let d = ratio.direction === 'up' ? ratio.denominator : ratio.numerator
  while (n / d >= 2) d *= 2
  while (n / d < 1) n *= 2
  ;[n, d] = normalizeRatio(n, d)
  return `${n}/${d}`
}

export function intervalName(ratio?: RatioSpec): string {
  if (!ratio) return '独立基音'
  const key = octaveReducedKey(ratio)
  const base = INTERVAL_NAMES.get(key) ?? `${primeLimit(ratio)} 限纯律音程`
  return ratio.direction === 'down' ? `下行${base}` : base
}

export function ratioLabel(ratio: RatioSpec): string {
  const sign = ratio.direction === 'down' ? '↓' : '↑'
  return `${sign}${ratio.numerator}/${ratio.denominator}`
}

export function ratioDescription(ratio: RatioSpec): string {
  const limit = primeLimit(ratio)
  const colorName = COLOR_NAMES[limit] ?? '白色'
  return `${ratio.numerator}/${ratio.denominator} · ${Math.abs(centsOf(ratio)).toFixed(3)} 音分 · ${limit} 限（${colorName}）`
}
