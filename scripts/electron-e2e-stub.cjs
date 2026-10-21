// e2e 专用 electron 桩：只提供 BenchmarkEngine / CliAdapter 需要的最小 API。
// userData 通过 HF_RENDER_E2E_USERDATA 指定，避免污染真实应用数据目录。
const path = require('node:path')
const os = require('node:os')

exports.app = {
  getPath: (name) => {
    if (name === 'userData') {
      return process.env.HF_RENDER_E2E_USERDATA || path.join(process.env.APPDATA || os.homedir(), 'HF Render')
    }
    return os.tmpdir()
  },
  getVersion: () => '0.0.0-e2e',
  getName: () => 'HF Render'
}
exports.BrowserWindow = class {}
exports.ipcMain = { handle: () => {}, on: () => {} }
exports.shell = {}
exports.contextBridge = { exposeInMainWorld: () => {} }
exports.ipcRenderer = { invoke: async () => null, on: () => {}, removeListener: () => {} }
