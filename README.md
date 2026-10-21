# HF Render

HyperFrames 视频项目的本地渲染桌面工具。选择项目目录 → 设置导出参数 → 选择导出位置 → 开始渲染 → 查看实时日志与真实进度 → 拿到视频文件。

它不是视频编辑器，也不重新实现渲染能力：所有渲染都交给本机的 HyperFrames CLI（`npx hyperframes render`），本工具负责把这些步骤组织成可用的桌面界面。

![界面](./build/icon.png)

---

## 1. 功能

| 模块 | 能力 |
| --- | --- |
| 项目 | 选择/更换项目目录、识别 `index.html`、`package.json`、`hyperframes.json`、读取分辨率与时长、最近项目、重新检测、手动指定 composition |
| 导出参数 | 格式（MP4 / WebM / MOV / GIF / PNG 序列 / HLS）、帧率（跟随项目 / 24 / 25 / 30 / 60 / 自定义）、质量（Draft / Looks / Standard / High / Delivery）、分辨率预设、文件名、输出位置 |
| 高级参数 | Docker 渲染、GPU 编码、Browser GPU、Workers、Composition、CRF、Video Bitrate、严格模式、GIF 循环、HLS 分片 |
| 预设 | 4 个内置预设 + 保存 / 更新 / 删除自定义预设，只写入应用数据目录 |
| 渲染 | 实时日志、结构化进度、耗时统计、输出大小/时长、停止任务（含子进程树） |
| 环境 | Node.js、npm/npx、HyperFrames CLI、Chrome、FFmpeg、当前项目状态；附带 `hyperframes lint` 检查 |
| 日志 | 独立终端式面板、级别过滤、调试输出开关、清空、复制、打开输出目录 |
| 性能 | 独立「性能」页：硬件与编码器实测、项目负载分析、四种优化模式、自动极限优化、基准测试、硬件/渲染档案、实时资源监控（详见第 11 节） |
| 预览 | 一键启动 HyperFrames Preview 并打开系统默认浏览器中的 HyperFrames Studio，含服务状态、端口、Studio 地址、复用与停止（详见第 14 节） |
| 测试清理 | 每次性能测试使用 `performance-tests/<测试ID>/` 独立目录，结束后自动删除临时视频 / PNG 序列 / 原始帧 / 专用 Chrome 配置，只保留日志与性能报告（详见第 16 节） |
| 窗口 | 自定义标题栏：去掉 Windows 默认标题栏，保留原生最小化 / 最大化 / 关闭，深浅主题联动（详见第 13 节） |

界面支持浅色 / 深色主题（右上角切换，会记住选择），标题栏与原生窗口按钮会跟随主题同步配色。

---

## 2. 环境要求

- Windows 10/11（主目标），macOS / Linux 亦可运行
- Node.js **18+**（建议 20 / 22 LTS），并附带 npm / npx
- 能访问 npm registry（首次调用会自动下载 HyperFrames CLI）
- FFmpeg（HyperFrames 渲染需要；可用 `npx hyperframes doctor` 自检）
- 首次渲染时 HyperFrames 会自动下载 `chrome-headless-shell`，需要网络

> 应用本身不内置 Node 与 FFmpeg，因为它们需要跟随本机环境。启动后点击右上角「环境检测」可以逐项确认。

---

## 3. 开发与运行

```bash
npm install          # 安装依赖（首次会下载 Electron 二进制）
npm run dev          # 开发模式：Vite HMR + Electron
npm run typecheck    # TypeScript 类型检查
npm run build        # 构建主进程 / preload / 渲染进程到 out/
npm start            # 构建后以生产模式启动
```

目录结构：

```
src/
  main/                     主进程
    index.ts                窗口、菜单、生命周期
    process/
      hyperframes.ts        CLI 定位、参数构造、输出解析、进程树终止
      environment.ts        doctor / Node / npm 环境检测
      render-manager.ts     渲染任务、日志流、进度、停止
    services/
      project-manager.ts    项目识别、composition 扫描、lint
      preset-manager.ts     预设读写（含内置预设）
      settings-manager.ts   应用设置、最近项目/输出目录
      store.ts              原子化 JSON 持久化
    ipc/handlers.ts         所有 IPC 通道实现
  preload/index.ts          contextBridge 暴露安全 API
  renderer/                 React + Vite 界面
    src/components/         ProjectSelector / ExportSettings / AdvancedSettings /
                            RenderProgress / ConsolePanel / PresetSelector / EnvDialog
    src/pages/Home/         主页面状态编排
    src/services/           渲染进程侧 API 封装
  shared/                   主/渲染进程共享类型与 IPC 通道常量
```

---

## 4. Windows 打包

```bash
npm run dist       # 生成 NSIS 安装包 → dist/HF-Render-1.0.0-x64-Setup.exe
npm run dist:dir   # 只产出未压缩的目录版（dist/win-unpacked/HF Render.exe）
```

说明：

- 打包配置写在 `package.json` 的 `build` 字段，图标为 `build/icon.ico`（可用 `python scripts/make-icon.py` 重新生成）。
- 安装包是 per-user 的（`oneClick: false`，可选安装目录），自带桌面与开始菜单快捷方式。
- 打包后的程序仍然调用**本机**的 Node / npx，所以目标机器需要已安装 Node.js 18+。

## 4.1 macOS / Linux 构建配置

配置已写进 `package.json`（`build.mac` / `build.linux`），但**没有在真机上验证过**：

```bash
npm run dist:mac     # dmg（x64 + arm64），需在 macOS 上执行
npm run dist:linux   # AppImage（x64 + arm64），需在 Linux 上执行
```

- macOS 需要在 mac 上构建（代码签名 / 公证也要求 mac 环境）；跨平台构建出来的包不建议当作正式产物。
- 图标目前复用 `build/icon.png`，正式发布建议补 `icon.icns`（macOS）与多尺寸 png（Linux）。
- 这两个平台上的硬件识别、编码器探测、实时监控走各自的适配层，见第 11.13 节的验证状态。

---

## 5. 参数与 CLI 的真实映射

所有参数都来自 `hyperframes render --help`（实测 v0.8.174），不做臆测：

| 界面 | CLI |
| --- | --- |
| 视频格式 | `--format mp4\|webm\|mov\|gif\|png-sequence\|hls` |
| 帧率 | `-f <int>` 或 `-f 30000/1001`；「跟随项目」不传该参数 |
| 质量 | `-q draft\|looks\|standard\|high\|delivery` |
| 分辨率 | `--resolution landscape\|portrait\|square\|*-4k`；「跟随项目」不传 |
| Workers | `-w auto\|<n>` |
| Docker | `--docker` |
| GPU 编码 | `--gpu`（MOV/WebM/MP4/GIF，HLS 不支持） |
| Browser GPU | `--browser-gpu` / `--no-browser-gpu` |
| CRF | `--crf <0-63>`（仅 MP4/WebM，与码率互斥） |
| 视频码率 | `--video-bitrate 10M`（仅 MP4/WebM） |
| GIF 循环 | `--gif-loop <0-65535>` |
| HLS 分片 | `--hls-segment-seconds <1-60>` |
| 严格模式 | `--strict` |
| Composition | `-c compositions/xxx.html` |
| 输出 | `-o <绝对路径>` |

工作目录（`cwd`）固定为用户所选项目目录，因此不需要再传 `[DIR]`。

目录型输出（`png-sequence`、`hls`）在界面里按目录处理：不拼扩展名、输出路径就是目录本身。

---

## 6. 命令执行与安全

- CLI 以**参数数组**方式启动，全程不经过 shell 拼接，项目路径里的中文、空格、`& | ^ %` 都不会被解释，因此不存在命令注入。
- Windows 上不直接执行 `npx.cmd`，而是解析出 npm 的 `npx-cli.js` 后用 `node` 直接启动（Node 22 起禁止无 shell 执行 `.cmd`）；只有在极端兜底场景下才使用 `cmd.exe` 包装。
- 渲染进程开启 `contextIsolation`、关闭 `nodeIntegration`，所有文件系统与子进程能力只在主进程通过 IPC 提供。
- 停止任务时 Windows 使用 `taskkill /pid <pid> /T /F` 杀掉整棵进程树（npx → node → chrome-headless-shell），Unix 使用进程组信号，实测不会残留渲染子进程。
- 应用**只读写自己的数据目录**，不会修改项目里的 HTML / CSS / JS / JSON。

数据位置（Electron `userData`）：

```
%APPDATA%\HF Render\settings.json    # 主题、最近项目、最近输出目录、上次参数、CLI 命令
%APPDATA%\HF Render\presets.json     # 自定义预设
```

---

## 7. 进度与日志

