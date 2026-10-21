// 构建脚本：esbuild 打包主进程 / preload，vite 打包渲染进程
import { build as esbuild } from 'esbuild'
import { build as viteBuild } from 'vite'
import { rm, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(root, 'out')

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  external: ['electron'],
  logLevel: 'info',
  alias: {
    '@shared': resolve(root, 'src/shared')
  }
}

async function main() {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  await esbuild({
    ...shared,
    entryPoints: [resolve(root, 'src/main/index.ts')],
    outfile: resolve(outDir, 'main/index.js')
  })

  await esbuild({
    ...shared,
    entryPoints: [resolve(root, 'src/preload/index.ts')],
    outfile: resolve(outDir, 'preload/index.js')
  })

  await viteBuild({ configFile: resolve(root, 'vite.config.mts') })
  console.log('\n[build] 完成：out/main、out/preload、out/renderer')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
