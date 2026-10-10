import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const webRoot = import.meta.dirname
const localAppRoot = resolve(webRoot, '..')

// 只读取本地端入口与源码；所有输出严格落在 Web 子项目中。
export default defineConfig({
  root: localAppRoot,
  base: './',
  build: {
    target: 'chrome136',
    outDir: resolve(webRoot, '.complete-dist'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(localAppRoot, 'index.html') }
  }
})