- 优先解析 CLI 真实打印的机器可读标记 `@hf-progress {"code":"capture","done":76,"total":150,"pct":53}`，映射为「编译合成 / 提取视频素材 / 处理音频 / 启动渲染浏览器 / 捕获帧 / 编码视频 / 合成输出」。
- 也兼容百分比进度条行（`████ 53% Streaming frame 76/150`）。
- **解析不到进度时只显示「进行中」和不确定进度动画，绝不虚构百分比。**
- 输出文件路径、体积、时长、CLI 用时来自 CLI 结尾的 `◇ <path>` 与 `12.1 KB · 10.0s video · rendered in 25.1s`。
- ANSI 转义序列会被清理；Windows 上按行做 UTF-8 → GBK 兜底解码；终端刷屏的 `\r` 原地重绘按行拆分，转圈动画归入「调试」级别默认隐藏。

---

## 8. 已知限制与注意

- **默认 CLI 命令是 `npx --yes hyperframes@latest`**。不要写成裸包名 `npx hyperframes`：本机实测 npm 11.12.1 解析 `latest` 时会抛 `Invalid Version:`（arborist 与 sharp 可选依赖的问题）。命令可以在「环境检测 → CLI 调用命令」中改成固定版本或本地安装路径。
- **CLI 命令末尾不要再写子命令**。正确写法是 `npx --yes hyperframes@latest` 或 `npx hyperframes@0.8.176`；如果误写成 `npx hyperframes@0.8.176 preview`，程序会自动把多余的 `preview` 去掉（旧版本会报 `Unexpected extra argument for hyperframes preview: <dir>`）。
- **项目里没有 `package.json` 的 render/dev 脚本、或没有 `hyperframes.json` 都不影响运行**：本工具直接调 CLI，只要目录里有 `index.html`（或在高级参数里指定 composition）就能预览和渲染。这两项现在只是 `i` 提示，不会拦住按钮。实测一个只有 `index.html` 的空目录也能正常起 Preview 服务。
- 分辨率预设要求宽高比与项目一致且为整数倍，否则 CLI 会拒绝——界面会提示这一点。
- MOV 由 CLI 固定使用 ProRes 4444，因此不显示 CRF / 码率；HLS 不支持 GPU 编码。
- 停止任务属于强制终止，已写入的中间产物可能残留在输出目录。
- 渲染时长与机器性能、帧率、质量档位强相关；`npx` 每次启动会有几秒解析开销，属于正常现象。

---

## 9. 典型流程

1. 点击「选择项目」，选中包含 `index.html` 的 HyperFrames 项目目录；
2. 顶部徽标确认 `index.html ✓` 与识别到的分辨率 / 时长；
3. （可选）点「开启预览」：自动启动 Preview 服务并在系统默认浏览器打开 Studio，改完 HTML 回到浏览器即可看到更新；
4. 选择预设或手动调整格式、帧率、质量、分辨率；
5. 设置文件名与输出文件夹（会记住上次位置）；
6. 需要时展开「高级参数」调整 Docker / GPU / Workers / CRF；
7. 点击「开始渲染」（或 `Ctrl + Enter`），右侧查看进度与日志；
8. 完成后点「打开」或「在文件夹中显示」取走视频。

> 预览与渲染彼此独立：开着预览照样可以渲染；渲染也不会关掉正在用的预览。

---

## 10. 实测验证记录

以下流程都在本机用真实 CLI（HyperFrames v0.8.174 + FFmpeg 9.0.2）跑通，不是模拟结果：

| 场景 | 结果 |
| --- | --- |
| MP4 渲染 | 35.0 KB / 10.0s，进度按 `@hf-progress` 真实推进到 100% |
| GIF 渲染 | 190.4 KB，`--gif-loop 0` 生效 |
| PNG 序列 | 输出为目录，80 个 `frame_000001.png`，共 9.9 MB |
| 中文 / 空格 / `&` 路径 | `D:\...\中文 项目 & 测试` 正常渲染出 `中文 项目 & 测试.mp4`，命令按原样带引号展示 |
| 停止渲染 | 状态变为「已停止」，系统里无残留 `hyperframes` / `chrome-headless-shell` 进程 |
| 渲染失败 | `--strict` + 故意抛错的 composition → 明确提示「lint 检查未通过，已按 --strict 中止渲染」 |
| 环境检测 | 9 项全部有结论（Node / npm / CLI / Chrome / FFmpeg / FFprobe / Docker / 内存磁盘 / 当前项目） |
| lint | 正常项目返回「未发现问题」 |
| 预设 | 保存 / 一键填充 / 删除均可用，只写 `%APPDATA%` |
| 打包产物 | `dist/win-unpacked/HF Render.exe` 启动、环境检测、真实 MP4 渲染（13.3 KB / 10.0s）全部通过 |

---

## 11. 性能优化系统（通用硬件自适应 + 自动极限优化）

目标：不靠"某块显卡应该快"的猜测，而是**探测能力 → 生成候选 → 真实实测 → 选最稳最快**。引擎里没有任何一处把开发者机器写死；RTX 3060 只作为一个"参考档案"参与候选生成，换一台机器会得到完全不同的结论。

### 11.1 分层结构

| 层 | 模块 | 文件 | 做什么 |
| --- | --- | --- | --- |
| L1 硬件 | Hardware Service | `src/main/hardware/hardware-service.ts` | 汇总 CPU / 内存 / 多显卡 / 系统 / 磁盘，产出带指纹的 `HardwareReport`，20 秒缓存、并发去重 |
| L1 硬件 | 平台适配层 | `src/main/hardware/platform/{windows,darwin,linux}.ts` | 每个平台独立实现 `probe / readMemory / readProcessMemory / startGpuSampler / encoderFamilies / captureSupport / limitations`，通用业务只调接口 |
| L2 能力 | Capability Service | `src/main/capability/capability-service.ts` | CPU 安全 worker 上限、编码器能力表、浏览器 GPU 探测结果，3 分钟缓存 |
| L2 能力 | 编码器实测 | `src/main/capability/ffmpeg-probe.ts` | 解析 `ffmpeg -encoders` + **真实试编码**，见 11.5 |
| L2 能力 | 浏览器 GPU | `src/main/capability/browser-gpu.ts` | `getGPUFeatureStatus()` + `getGPUInfo('complete')`，识别 SwiftShader 软件渲染 |
| L3 CLI | CLI 适配器 | `src/main/cli/cli-adapter.ts` | 解析 `render --help` / `benchmark --help`，得到版本、开关矩阵与 worker 范围；命令变更自动失效重探 |
| L4 分析 | 项目分析 | `src/main/analyzer/project-analyzer.ts` | 扫素材（图片/视频/体积/尺寸）、读入口文件特征（GSAP / Lottie / Three.js / Canvas / rAF 等） |
| L4 分析 | 负载画像 | `src/main/analyzer/workload.ts` | 打分 0–100 → `light / normal / multi-asset / high / 4k-heavy` |
| L5 优化 | 优化引擎 | `src/main/optimizer/optimizer.ts` | 组合硬件 + 能力 + CLI + 负载 + 历史，输出推荐与逐条理由 |
| L5 优化 | Worker 候选 | `src/main/optimizer/worker-candidates.ts` | 动态生成候选，绝不硬编码 1/2/3/4 |
| L5 优化 | 捕获管线 | `src/main/optimizer/capture-pipeline.ts` | 只在「CLI 支持 + 系统允许 + 格式兼容」时开启 fast-capture / 并行流 |
| L6 测试 | Benchmark 引擎 | `src/main/benchmark/benchmark-engine.ts` | 同一项目同一参数下逐候选实测，官方 benchmark 可选 |
| L7 存档 | 档案库 | `src/main/profiles/profile-store.ts` | 硬件档案 / 渲染档案 / 推荐 / 回退记录 / 最近一次测试，全部本地 JSON |
| L7 存档 | 参考档案 | `src/main/profiles/reference-profiles.ts` | 开发者实测档案，仅作候选与对照，不成为他人默认值 |
| L8 运行时 | 资源监控 | `src/main/monitor/resource-monitor.ts` | 2 秒采样 CPU / 内存 / GPU 3D / 编码 / 解码 / 显存 / 温度 / 功耗 / 进程内存，算峰值与压力等级 |
| L8 运行时 | 回退管理 | `src/main/fallback/fallback-manager.ts` | 统一决策与记录所有回退，见 11.12 |
| 编排 | Performance Service | `src/main/services/performance-service.ts` | 把以上串起来，对 IPC 暴露 snapshot / optimize / benchmark 接口 |

### 11.2 四种模式

| 模式 | Worker | GPU 编码 | 捕获路径 | 什么时候用 |
| --- | --- | --- | --- | --- |
| 智能（默认） | 历史最优；没有历史就 `auto` | 用已通过试编码的硬件编码器 | 默认 | 日常渲染，不做重复测试 |
| 平衡 | 上限 2，给其它程序留余量 | 同上 | 默认 | 边渲染边干活 |
| 性能 | 上限 = 安全上限的 75% | 优先开启 | 支持时用 fast-capture | 追求速度 |
| 极限 | 1 / 2 / 3 / 4 / 上限的一半 / 上限 | 实测对比后再定 | 满足条件时试并行流 | 要"这台机器真正最快" |

