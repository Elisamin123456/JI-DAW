import { cpSync } from 'node:fs'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [{
    name: 'copy-instruments',
    closeBundle() { cpSync('sound', 'dist/sound', { recursive: true }) }
  }],
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true }
})
