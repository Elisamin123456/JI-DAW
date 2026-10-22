import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Keep the static Pages deployment self-contained without oversized Git blobs.
const webRoot = resolve(import.meta.dirname, '..')
const source = process.argv[2]
if (!source) throw new Error('Usage: node scripts/split-soundfont.mjs /path/to/Touhou.sf2')
const bytes = readFileSync(source), size = 32 * 1024 * 1024, parts = []
for (let offset = 0; offset < bytes.length; offset += size) {
  const part = bytes.subarray(offset, Math.min(bytes.length, offset + size))
  const file = `Touhou.sf2.part${String(parts.length + 1).padStart(2, '0')}`
  writeFileSync(resolve(webRoot, 'sound', file), part)
  parts.push({ file, size: part.length })
}
writeFileSync(resolve(webRoot, 'sound', 'Touhou.sf2.json'), `${JSON.stringify({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), parts }, null, 2)}\n`)
console.log(`Touhou.sf2: ${bytes.length} bytes in ${parts.length} parts`)