所有模式都通过 `buildRenderArgs()` 动态生成参数，**没有一种模式会关闭 `--strict` 之外的安全保护**，也不会改动输出格式或质量。

### 11.3 硬件识别口径

- 多显卡分别记录（本机同时存在 `MuMu Virtual Display Adapter` 与 `RTX 3060 Laptop`，虚拟卡会明确标注"不参与渲染加速"）。
- 每块卡单独记录：名称 / 厂商 / 类型 / 显存 / 显存占用 / 3D / 视频编码 / 视频解码 / 温度 / 功耗 / 驱动版本。
- **不假定 Chrome 与 FFmpeg 用同一块卡**：浏览器用的卡来自 `app.getGPUInfo()` 的 `active` 标记，编码器来自 ffmpeg 自己的试编码。
- 读不到的字段一律 `null` → 界面显示 `N/A`，不做任何估算。

### 11.4 CPU 安全上限（不是固定值）

```
上限 = min(物理核 × 1.5, 可用内存 / 768MB, 逻辑线程, 32)
总内存 ≤ 8GB → 上限固定 1（与 CLI 的 --low-memory-mode 行为一致）
```

本机（8 核 16 线程 / 15.8GB）算出来是 12，再被 CLI 的 worker 范围与项目复杂度裁剪，所以候选只到 1–4。

### 11.5 编码器必须"真跑一次"

只看显卡型号会误判。本机实测：

| 编码器 | 编译进 ffmpeg | 试编码结果 | 说明 |
| --- | --- | --- | --- |
| `h264_nvenc` | 是 | ✅ 通过（约 689ms） | RTX 3060 可用 |
| `hevc_nvenc` | 是 | ✅ 通过 | 可用 |
| `av1_nvenc` | 是 | ❌ 失败 | Ampere 没有 AV1 编码单元，"有 NVENC" ≠ "AV1 可用" |
| `h264_amf` | 是 | ❌ `DLL amfrt64.dll failed to open` | 本机没有可用的 AMD 编码路径 |
| `h264_qsv` | 是 | ❌ `Error creating a MFX session: -9` | 无 Intel 核显 |
| `libx264` | 是 | ✅ 通过 | CPU 编码兜底 |

界面上的"编码器能力"就是这张表的实时结果，失败的会带原因。

### 11.6 CLI 版本感知

- 解析 `render --help` 与 `benchmark --help`，得到 `--experimental-fast-capture`、`--page-side-compositing`、`--low-memory-mode`、`--browser-timeout` 等开关是否存在。
- 参数不可用时**不拼**进命令行，而是在界面上标注"不可用"，理由写清楚。
- CLI 命令变更（设置里改了 `cliCommand`）→ 缓存自动失效重探，不会把某个版本的参数当永久规则。
- 当前实测版本 v0.8.174。

### 11.7 基准测试方法

- 优先跑官方：`npx hyperframes benchmark <dir> --runs N --json`，从混有日志的输出尾部提取 JSON 并解析。
- 同时提供自有矩阵：同一项目、同一格式 / 质量 / 分辨率 / FPS，**只改 worker、GPU 编码、捕获路径**。
- 每组默认跑 N 次取**中位数**，并记录峰值 CPU / 内存 / 显存 / GPU。
- 测试写在应用数据目录下的独立临时目录，跑完即删，**不会覆盖项目里的视频**。
- 有硬件编码器时会追加一组 CPU 编码对照，用来验证 GPU 编码是否真有收益。
- 测试结束清理残留的 `chrome-headless-shell`（实测会遇到孤儿浏览器进程导致后续渲染"退出码 0 但没有产物"）。

> ⚠️ 速度接近时优先更少 worker（8% 以内视为持平）；利用率高不等于更好。

### 11.8 两种 GPU 通道分开

| 通道 | 作用 | 失败时的表现 |
| --- | --- | --- |
| Browser GPU | Chrome 合成 / WebGL 帧捕获 | 回退到软件渲染（SwiftShader），速度明显变慢 |
| FFmpeg GPU Encoding | 编码阶段 | 回退到下一个可用硬件编码器，再回退 libx264 |

CLI 只提供 `--gpu` 开关、不能指定具体编码器，所以界面显示的是"当前格式下最可能被采用的硬件编码器"，并明确标注这一点。输出格式不同（MP4 / WebM / MOV / GIF / PNG 序列）时可用编码器与建议不同，不会为了提速偷偷换格式。

### 11.9 档案

| 档案 | 记录什么 | 何时更新 |
| --- | --- | --- |
| 硬件档案 | CPU / 内存 / GPU / 驱动版本 / CLI 版本 / 可用编码器 + 硬件指纹 | 每次检测 |
| 渲染档案 | 项目 + 格式 + 分辨率 + FPS + 质量 + worker + GPU 编码 + 捕获路径 + 实测耗时 + 资源峰值 | 每次渲染成功 / 每次测试完成 |
| 参考档案 | `Ryzen7_5800H_RTX3060_16GB` 的实测结果 | 手动，且只在硬件完全匹配时作为候选 |

- 硬件指纹 = `hash(平台+架构+CPU+核心数+内存+显卡ID+驱动版本)`，**不含序列号等可识别信息**。
- 项目配置不覆盖全局硬件信息；换了项目就换一套渲染档案。
- 驱动或 CLI 版本明显变化时，界面上会提示重新测试。

### 11.10 实时监控与资源保护

- 采样周期 2 秒：CPU 占用用 `os.cpus()` 时间差计算；GPU 走 `nvidia-smi --loop-ms` 或 Windows 性能计数器；显存、温度、功耗同源。
- **3D 与 Video Encode 分开显示**，不合并成一个"GPU 使用率"。
- 压力等级：内存 85% / 94%、显存 85% / 95%、临时磁盘 8GB / 2GB 三档。
- 进程内存查询（PowerShell）每次约 1 秒，因此只在"完整采样"档、每 5 个采样点做一次；**跑基准测试时切到轻量档**，避免测量行为本身拖慢被测渲染。
- 不超频、不关温度保护、不无条件占满；极限模式同样留余量。

### 11.11 回退矩阵

| 触发 | 处理 | 是否记日志 |
| --- | --- | --- |
| Browser GPU 不可用 / 软件渲染 | 保留 `auto`，交给 CLI 探测，必要时 `--no-browser-gpu` | 是 |
| 硬件编码器试编码失败 | 换下一个可用硬件编码器，全都失败则 `gpu=false` | 是 |
| worker 崩溃 / 复测明显变慢 | 降并发重试 | 是 |
| 并行流不稳定 | 回到默认捕获路径 | 是 |
| 内存 / 显存压力过高 | 降 worker + 开 `--low-memory-mode` | 是 |
| 临时磁盘不足 | 停止不安全的中转并提示 | 是 |

所有回退只动渲染参数，**不会静默降低画质，也不会改用户填的原始参数**。

### 11.12 数据与隐私

- 所有档案、推荐、日志只写在 `%APPDATA%/HF Render/`（macOS 为 `~/Library/Application Support/HF Render`）。
- 不上传项目源码、视频内容、完整本地路径、硬件序列号。
- 没有"必须联网才能渲染"的设计；联网只为 `npx` 拉取 CLI 与浏览器内核。
- 没有任何匿名统计；若要加，必须由用户主动授权。

### 11.13 跨平台状态

| 平台 | 硬件识别 | 编码器实测 | 实时监控 | 状态 |
| --- | --- | --- | --- | --- |
| Windows 10/11 | WMI + 注册表 + nvidia-smi | ffmpeg 试编码 | CPU/内存/GPU 全量 | **已实机验证** |
| macOS | sysctl + system_profiler | VideoToolbox 试编码 | 无 root 时 GPU 采样返回 null | 仅代码检查，未实机 |
| Linux | /proc + lspci + nvidia-smi | VAAPI / NVENC 试编码 | 有 nvidia-smi 时可用 | 仅代码检查，未实机 |

---

## 12. 实际测试报告

> 本节的每一条都注明来源。**"已实机测试"= 在这台机器上真跑过；"仅代码检查"= 只通过类型检查与代码审查，没有对应设备；"未验证"= 没做过。** 没有把模拟结果写成真实硬件结论。

### 12.1 被测环境

