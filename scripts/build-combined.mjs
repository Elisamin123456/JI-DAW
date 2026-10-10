import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('必须通过 npm run build 启动组合构建')

function run(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// 单轨保留专用 Web 界面；完整模式始终直接构建本地端的当前源码。
run(['run', 'build:complete'], webRoot)
run(['run', 'build:single'], webRoot)

const webDist = resolve(webRoot, 'dist')
const completeDist = resolve(webRoot, '.complete-dist')
const completeAssets = resolve(webDist, 'complete-assets')
rmSync(completeAssets, { recursive: true, force: true })
cpSync(resolve(completeDist, 'assets'), completeAssets, { recursive: true })

const singleHtml = readFileSync(resolve(webDist, 'index.html'), 'utf8')
const completeHtml = readFileSync(resolve(completeDist, 'index.html'), 'utf8')
  .replaceAll('./assets/', './complete-assets/')
writeFileSync(resolve(webDist, 'single.html'), singleHtml)
writeFileSync(resolve(webDist, 'complete.html'), completeHtml)
writeFileSync(resolve(webDist, 'index.html'), readFileSync(resolve(webRoot, 'router.html'), 'utf8'))

// 同步可直接部署的固定入口与资源；sound/ 和 DEMO.jidaw 由项目继续共用。
for (const directory of ['assets', 'complete-assets']) {
  const target = resolve(webRoot, directory)
  rmSync(target, { recursive: true, force: true })
  cpSync(resolve(webDist, directory), target, { recursive: true })
}
for (const file of ['single.html', 'complete.html']) {
  writeFileSync(resolve(webRoot, file), readFileSync(resolve(webDist, file)))
}
mkdirSync(resolve(webRoot, 'assets'), { recursive: true })
