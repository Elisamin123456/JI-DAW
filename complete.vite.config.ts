import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const webRoot = import.meta.dirname
const localAppRoot = resolve(webRoot, 'complete-src')

// 完整模式源码随仓库发布；无需依赖仓库外的本地端目录。
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