| 项 | 值 |
| --- | --- |
| 系统 | Windows 11 专业版 10.0.26200 · x64 · 区域 zh-CN |
| CPU | AMD Ryzen 7 5800H with Radeon Graphics · 8 核 / 16 线程 |
| 内存 | 15.8 GB（测试时可用 1.2 – 1.8 GB，属于"内存偏紧"状态） |
| 独显 | NVIDIA GeForce RTX 3060 Laptop GPU · 6.0 GB · 驱动 617.42 |
| 其他显卡 | MuMu Virtual Display Adapter（虚拟，已正确标注"不参与渲染加速"） |
| Node / npm | v22.22.2 / 11.12.1 |
| HyperFrames CLI | 0.8.174（测试中期 npx 自动升级到 0.8.175，版本感知已重新识别） |
| 测试项目 | 1920×1080 · 10s · 30fps · 300 帧 · GSAP 单页 · 路径含中文、空格与 `&` |

> 说明：本机的 Electron 窗口在无显示会话下 GPU 进程会崩溃（`exit_code=-1073741819`），因此界面验证用 `--disable-gpu --disable-gpu-compositing --in-process-gpu` 启动。这只影响**界面自身的合成**，浏览器 GPU 一栏会显示 SwiftShader —— 这是测试环境限制，不是应用缺陷，也不影响 ffmpeg / HyperFrames 的编码与硬件检测（它们走独立进程）。

### 12.2 硬件与能力识别（已实机测试）

| 指标 | 实际读到的值 | 来源 |
| --- | --- | --- |
| CPU 型号 / 核心 | Ryzen 7 5800H · 8 核 16 线程 | WMI `Win32_Processor` |
| 热区温度 | 20.1 °C | ACPI `MSAcpi_ThermalZoneTemperature`（界面标注为"热区温度"，并提示部分机型不等于核心温度） |
| CPU 指令集 | N/A | Windows 不通过 CIM 暴露，未伪造 |
| 内存 | 14.0 – 14.7 GB 已用 / 15.8 GB | `os.totalmem/freemem` + WMI |
| 显存 | 6.0 GB | 注册表 `HardwareInformation.qwMemorySize` |
| 显存占用 | 2.0 – 3.1 GB | nvidia-smi |
| GPU 3D / 编码 / 解码 | 7 – 59 % / 0 % / 0 % | nvidia-smi（`utilization.encoder` 在本机驱动上恒为 0，已在限制里写明；独立用 nvidia-smi 交叉验证同样是 0） |
| 温度 / 功耗 | 53 – 55 °C / 23 – 28 W | nvidia-smi |
| 编码器（真实试编码） | ✅ `h264_nvenc`(689/484ms) ✅ `hevc_nvenc` ✅ `libx264` ✅ `gif` ❌ `av1_nvenc` | ffmpeg 试编码 |
| 浏览器 GPU | 软件渲染 SwiftShader（本环境） | `app.getGPUFeatureStatus()` |

### 12.3 基准测试实测（同一台机器，四轮）

测试条件：同一个项目、`mp4 / high / 1080p / 30fps`，只改 worker 与编码方式。

| 配置 | 第 1 轮（无监控） | 第 3 轮（轻量采样） | 第 5 轮（轻量采样，CLI 0.8.175） |
| --- | --- | --- | --- |
| auto · GPU | 24.3 s / 23.9 KB | 35.1 s / 32 KB | 30.6 s / 32 KB（CPU 峰值 96.9%，显存 2.6 GB） |
| 1 worker · GPU | **18.8 s** | 25.4 s | 24.5 s（CPU 58.9%，显存 2.9 GB） |
| 2 worker · GPU | 21.5 s | 23.2 s | **22.7 s**（CPU 83.9%，显存 2.8 GB） |
| 3 worker · GPU | 19.4 s | 24.8 s | 23.9 s（CPU 83.7%，显存 2.7 GB） |
| 3 worker · CPU 对照 | 22.9 s / 13.3 KB | 28.2 s / 30 KB | 26.9 s / 30 KB（CPU 峰值 100%） |

能下的结论与不能下的结论：

- ✅ **GPU 编码比 CPU 编码快**（26.9 s → 22.7 s，约 15%）；四轮都是同一方向。
- ✅ **`auto` 不是最快**：CLI 自己挑的 worker 数三轮都最慢，说明"交给 CLI 自动"并不能替代实测。
- ⚠️ **1 次测量不足以定论**：第 1 轮 1 worker 最快（18.8 s），第 5 轮 2 worker 最快（22.7 s），同一配置的轮间波动可达 10% 以上。所以引擎在"速度差 < 8%（极限模式 < 3%）"时优先更少 worker，并在计划里提示用 2–3 次取中位数。
- ⚠️ **相同 CRF 下两种编码器产物体积不同**（32 KB vs 30 KB，第 1 轮是 23.9 KB vs 13.3 KB），说明画质并不等价。CPU 对照组只用于判断"速度收益"，不能当作画质对比。
- ❌ **没有 4K 结论**：本轮只测了 1080p 项目，4K 的显存与耗时表现未实测。

### 12.4 测试过程中真实修掉的问题

这些都是跑出来的，不是想出来的：

1. **系统名称乱码**：PowerShell 5.1 按 GBK 输出，主进程按 UTF-8 解码，得到 `Microsoft Windows 11 רҵ��`。修法：在脚本前强制 `[Console]::OutputEncoding = UTF8`。
2. **实时监控拖慢被测渲染**：进程内存查询每次约 1 秒 CPU 开销，基准测试期间会与被测进程抢 CPU。修法：监控分「完整 / 轻量」两档，测试期间用轻量档，进程查询从每 3 个采样点放宽到每 5 个。
3. **基准测试期间完全没有采样**：监控只在渲染任务状态变化时启动，测试走的是另一条链路。修法：给监控加"驱动方"概念（render / benchmark），测试开始即启动、结束即停止。
4. **"退出码 0 但没有产物"被记成成功**：残留的 `chrome-headless-shell` 导致渲染空跑 3.7 秒、0 字节却被标为 ok。修法：产物为 0 视为失败并给出原因；会话结束清理残留无头浏览器。
5. **npx 缓存损坏时提示看不懂**：安装过程被中断后所有渲染都报 `Cannot find module ..._npx...`。修法：识别该模式并给出"执行 `npm cache clean --force` 后重试"的提示。
6. **极限模式选出了慢的配置**：8% 容差在极限模式下太宽松（22.7 s 的配置会被 24.5 s 的少 worker 方案顶掉）。修法：极限模式收紧到 3%。
7. **推荐结果与当前项目脱节**：切换项目后旧推荐仍然显示。修法：推荐带 `projectPath`，项目不匹配时在面板上直接提示重新优化。
8. **页面级异常会白屏**：补了 `ErrorBoundary`，出错时显示可读信息而不是空白窗口。

### 12.5 测试矩阵与状态

| # | 场景 | 方法 | 结果 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 主流游戏本（独显 + 核显） | 本机实跑 | CPU / 独显 / 编码器 / 基准测试全部走通 | ✅ 已实机 |
| 2 | 虚拟显示适配器干扰 | 本机 MuMu 虚拟卡 | 被识别为"虚拟 · 不参与渲染加速"，未参与编码器与推荐 | ✅ 已实机 |
| 3 | 无独显办公机 | — | 无设备 | ❌ 未验证 |
| 4 | 4K 大型项目 | — | 无 4K 工程，只测了 1080p | ❌ 未验证 |
| 5 | 轻量项目（1080p 静态 + GSAP） | 本机实跑 | 负载评分 16 → "轻量动画" | ✅ 已实机 |
| 6 | 硬件编码器不可用 | 本机 av1_nvenc / amf / qsv | 三个都真实失败并带原因，自动选 h264_nvenc | ✅ 已实机（失败路径） |
| 7 | 浏览器 GPU 不可用 | 本环境即 SwiftShader | 保留 `auto`，不强行开启，界面给出警告 | ✅ 已实机 |
| 8 | 内存吃紧 | 可用内存 1.2–1.8 GB | 自动推荐 `--low-memory-mode`，worker 被压到 1 | ✅ 已实机 |
| 9 | 磁盘不足 | — | 有压力等级判定代码，未构造真实场景 | ⚠️ 仅代码检查 |
| 10 | CLI 版本变化 | 0.8.174 → 0.8.175 | 版本与开关矩阵重新探测，参数未写死 | ✅ 已实机 |
| 11 | macOS（VideoToolbox） | — | 无设备 | ❌ 未验证（仅代码检查） |
| 12 | Linux（VAAPI / NVENC） | — | 无设备 | ❌ 未验证（仅代码检查） |

### 12.6 已知限制

- **`utilization.encoder` 在本机 NVIDIA 驱动上恒为 0**，所以"视频编码占用"这一栏参考价值有限，判断编码是否生效看"编码器能力"与产物大小。
- **CPU 指令集与真实的 CPU 核心温度在 Windows 上取不到**（需要 CPUID 或内核驱动），界面显示 N/A。
- **CLI 只能给 `--gpu` 开关**，不能指定具体编码器；界面显示的是"当前格式下最可能被采用的硬件编码器"。
- **单次测量的波动较大**（同配置轮间差 10% 以上），想要稳定结论建议 2–3 次。
- **macOS / Linux 适配层没有实机验证**，只做了代码层面的隔离（业务层不直接调平台 API），不能对外声称"支持"。
- 网络差时 `npx --yes hyperframes@latest` 首次拉包可能较慢；如果拉包被中断，会出现上面的第 5 条问题。

