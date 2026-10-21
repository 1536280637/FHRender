# HF Render

可视化 HyperFrames 渲染工具。选择项目目录 → 设置导出参数 → 开始渲染 → 查看实时进度与日志 → 拿到视频文件。

它不是视频编辑器，也不重新实现渲染能力：所有渲染都交给本机的 HyperFrames CLI（`npx hyperframes render`），本工具负责把这些步骤组织成可用的桌面界面。

![icon](./build/icon.png)

## 功能

- **项目管理**：识别 HyperFrames 项目（`index.html` / `package.json` / `hyperframes.json`），读取分辨率与时长，支持最近项目与手动指定 composition
- **导出参数**：MP4 / WebM / MOV / GIF / PNG 序列 / HLS，帧率、质量、分辨率预设、输出位置
- **高级参数**：Docker 渲染、GPU 编码、Browser GPU、Workers、CRF、码率等
- **预设系统**：4 个内置预设，支持保存 / 更新 / 删除自定义预设
- **渲染过程**：实时日志、结构化进度、耗时统计、输出信息、随时停止（含子进程树）
- **性能页**：硬件与编码器实测、项目负载分析、四种优化模式、基准测试、实时资源监控
- **一键预览**：启动 HyperFrames Preview 并打开 HyperFrames Studio
- **环境检测**：Node.js / npm / HyperFrames CLI / Chrome / FFmpeg 逐项自检
- 浅色 / 深色主题，自定义标题栏

## 环境要求

- Windows 10/11（主目标），macOS / Linux 亦可运行
- Node.js 18+（建议 20 / 22 LTS）
- FFmpeg（可用 `npx hyperframes doctor` 自检）
- 首次渲染需联网（自动下载 HyperFrames CLI 与 chrome-headless-shell）

## 开发与运行

```bash
npm install          # 安装依赖
npm run dev          # 开发模式：Vite HMR + Electron
npm run typecheck    # TypeScript 类型检查
npm run build        # 构建到 out/
npm start            # 构建后以生产模式启动
```

## 打包

```bash
npm run dist         # Windows NSIS 安装包 → dist/HF-Render-<版本>-x64-Setup.exe
npm run dist:dir     # 未压缩目录版
npm run dist:mac     # macOS dmg（需在 macOS 上执行）
npm run dist:linux   # Linux AppImage（需在 Linux 上执行）
```

## 项目结构

```
src/
  main/       主进程（渲染调度、进程管理、服务层、IPC）
  preload/    contextBridge 安全 API
  renderer/   React + Vite 界面
  shared/     主/渲染进程共享类型与 IPC 常量
```

## License

[MIT](./LICENSE)
