import { copyFileSync, cpSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [{
    name: 'copy-instruments',
    closeBundle() {
      cpSync('sound', 'dist/sound', { recursive: true })
      copyFileSync('DEMO.jidaw', 'dist/DEMO.jidaw')
      copyFileSync('dist/index.source.html', 'dist/index.html')
    }
  }],
  build: {
    target: 'es2022', outDir: 'dist', emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, 'index.source.html'), output: {
      entryFileNames: 'assets/app.js', chunkFileNames: 'assets/[name].js',
      assetFileNames: asset => asset.names.some(name => name.endsWith('.css')) ? 'assets/app.css' : 'assets/[name][extname]'
    } }
  }
})