---

## 13. 自定义窗口标题栏

### 13.1 实现方式

窗口使用 Electron 的**保留原生按钮**方案，而不是 `frame: false` 全接管：

```ts
new BrowserWindow({
  titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
  titleBarOverlay: { color: '#ffffff', symbolColor: '#4a5462', height: 44 },
  ... // frame 保持默认 true
})
```

- **最小化 / 最大化 / 关闭**仍由 Windows 原生绘制与处理，应用不重复画一套按钮。
- 标题栏高度 44px，与 `titleBarOverlay.height` 完全一致，避免出现双层或错位。
- `titleBarOverlay.color` 必须等于标题栏背景色（`--bg-elevated`），否则右侧会出现一块突兀的色块。

### 13.2 布局

| 区域 | 内容 |
| --- | --- |
| 左 | 应用图标（HF）、软件名、版本号、当前项目名 + 状态点、预览端口（运行中） |
| 中 | 导航（渲染 / 性能）+ 大块拖动留白，不放输入类控件 |
| 右 | 环境状态、环境检测、主题切换 → 再右侧是原生窗口按钮占位 |

原生按钮占位宽度直接读系统提供的环境变量：

```css
.titlebar-reserve {
  width: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)));
}
```

- 支持 `env()` 时自动扣掉按钮区域（实测 137px @125% 缩放前的 1x 屏）。
- 不支持时按 138px 兜底，保证自定义内容永远不压到系统按钮下面。
- 实测：窗口宽度 1040 / 1320 / 2400 时，主题按钮右边缘到窗口右边距恒为 157px（137 占位 + 20 内边距）。

### 13.3 拖动与交互

```css
.titlebar, .titlebar-drag { -webkit-app-region: drag; }
.titlebar button, .titlebar a,
.titlebar input, .titlebar select { -webkit-app-region: no-drag; }
```

- 拖动区覆盖整个标题栏，交互元素单独设为 `no-drag`，点击导航 / 环境 / 主题按钮不会被当成拖窗口。
- 双击标题栏最大化的行为由系统在拖动区域上原生处理（`frame` 未被禁用）。
- 缩放、贴靠（Win + 方向键）、Alt + F4、多显示器与高 DPI 都由系统负责，不受自定义标题栏影响。

### 13.4 主题联动

渲染进程解析出实际主题（light / dark）后调用 `window.setTheme()`，主进程随即执行：

```ts
win.setTitleBarOverlay({ color, symbolColor, height })
win.setBackgroundColor(...)
```

| 主题 | 标题栏 / overlay 背景 | 原生按钮图标 |
| --- | --- | --- |
| 浅色 | `#ffffff` | `#4a5462` |
| 深色 | `#1a1d22` | `#c3cad4` |

这样深色主题下不会出现"深色栏配深色图标看不见"，也不会出现浅色栏压在深色界面上。

### 13.5 窗口显示兜底

`ready-to-show` 在软件渲染 / 远程桌面环境下可能不触发，导致窗口一直隐藏。现在额外监听 `did-finish-load`（60ms 后）与 `did-fail-load`（300ms 后）主动 `show()`，只显示一次。

### 13.6 启动页居中

设置读取完成前会先渲染一个加载页。它铺满整个窗口（`position: fixed; inset: 0`），用 flex 居中 `.boot-center`，并加上 `padding-top: var(--titlebar-height)`——因为标题栏由系统绘制、不参与 DOM 布局，不减掉这 44px 的话视觉上会偏上。

```css
.boot-screen {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-top: var(--titlebar-height);
  background: var(--bg);
}
```

加载页同时带一条 `.titlebar-drag-strip`，保证读取期间窗口仍可拖动。

另外 `boot()` 整条链路（设置 / 预设 / 渲染状态 / 最近项目扫描）失败时会降级为默认值直接进入主界面，不会把界面永久卡在「正在读取本地设置…」。

### 13.7 实测结果（打包版 1.0.0 / 1320×860）

| 测试项 | 结果 |
| --- | --- |
| 标题栏尺寸 | 高 44px、`top=0`、宽度等于窗口宽 |
| 拖动 | 标题栏与中间拖动区 `-webkit-app-region: drag`，按钮 `no-drag` |
| 拖动区宽度 | 522px（x=401），左侧品牌区与右侧动作区都点得到 |
| 原生按钮预留 | 预留区 x=1175 / 宽 137px；窗口 1040 / 1320 / 2400 时右侧余量恒为 8px |
| 品牌信息 | `HF Render` + `v1.0.0` + 当前项目名与状态点 |
| 导航页签 | 渲染 / 性能，切换后标题栏保留、active 正确 |
| 主题切换 | 点击切换 light → dark，原生按钮 overlay 由主进程 `setTitleBarOverlay` 同步 |
| 加载页 | logo 中心 (660, 452) = 视口 X 中心 + 内容区 Y 中心，偏 0 / 0 |
| 页面来回切换 | 不再闪「正在读取本地设置…」（用 `bootSnapshot` 缓存直出首屏，按钮立即可用） |
| 关闭窗口 | `window.close()` → 应用退出 9.9s，期间完成预览服务清理 |

---

## 14. HyperFrames Preview（一键预览）

### 14.1 与渲染的区别

| | Preview | Render |
| --- | --- | --- |
| 做什么 | 启动 Studio 本地服务，浏览器里实时预览 | 逐帧捕获 + FFmpeg 编码 |
| 产物 | 无（热更新） | 视频 / 图片序列 |
| 生命周期 | 常驻后台，直到用户停止或退出应用 | 一次性任务 |
| 入口 | 「开启预览」（次级按钮） | 「开始渲染」（主按钮） |

两者互不干扰：渲染时不会关闭预览，预览时也不会自动触发渲染（已实测同时运行）。

### 14.2 结构

```
src/main/preview/cli-adapter.ts     HyperFrames CLI 的 preview 适配（能力探测 / JSON 解析 / 前台兜底）
src/main/preview/preview-manager.ts  服务生命周期、归属判定、健康检查、浏览器打开
src/main/window/window-manager.ts    窗口与 titleBarOverlay
src/preload/index.ts                 preview.* / window.* 安全 IPC
src/renderer/src/components/preview/ PreviewButton、PreviewStatus
src/renderer/src/services/use-preview.ts 前端状态控制器
```

IPC 只有 5 个方法 + 1 个推送：

| 通道 | 说明 |
| --- | --- |
| `preview:start` | 启动（CLI 已运行则复用）并打开浏览器 |
| `preview:status` | 读取运行时状态（含能力、版本、当前项目会话） |
| `preview:open` | 用已保存的 Studio 地址重新打开浏览器，不重复启动 |
| `preview:stop` | 通过 CLI 停止该项目的预览服务 |
| `preview:list` | 列出所有活跃服务（含外部启动的） |
| `preview:event` | 主进程推送状态变化 |

渲染进程只能传**项目路径**，不能传 URL —— 主进程只打开 CLI 返回值中的地址。

### 14.3 启动流程

1. 校验项目：目录存在、是文件夹、含 `index.html`；不满足直接报错，不启动服务。
2. 探测能力：`npx hyperframes preview --help`，解析 `--background` / `--no-open` / `--json` / `--status` / `--stop` / `--list`，同时读出 CLI 版本。
3. 已有健康会话 → 直接打开浏览器（0.9s，不产生任何 CLI 调用）。
4. 否则执行：`hyperframes preview <项目绝对路径> --background --no-open --json`（参数数组启动，不经 shell）。
5. 解析 JSON：`studioUrl` / `serverUrl` / `port` / `pid` / `logPath`。
6. HTTP 探活（最长 8s）确认服务真的可用。
7. `shell.openExternal(studioUrl)` 用系统默认浏览器打开。
8. 旧版 CLI 没有 `--background` 时，退回前台子进程模式：由应用持有进程，从输出里的 `Studio <url>` 行解析地址，停止时结束该进程树。

### 14.4 端口与 URL 安全

- **不硬编码 3002**：不传 `--port`，由 CLI 自己从 3002 向上找空闲端口；实测 3002 被占用时自动选了 3003。
- **不拼 URL**：Studio 地址只来自 CLI 的 `studioUrl`，不自己拼 `localhost:3002`，也不打开项目的 `index.html`。
- **打开前校验**：协议必须是 http/https，主机必须是 `localhost` / `127.0.0.1` / `::1` / `*.localhost`，否则拒绝打开。
- **健康检查不走系统代理**：用 `node:http` 直连回环地址，避免 Clash 等代理返回 502 被误判成服务挂了（实测系统 `curl` 走代理返回 502，直连返回 200）。

