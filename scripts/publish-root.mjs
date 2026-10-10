import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

for (const directory of ['assets', 'complete-assets']) {
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  cpSync(`dist/${directory}`, directory, { recursive: true })
}
for (const file of ['single.html', 'complete.html']) writeFileSync(file, readFileSync(`dist/${file}`))
