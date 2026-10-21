// electron 桩：逻辑测试不碰真实 Electron，只需 app.getPath 返回临时目录
exports.app = {
  getPath: (name) => {
    if (name === 'userData') return require('node:os').tmpdir() + '/hf-render-logic-test'
    return require('node:os').tmpdir()
  },
  getVersion: () => '0.0.0-test'
}
exports.BrowserWindow = class {}
exports.ipcMain = { handle: () => {}, on: () => {} }
exports.shell = {}
exports.contextBridge = { exposeInMainWorld: () => {} }
exports.ipcRenderer = { invoke: async () => null, on: () => {}, removeListener: () => {} }