### 14.5 生命周期

| 场景 | 行为 |
| --- | --- |
| 应用自己启动的服务 | 记录 `source=app / owned=true`；应用退出时通过 CLI `--stop` 停止 |
| 终端或别的工具已在跑 | 复用并标记 `source=external / owned=false`；退出应用**不会**关闭它 |
| 用户关闭浏览器 | 服务继续运行（服务是独立后台进程），可再次「打开预览」 |
| 用户点「停止预览服务」 | 调用 `hyperframes preview <dir> --stop --json`，并确认端口真的关闭 |
| 切换到另一个项目启动预览 | 先停止本应用启动的上一个项目服务，再启动目标项目，不留无主后台进程 |
| 重复点击「开启预览」 | 复用同一个服务（同一 PID / 端口），不会重复创建 |
| 服务被外部关闭 | 健康检查发现无响应，面板改为「无响应」并给出重试入口 |

应用**不会**对 Node / Chrome 进程做 `taskkill` 批量清理，只通过 CLI 的服务生命周期接口操作单个项目。

### 14.6 实测结果（Windows 11 / 打包版 1.0.0）

| 测试项 | 结果 |
| --- | --- |
| 能力探测 | `background / no-open / json / status / stop / list` 全部支持（0.8.175 / 0.8.176 均通过） |
| 中文 + 空格 + `&` 路径 | 正常启动，Studio URL 正确编码为 `#project/%E4%B8%AD%E6%96%87%20...` |
| 点「开启预览」按钮 | 进入运行中 16.4s（CLI 版本变动时 npx 需重新解析）；已就绪时再次启动 7.4s |
| 重复点击 / 再次启动 | `reused=true`，端口与 PID 不变，无新进程 |
| 3 次并发启动同一项目 | 全部 `reused=true`，端口 PID 完全一致，只会有一个服务 |
| 端口冲突（3002 被占） | 自动使用 3003，Studio URL 跟随真实端口 |
| Studio 页面 | 无头浏览器打开后 `document.title = "HyperFrames Studio"` |
| 修改 index.html | Studio 的预览 iframe 带新的 `_t` 时间戳重新加载（热更新生效） |
| 标题栏端口徽标 | 运行中显示「预览 :3002」，停止后立即消失 |
| 停止服务 | 点「停止预览服务」→ 端口关闭耗时 8.6s（期间按钮为「停止中」），状态随后回落 |
| 无效项目 | `项目缺少 index.html，无法启动预览` / `项目目录不存在：...`，且不影响正在运行的服务 |
| 渲染与预览并存 | 预览占用 3002 时渲染成功（进度 100% / 渲染完成），预览全程保持 HTTP 200 |
| 服务进程归属 | 服务进程链为 `node.exe` 独立进程，不挂在浏览器下，关浏览器不影响服务 |
| 退出应用 | 关窗 → 应用退出 9.9s，自己启动的 3002 随后关闭；外部启动的 3003 仍为 200，未被误杀 |

### 14.7 已知限制

- CLI 每次调用都要经过 `npx`，状态刷新约 1~3s（服务已就绪时点击「打开预览」不调用 CLI，可立即打开）。
- 启动 / 停止都要等 CLI 的 `--stop`、`--status` 往返，首次启动 10s 以上、停止约 8s 属正常范围；界面会分别显示「正在启动预览…」「停止中」。
- 外部启动的服务拿不到启动时间，面板显示「未知（非本应用启动）」。
- 服务崩溃后不会自动重启，只提示「无响应」。
- `hyperframes 0.8.175` 的 `preview --list --json` 在服务**确实在跑**时也会返回 `sessions: []`（实测，pid/端口都在）。因此 `PreviewManager.list()` 不把空列表当权威：不在列表里的会话会再用端口探活确认，服务还活着就保留，探不通才清除，避免把正常的预览误判成僵尸会话。
- 应用被强制结束（任务管理器 / 掉电）时不会执行退出清理，可能留下后台服务，可用 `--stop` 按项目路径停止。
- 预览依赖项目含 `index.html`；只有自定义 composition 的项目需要把入口文件补上。
- 切换项目后，面板的「项目 / 端口 / 启动时间」严格对应**当前选中项目**：如果状态查询失败（例如 CLI 命令写错），面板会立刻回到「未启动」，不会继续显示上一个项目的名称（历史问题，已修）。

---

## 15. 渲染失败的自动处理

渲染失败时不再只是把 CLI 的英文报错原样丢给用户，而是分两步：**先按负载预防**，**失败后自动降载重试**。两者都只降低负载或换资源，绝不修改输出格式、分辨率和质量参数。

### 15.1 临时帧磁盘空间（磁盘捕获）

Windows 上 `workers ≠ 1` 时 CLI 用多进程截图，**每一帧都会先写成 JPEG/PNG 落盘**；GIF 与 PNG 序列无论平台都要落盘。渲染前会按「分辨率 × 每帧字节数 × 帧数」估算所需空间：

| 情况 | 处理 |
| --- | --- |
| 系统临时盘放得下 | 不动，日志里写明估算值与剩余量 |
| 放不下 | 把子进程的 `TMP / TEMP / TMPDIR` 重定向到放得下的盘（优先「高级参数 → 临时帧存储目录」，其次自动挑盘），日志注明实际使用的位置 |
| 所有候选盘都放不下 | 直接拦在开始之前，给出需要的空间、各盘剩余量，以及降规格建议（mp4 / mov 改成 1 个 worker 即转为流式编码） |

### 15.2 页面就绪超时（并行捕获）

典型报错：

```
[Parallel] Capture failed: Worker 0: Parallel worker cancelled; …
Worker 3: [FrameCapture] window.__hf not ready after 45000ms.
State: __hf=true, seek=true, player=true, renderReady=true, duration=182
```

`duration=182` 说明**页面本身是好的**，只是这个 worker 的浏览器没能在 45s（CLI 默认）内把 composition 初始化完——并行 worker 越多，多个 Chrome 争抢 CPU / 内存就越慢。

- **渲染前**：按分辨率与 worker 数主动放宽 `--player-ready-timeout`（4K 多 worker 最长 240s，用户已显式指定时不干预）。
- **失败后**：命中 `ready-timeout` 回退规则 → **自动降载重试**，最多 2 次。重试前先清理上一轮残留的无头浏览器。

| 尝试 | worker 数 | 就绪超时 |
| --- | --- | --- |
| 首次 | 原值 | 按负载自动放宽 |
| 第 1 次重试 | 减半（auto → 1） | 45s → 90s |
| 第 2 次重试 | 再减半 | 90s → 150s |

重试沿用同一个任务，日志里会打印「第 N/2 次自动重试（规则名）：原因」，界面上是一次任务的连续过程而不是两个失败任务。只有当回退规则再也给不出新动作时才真正判定失败。

### 15.3 回退规则表

| 规则 | 触发 | 动作 |
| --- | --- | --- |
| `ready-timeout` | `__hf not ready after` / `Parallel worker cancelled` | worker 减半 + 放宽就绪超时 |
| `worker-crash` | `protocol error` / `target closed` / `navigation timeout` | worker 减半 |
| `memory` | `out of memory` / `allocation failed` | worker 减半 + `--low-memory-mode` |
| `browser-gpu` | `GPU process` / `swiftshader` 相关 | `--no-browser-gpu` |
| `hardware-encoder` | `nvenc` / `amf` / `qsv` 初始化失败 | 关闭 GPU 编码 |
| `capture-path` | `fast capture` / `parallel stream` 失败 | 回退默认截图捕获 |
| `disk` | `no space left` / `ENOSPC` | 不自动重试（需人工换盘或清理） |

> 只对**可调优的失败**自动重试。lint 失败、composition 缺失这类项目本身的问题不做重试，直接把原因翻译成中文给出。

---

## 16. 性能测试临时文件自动清理

性能测试（四模式对比 / 单模式矩阵 Benchmark）会在磁盘上产生大量一次性产物：临时 MP4/WebM/MOV、PNG 序列、原始 RGBA 帧、截图、编码中间文件、Chrome 用户数据目录。测试本身几分钟就结束，这些文件却会一直占着几个 GB。本节描述 HF Render 如何在**测试结束后自动清掉它们，同时保证用户数据绝对安全**。

### 16.1 目录结构

每次测试生成唯一任务 ID（`cmp_<时间戳>_<随机>` 或 `bench_<随机>`），全部产物都在 Electron userData 下的独立目录里：

