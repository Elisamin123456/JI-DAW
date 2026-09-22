import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('assets', { recursive: true })
cpSync('dist/assets', 'assets', { recursive: true })
