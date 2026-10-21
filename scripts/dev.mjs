// 开发脚本：启动 vite dev server，再以开发模式拉起 electron
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import electronPath from 'electron'

const root = resolve(import.meta.dirname, '..')

const server = await createServer({ configFile: resolve(root, 'vite.config.mts') })
await server.listen()
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5199/'
server.printUrls()

const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' }
})

child.on('close', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill()
  })
}