```
performance-tests/<test-id>/
  manifest.json          任务清单（登记的每一个产物）
  report.json            本次测试的性能数据（默认长期保留）
  cleanup.json           清理记录（删了什么 / 留了什么 / 为什么失败）
  logs/                  session.log、session.json、每轮 stdout/stderr（长期保留）
  smoke/                 基础渲染预检产物（临时）
  balanced/ performance/ extreme/ smart/   各模式独立输出（临时）
  tmp/                   本任务专属临时目录（子进程 TMP/TEMP/TMPDIR 指向这里）
    chrome-profile/      测试专属 Chrome 用户数据目录
    screenshots/         临时截图
```

子进程启动时会把 `TMP` / `TEMP` / `TMPDIR` 指向 `tmp/`，因此 Chrome 的临时 profile、帧缓存、编码中间文件全部落在任务目录内，既能登记也能安全清理，又不会碰到 `%TEMP%` 里其他软件的文件。

### 16.2 manifest.json 登记了什么

每个产物一条记录，**清理只认这张表**（不做文件名通配符匹配）：

| 字段 | 含义 |
| --- | --- |
| `path` | 规范化后的绝对路径 |
| `entry` | `file` / `dir` |
| `kind` | `video-mp4` / `video-webm` / `video-mov` / `png-sequence` / `rgba-frames` / `screenshot` / `encoded-temp` / `chrome-profile` / `temp-cache` / `log` / `report` / `manifest` / `cleanup` / `other` |
| `createdAt` | 登记时间 |
| `source` | 创建来源：`smoke` / `balanced` / `performance` / `extreme` / `smart` / `warmup` / `workspace` / `report` / `discovered` |
| `owner` | `hf-render`（本应用）或 `hf-render-child`（本应用启动的渲染子进程） |
| `cleanable` | 是否允许自动清理 |
| `bytes` | 清理前实测体积 |

清理前还有一步「补登记」：只在**已登记的独占目录**（各模式目录、`tmp/`）内部遍历，把子进程临时创建、此前没来得及登记的文件补进清单，然后才进入删除流程。目录之外的任何文件永远不会被这个流程看到。

### 16.3 生命周期

`BenchmarkEngine` 把清理放在 `finally` 里，成功 / 失败 / 取消三条路径都会执行：

1. 落日志（`session.log` / 每轮 stdout / stderr 完整保留）；
2. 杀掉残留的无头浏览器，等待 CLI / Chrome / FFmpeg 相关子进程退出（最多 8 秒，超时不阻塞）；
3. 收集性能数据（耗时、输出体积、ffprobe 读到的视频时长/分辨率/帧率、设备信息）写入 `report.json`；
4. 按策略挑出可删除条目，逐条过安全守卫；
5. 删除并累计释放空间，失败条目有限次数重试（3 次，间隔 180/520/1200ms）；
6. 清掉空的临时子目录（`logs/` 与任务根保留）；
7. 写 `cleanup.json`，把释放空间 / 保留内容 / 错误列表回传界面。

| 场景 | 行为 |
| --- | --- |
| 测试成功 | 删除全部临时媒体与中间文件，保留 `logs/`、`report.json`、`cleanup.json`、`manifest.json` |
| 测试失败 | 记录真实错误与失败阶段，保存 stdout/stderr；默认同样删除临时媒体，只留错误日志与报告 |
| 测试失败 + 开启「保留失败测试文件」 | 保留现场（含临时视频），`cleanup.json` 写明原因 |
| 用户主动取消 | 停止子进程 → 等待退出 → 清理临时文件 → 保留取消日志与已获得的数据 |
| 文件被占用 / 权限不足 | 记录到 `cleanup.json`，不影响已成功的测试结果；下次启动或点「立即清理」会重试 |

### 16.4 安全边界

删除前逐条检查（`src/main/cleanup/path-guard.ts`）：

- 必须是绝对路径，且**严格位于当前任务根目录内部**；
- 拒绝任务根目录本身及其上级、文件系统根、userData 根、`performance-tests` 根；
- 拒绝含 `..` 段的路径（防路径穿越，规范化后越界一样拒绝）；
- 拒绝项目根目录及其上级、用户正式输出目录（`lastOutputDir` / `recentOutputDirs`）；
- 拒绝含 `node_modules` / `.git` / `.hg` / `.svn` 的路径；
- 拒绝 manifest 里没有登记过的条目（清单被篡改时会命中这条）。

以下内容**永远不会被删除**：用户原始 HyperFrames 项目与素材、用户正式导出的视频、手动保存的渲染结果、其他软件的文件、用户原本运行的 Preview 服务文件、公共 Chrome 用户数据、Node.js / HyperFrames 依赖目录、历史 Benchmark 报告与性能测试日志。

另外：不做 `rm -rf performance-tests`，只按任务目录逐条处理；只处理带 `"app": "hf-render"` 标记的 manifest 目录，没有清单的目录（包括旧版本遗留的 `performance-tests/*` 与 `benchmark/*`）一律不碰。清理期间仍在运行的任务会被跳过。

### 16.5 设置与界面

「性能」页新增「性能测试临时文件」面板：

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| 自动清理性能测试文件 | 开启 | 关闭后测试结束不删除任何文件（`cleanup.json` 记录跳过原因） |
| 保留失败测试文件 | 关闭 | 开启后失败任务保留现场，便于排查 |
| 保留性能测试报告 | 开启 | 保留 `logs/`、`report.json`、`cleanup.json`；性能报告列表本身始终保留 |

面板同时提供：

- **本地测试文件占用**：`performance-tests` 下各任务体积，区分「可清理的临时媒体」与「长期保留的日志 / 报告」；
- **本次测试清理结果**：删除了多少文件、释放多少空间、清理前后体积、保留了什么、哪些因占用失败；
- **立即清理历史临时文件**：批量清理所有带清单的历史任务（运行中的任务与未登记目录自动跳过）。

应用启动时会在后台扫描一次：只处理「状态为 running 但超过 20 分钟没有更新」的异常遗留任务，以及上次清理失败/被策略跳过的任务，其它目录不扫描。

### 16.6 历史数据

原始临时视频不长期保存，但性能数据长期保留在三处：

1. `performance-tests/<test-id>/report.json`：每次运行的模式、耗时、输出体积、视频时长、分辨率、帧率、失败阶段与错误摘要、设备信息；
2. `performance-tests/<test-id>/logs/`：完整诊断日志；
3. 应用档案 `performance-reports.json`：用于「速度对比」「报告历史」等界面展示的汇总报告。

### 16.7 验证方式

```bash
npm run test:cleanup       # 清理逻辑与安全守卫回归（31 组断言，不需要渲染）
npm run test:cleanup:e2e   # 真实执行四种模式 + 单模式 + 取消 + 失败（需要本机 hyperframes CLI）
```

e2e 会在磁盘上核对：媒体文件是否删干净、`tmp/` 与 Chrome 配置是否清空、日志与报告是否保留、空目录是否清掉、样例项目文件是否字节不变、未登记目录是否完全没被碰、多次测试后的剩余占用是否只有日志与报告。

---

## 17. 渲染状态：当前性能模式与导出配置

渲染状态面板在进度条下方、耗时统计旁边增加两个紧凑信息模块（左：当前渲染性能；右：当前导出配置），并提供一个可折叠的历史渲染配置列表。

### 17.1 唯一数据源：RenderTaskConfigSnapshot

两个模块、日志、历史记录都读同一份 `RenderTaskConfigSnapshot`（`src/shared/types/render.ts`）：

| 字段 | 说明 |
| --- | --- |
| `selectedPerformanceMode` | 任务启动时选择的性能模式（智能 / 平衡 / 性能 / 极限） |
| `effectivePerformanceConfig` | Workers、GPU 编码是否真的下发、Browser GPU 模式与观测值、捕获路径、页面侧合成、低内存模式、配置来源（智能自动优化 / 固定预设）、回退记录 |
| `resolution` | 预设 + 生效宽高 + 标签（4K / 1080p / 项目尺寸）、是否被 ffprobe 证实 |
| `fps` | 模式 + 生效帧率 + 是否被 ffprobe 证实 |
| `format` / `quality` | 输出格式与质量档位 |
| `encoder` | 真实编码器 id / 名称 / 是否硬件 / 证据来源（process / ffprobe）/ 确认时间 |
| `workers` / `gpuEncodingEnabled` / `browserGpuEnabled` / `captureMode` | 扁平字段，便于界面直接用 |
| `cliArgs` / `attempt` | 实际下发的参数与自动重试次数（用于核对「界面 = 真实命令」） |

所有生效值都从**真正下发给 CLI 的 args** 反推（`src/main/process/task-config.ts`），因此不存在「界面读默认设置、实际跑另一套参数」的问题。例如 PNG 序列不支持 GPU 编码时，即使请求里 `gpu: true`，快照的 `gpuEncodingEnabled` 也是 `false`。

### 17.2 模式在启动时冻结

