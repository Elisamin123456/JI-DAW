export type Fraction = [number, number]

export const TONIC_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const
export const NATURAL_PITCH_CLASSES = [0, 2, 4, 5, 7, 9, 11] as const

const TONIC_SPELLINGS = [
  [0, 0], [0, 1], [1, 0], [2, -1], [2, 0], [3, 0],
  [3, 1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]
] as const

// 十二个位置分别写作：1、♯1、2、♭3、3、4、♯4、5、♭6、6、♭7、7。
const RELATIVE_LETTER_STEPS = [0, 0, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6] as const
const MINOR_PROFILES = new Set(['dorian', 'phrygian', 'aeolian', 'locrian', 'minor-pentatonic'])
const MODE_LETTER_OVERRIDES: Record<string, Partial<Record<number, number>>> = {
  phrygian: { 1: 1 },
  locrian: { 1: 1, 6: 4 }
}

export const LEGACY_PITCH_RATIOS: Fraction[] = [[1, 1], [16, 15], [9, 8], [6, 5], [5, 4], [4, 3], [45, 32], [3, 2], [8, 5], [5, 3], [9, 5], [15, 8]]

function gcd(a: number, b: number): number {
  a = Math.abs(Math.trunc(a)); b = Math.abs(Math.trunc(b))
  while (b) [a, b] = [b, a % b]
  return a || 1
}

function reduce([numerator, denominator]: Fraction): Fraction {
  const divisor = gcd(numerator, denominator)
  return [numerator / divisor, denominator / divisor]
}

function multiply(left: Fraction, right: Fraction): Fraction {
  return reduce([left[0] * right[0], left[1] * right[1]])
}

function octaveReduce(ratio: Fraction): Fraction {
  let [numerator, denominator] = reduce(ratio)
  while (numerator < denominator) numerator *= 2
  while (numerator >= denominator * 2) denominator *= 2
  return reduce([numerator, denominator])
}

function interval(root: Fraction, ratio: Fraction): Fraction {
  return octaveReduce(multiply(root, ratio))
}

function majorTriad(root: Fraction): [Fraction, Fraction, Fraction] {
  return [root, interval(root, [5, 4]), interval(root, [3, 2])]
}

function minorTriad(root: Fraction): [Fraction, Fraction, Fraction] {
  return [root, interval(root, [6, 5]), interval(root, [3, 2])]
}

function majorProfile(): Fraction[] {
  const tonic: Fraction = [1, 1]
  const subdominantRoot = interval(tonic, [2, 3])
  const dominantRoot = interval(tonic, [3, 2])
  const [, majorThird, dominant] = majorTriad(tonic)
  const [, sixth] = majorTriad(subdominantRoot)
  const [, leadingTone, second] = majorTriad(dominantRoot)
  const raisedTonic = interval(sixth, [5, 4]) // A 大三和弦的三音：C♯ = 25/24（以 C 为例）
  return [
    tonic, raisedTonic, second, minorTriad(tonic)[1], majorThird, subdominantRoot,
    interval(second, [5, 4]), dominant, minorTriad(subdominantRoot)[1], sixth,
    [7, 4], // 主和弦的协和七度：C7 的 B♭ = 7/4
    leadingTone
  ]
}

function minorProfile(): Fraction[] {
  const tonic: Fraction = [1, 1]
  const subdominantRoot = interval(tonic, [2, 3])
  const dominantRoot = interval(tonic, [3, 2])
  const [, minorThird, dominant] = minorTriad(tonic)
  const [, naturalSixth] = minorTriad(subdominantRoot)
  const [, naturalSeventh, second] = minorTriad(dominantRoot)
  const [, melodicSixth] = majorTriad(subdominantRoot)
  const [, melodicSeventh] = majorTriad(dominantRoot)
  return [
    tonic, interval(melodicSixth, [5, 4]), second, minorThird, majorTriad(tonic)[1], subdominantRoot,
    interval(second, [5, 4]), dominant, naturalSixth, melodicSixth, naturalSeventh, melodicSeventh
  ]
}

export function tuningProfile(mode: string): 'major' | 'minor' {
  return MINOR_PROFILES.has(mode) ? 'minor' : 'major'
}

export function generateTwelveToneRatios(mode: string): Fraction[] {
  const ratios = (tuningProfile(mode) === 'minor' ? minorProfile() : majorProfile()).map(([numerator, denominator]) => [numerator, denominator] as Fraction)
  if (mode === 'phrygian' || mode === 'locrian') ratios[1] = [16, 15] // 降二度，而不是升一度
  if (mode === 'locrian') ratios[6] = [64, 45] // 减五度，而不是增四度
  return ratios
}

export function isLegacyPitchRatios(ratios: Fraction[]): boolean {
  return ratios.length === LEGACY_PITCH_RATIOS.length && ratios.every((ratio, index) => ratio[0] === LEGACY_PITCH_RATIOS[index][0] && ratio[1] === LEGACY_PITCH_RATIOS[index][1])
}

export interface PitchClassSpelling { letter: number; accidental: number }

export function pitchClassSpelling(tonicPitchClass: number, semitonesFromTonic: number, mode = 'chromatic'): PitchClassSpelling {
  const tonic = TONIC_SPELLINGS[((tonicPitchClass % 12) + 12) % 12]
  const offset = ((semitonesFromTonic % 12) + 12) % 12
  const letterStep = MODE_LETTER_OVERRIDES[mode]?.[offset] ?? RELATIVE_LETTER_STEPS[offset]
  const letter = (tonic[0] + letterStep) % 7
  const pitchClass = (tonicPitchClass + offset) % 12
  let accidental = pitchClass - NATURAL_PITCH_CLASSES[letter]
  while (accidental > 6) accidental -= 12
  while (accidental < -6) accidental += 12
  return { letter, accidental }
}

export function pitchNameForOffset(tonicPitchClass: number, semitonesFromTonic: number, mode = 'chromatic'): string {
  const spelling = pitchClassSpelling(tonicPitchClass, semitonesFromTonic, mode)
  const accidental = spelling.accidental > 0 ? '♯'.repeat(spelling.accidental) : '♭'.repeat(-spelling.accidental)
  return `${'CDEFGAB'[spelling.letter]}${accidental}`
}