`RenderManager.start()` 只读取一次 `performanceMode`（由 IPC 从 `AppSettings.performanceMode` 传入），写进快照后不再变化。渲染过程中用户切换性能模式、甚至再次点击开始，都不会改变当前任务显示的模式（新的启动请求会被「已有渲染任务在运行中」拒绝）。

### 17.3 编码器只认运行时证据

`render --gpu` 只是请求。实际编码器由 `src/main/process/encoder-probe.ts` 认定：

1. 渲染期间用常驻子进程轮询 `ffmpeg` 的真实命令行，取 `-c:v`（自动排除 CLI 的 `-f lavfi … -f null -` 试编码探测）；
2. 渲染结束后用 `ffprobe` 读取产出文件的真实宽高 / 帧率，并尝试从容器 tag 里识别编码器；
3. 两者都拿不到时显示「未确认」，**绝不把请求值（如 NVENC）当成已启动的编码器**。

因此：
- GPU 请求成功 → 显示 `NVENC H.264`（硬件编码）；
- 硬件编码失败回退到 CPU → 运行时证据会变成 `libx264`（CPU 软件编码），日志同时打印「请求了 GPU 编码，本次实际由 CPU 完成」；
- 自动重试导致 `--gpu` 被去掉时，快照会先把编码器重置为「确认中」，等新证据再更新。

### 17.4 界面与历史

- 左栏：`智能模式 · 自动优化配置` / `极限模式 · 固定预设`，第二行 Worker / GPU / 捕获路径，回退时追加「已回退 N 项」；
- 右栏：`4K · 30 FPS`、`MP4 · NVENC H.264 · 3 Workers`、质量与 Browser GPU 状态；
- 任务结束后「历史渲染配置」折叠列表展示最近 6 条（保存在 `render-history.json`，最多 20 条），每条都是该任务自己的快照，不会随后续模式切换而变化。

### 17.5 验证

```bash
npm run test:render-config       # 29 组断言：编码器解析 / 快照与 args 一致 / 证据更新 / 回退 / 历史
npm run test:render-config:e2e   # 真实渲染四种模式 + PNG 序列 + 运行中切换模式 + 历史持久化（25 项检查）
```

真实渲染验收（hyperframes 0.8.181，样例 640×360 / 2s / 30fps）：平衡 13s（x264）、性能 16s（NVENC H.264）、极限 17s（NVENC H.264）、智能 13s（x264），快照模式、Worker、GPU 开关与命令行完全一致，运行中切换模式被拒绝且显示不变，历史记录重开仍保留。

---

## 18. 浏览器导航超时的安全边界（必失败值拦截）

`--browser-timeout` 这个名字容易误解：它并不是"浏览器启动超时"，而是 **page.goto 的导航超时**（秒 × 1000 → 毫秒）。一旦设成 1 秒，页面来不及跑到 `domcontentloaded`，每次渲染都会失败：

```
[Render:trace] {"phase":"capture_streaming","status":"error","message":"Navigation timeout of 1000 ms exceeded"}
[Render] capture failed; re-rendering via a fresh screenshot session
[Render:trace] {"phase":"capture_streaming","status":"error","message":"Requesting main frame too early!"}
```

两条报错是同一个根因的两次表现：第一次导航超时 → CLI 用同一份 1s 预算重试 → Chromium 在主 frame 提交前收到截图请求，抛出 `Requesting main frame too early!`。日志里的 `failedStage: "Checking browser GPU"` 只是最后观测到的阶段标记，实际失败点是 `observedFailedPhase: capture_streaming`。

三层防护（`src/shared/render-limits.ts` 定义唯一规则：留空或 10–600 秒）：

1. **界面**：「渲染 → 高级参数 → 浏览器导航超时（秒）」只接受留空或 10–600；输入 1–9 时立即显示错误且不落盘；
2. **拼参数**（`buildRenderArgs`）：即便旧配置 / 手改 JSON 塞进危险值，也不会写进命令行，并在渲染日志里给出警告「浏览器导航超时 1s 小于 10s……已忽略并使用 CLI 默认值」；
3. **读取设置**（`SettingsManager`）：历史存档里的 1–9 秒脏值在读取时被清成 `null`，不再跟着 `lastSettings` 一轮轮传下去。

> 推荐：留空（CLI 默认 60s）。大项目 + 多 worker 时，应用自己会按负载放宽到 90–240s；只有当你有特殊需求时才手动设置，且不要低于 10 秒。

### 18.1 顺带修正：只清理孤儿无头浏览器

`cleanupStrayBrowsers()` 原来会无条件杀掉所有 `chrome-headless-shell`。当同时存在另一个正在渲染的实例（或终端里 `npx hyperframes render`）时，会连带杀掉对方的浏览器，对方表现为 navigation timeout / target closed。

现在只杀**父进程已经不存在**的浏览器进程：正常渲染中的浏览器其父进程（hyperframes CLI）仍然存活，不会被误杀；CLI 异常退出留下的孤儿才会被回收。

---

## 19. 预览按钮的状态同步与视觉

### 19.1 之前为什么会「服务起来了，按钮还写着开启预览」

预览状态原来分散在三处：`usePreview` 内部的 `state`、按钮里由 `session.status` 推导的局部布尔、以及主进程的 IPC 事件。真正的断点有两个：

1. **会话匹配依赖 `state.current`**：主进程的 `snapshot()` 用 `currentKey` 决定 `current`。只要 `currentKey` 被别的项目/旧事件改过，`usePreview` 里 `state.current` 就匹配不上当前项目，`session` 变 `null`，按钮立刻退回「开启预览」——即使服务其实还在跑。健康探活一次抖动、或渲染进程顺手调了一次 `preview.list()`（它会与 CLI 对账并剔除会话），都能触发。
2. **按钮只有「启动中 / 运行中 / 其它」三档**：`error`、`stopping` 与真正的 `idle` 在按钮上都渲染成「开启预览」，用户无法区分「没启动」和「启动失败」。

### 19.2 现在的结构

- `src/renderer/src/services/preview-store.ts`：应用级单例 `PreviewStore`，唯一状态源；
  - 五态：`idle / starting / running / stopping / error`（`derivePreviewPhase`）；
  - 会话匹配 `matchSession()` 按**项目路径**在 `sessions[]` 里找，不再依赖 `current`；
  - IPC 事件订阅只建立一次；页面重挂载时主动 `status()` 对账，不会默认回到 idle；
  - `refresh()` **只查 status，不查 list**（list 会改主进程状态，不能由 UI 触发）。
- `usePreview` 用 `useSyncExternalStore` 读同一个 store，返回 `phase` / `error`（原 API 不变）；
- `PreviewManager.pollHealth()`：连续 2 次探活失败才把会话判为 `error` 并推送，服务恢复后自动回到 `running`；
- `PreviewButton` 按五态渲染：开启预览 / 正在启动… / 打开预览（绿色指示点）/ 正在停止… / 重新开启预览。

### 19.3 视觉

底部操作栏保留「预览（左）+ 开始渲染（右）」两个并列按钮，高度 36px、圆角 4px、图标 13–14px，与主按钮完全一致：

| 状态 | 背景 | 文字 | 说明 |
| --- | --- | --- | --- |
| idle | `#E5EFE9` | `#294A38`（图标 `#355D47`） | 浅绿填充，次级操作 |
| running | `#D5E9DC` | `#294A38` + 绿色圆点 `#1F9A5B` | 与主按钮的蓝色明确区分 |
| hover | 略深（`#D8E8DE` / `#C8E0D1`） | — | — |
| active | 再深一档 + `translateY(1px)` | — | 轻微按压反馈 |
| disabled | `opacity: .55` + `not-allowed` | — | 启动中 / 未选项目 |
| error | `#F6ECE4` / 深色 `#2F2419` | 棕色系 | 重新开启预览 |

深色主题有对应配色（`[data-theme='dark'] .btn-preview`），不会出现浅底白字。

### 19.4 实测（CDP 驱动真实应用）

| 验收项 | 结果 |
| --- | --- |
| 初次进入 | 开启预览，`rgb(229,239,233)` / `rgb(41,74,56)`，36px、4px |
| 点击瞬间 | 正在启动…，禁用态 |
| 启动完成 | 打开预览，`rgb(213,233,220)` + 绿色圆点 `rgb(31,154,91)` |
| 再次点击 | 服务不重启（端口与 sessions 数不变），只打开已有 Studio |
| 离开渲染页再回来 | 仍显示打开预览，主进程 `status=running` |
| 面板停止 | 回到开启预览，`sessions=0` |
| 杀掉预览进程 | 约 14s 内变为重新开启预览（`btn-preview is-error`） |

### 19.5 跨实例保护

`cleanupStrayBrowsers()` 改为只杀父进程已消失的孤儿 `chrome-headless-shell`。此前它无差别杀掉所有无头浏览器，多开或终端里 `npx hyperframes render` 时会误杀别人的渲染浏览器（表现为 navigation timeout / target closed）。
