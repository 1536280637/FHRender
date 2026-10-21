import { Badge, Dot, Panel, Spinner } from '../ui'
import type { CapabilityReport, MonitorState, WorkloadProfile } from '@shared/types/performance'
import type { GpuInfo, HardwareReport } from '@shared/types/hardware'
import { NA, WORKLOAD_LABEL, formatBytes, formatGb, formatPct, PRESSURE_LABEL } from '../../services/perf-format'

function kindLabel(kind: GpuInfo['kind']): string {
  switch (kind) {
    case 'discrete':
      return '独显'
    case 'integrated':
      return '核显'
    case 'virtual':
      return '虚拟'
    default:
      return '未知'
  }
}

function vendorLabel(vendor: GpuInfo['vendor']): string {
  switch (vendor) {
    case 'nvidia':
      return 'NVIDIA'
    case 'amd':
      return 'AMD'
    case 'intel':
      return 'Intel'
    case 'apple':
      return 'Apple'
    case 'qualcomm':
      return 'Qualcomm'
    case 'microsoft':
      return 'Microsoft'
    default:
      return '未知'
  }
}

function platformLabel(platform: string): string {
  switch (platform) {
    case 'win32':
      return 'Windows'
    case 'darwin':
      return 'macOS'
    case 'linux':
      return 'Linux'
    default:
      return platform
  }
}

function Metric(props: { label: string; value: string; muted?: boolean; hint?: string }): JSX.Element {
  return (
    <div className="metric" title={props.hint}>
      <span className="metric-label">{props.label}</span>
      <span className={props.muted ? 'metric-value muted' : 'metric-value'}>{props.value}</span>
    </div>
  )
}

export function DevicePanel(props: {
  hardware: HardwareReport | null
  capabilities: CapabilityReport | null
  loading: boolean
  cliVersion: string | null
  onRescan: () => void
}): JSX.Element {
  const hw = props.hardware
  const cap = props.capabilities

  return (
    <Panel
      title="设备信息"
      subtitle="实时读自操作系统，读不到的指标显示 N/A"
      actions={
        <button type="button" className="link-btn" onClick={props.onRescan} disabled={props.loading}>
          {props.loading ? '检测中…' : '重新检测'}
        </button>
      }
    >
      {!hw ? (
        <div className="perf-loading">
          <Spinner />
          <span>正在识别硬件与编码器能力（首次约需 10 秒）…</span>
        </div>
      ) : (
        <>
          <div className="device-head">
            <div>
              <strong>{hw.cpu.model}</strong>
              <span className="device-sub">
                {hw.os.name} · {hw.os.arch} · {hw.os.isElevated ? '管理员权限' : '普通权限'}
              </span>
            </div>
            <Badge tone="info">{platformLabel(hw.platform)}</Badge>
          </div>

          <div className="metric-grid">
            <Metric
              label="CPU"
              value={`${hw.cpu.physicalCores ?? NA} 核 / ${hw.cpu.logicalCores ?? NA} 线程`}
            />
            <Metric label="CPU 占用" value={formatPct(hw.cpu.usagePct)} />
            <Metric
              label="热区温度"
              value={hw.cpu.temperatureC != null ? `${hw.cpu.temperatureC}°C` : NA}
              muted={hw.cpu.temperatureC == null}
              hint="取自系统 ACPI 热区，部分机型此值不等于 CPU 核心温度"
            />
            <Metric label="内存" value={`${formatGb(hw.memory.usedBytes)} / ${formatGb(hw.memory.totalBytes)}`} />
            <Metric label="可用内存" value={formatGb(hw.memory.freeBytes)} />
            <Metric label="指令集" value={hw.cpu.features.length > 0 ? hw.cpu.features.slice(0, 6).join(' ') : NA} muted={hw.cpu.features.length === 0} />
          </div>

          <div className="gpu-list">
            {hw.gpus.length === 0 && <div className="empty-line">未检测到显卡信息</div>}
            {hw.gpus.map((gpu) => (
              <div className="gpu-card" key={gpu.id}>
                <div className="gpu-head">
                  <span className="gpu-name">{gpu.name}</span>
                  <span className="gpu-tags">
                    <Badge tone={gpu.kind === 'virtual' ? 'neutral' : 'ok'}>{vendorLabel(gpu.vendor)}</Badge>
                    <Badge tone="neutral">{kindLabel(gpu.kind)}</Badge>
                    {gpu.activeForBrowser && <Badge tone="info">浏览器正在使用</Badge>}
                  </span>
                </div>
                <div className="metric-grid compact">
                  <Metric label="显存" value={formatGb(gpu.vramBytes)} muted={gpu.vramBytes == null} />
                  <Metric label="显存占用" value={formatGb(gpu.metrics.vramUsedBytes)} muted={gpu.metrics.vramUsedBytes == null} />
                  <Metric label="3D" value={formatPct(gpu.metrics.usage3dPct)} muted={gpu.metrics.usage3dPct == null} />
                  <Metric label="视频编码" value={formatPct(gpu.metrics.videoEncodePct)} muted={gpu.metrics.videoEncodePct == null} />
                  <Metric label="视频解码" value={formatPct(gpu.metrics.videoDecodePct)} muted={gpu.metrics.videoDecodePct == null} />
                  <Metric label="温度 / 功耗" value={`${gpu.metrics.temperatureC != null ? `${gpu.metrics.temperatureC}°C` : NA} · ${gpu.metrics.powerW != null ? `${gpu.metrics.powerW}W` : NA}`} muted={gpu.metrics.temperatureC == null && gpu.metrics.powerW == null} />
                  <Metric label="驱动" value={gpu.driverVersion ?? NA} muted={!gpu.driverVersion} />
                </div>
                {gpu.note && <p className="gpu-note">{gpu.note}</p>}
              </div>
            ))}
          </div>

          <div className="cap-block">
            <div className="cap-title">
              编码器能力
              <span className="cap-hint">基于当前 ffmpeg 的编码器列表 + 真实试编码</span>
            </div>
            <div className="encoder-list">
              {(cap?.encoders ?? []).map((enc) => (
                <div className="encoder-item" key={enc.id}>
                  <Dot tone={enc.working ? 'ok' : enc.compiled ? 'warn' : 'unknown'} />
                  <span className="encoder-name">{enc.label}</span>
                  <span className="encoder-state">
                    {enc.working
                      ? '可用'
                      : enc.compiled
                        ? enc.tested
                          ? '试编码失败'
                          : '未验证'
                        : '未编译'}
                  </span>
                  {!enc.working && enc.reason && <span className="encoder-reason" title={enc.reason}>{enc.reason.slice(0, 60)}</span>}
                </div>
              ))}
              {!cap && <div className="empty-line">正在验证编码器…</div>}
            </div>
          </div>

          <div className="cap-block">
            <div className="cap-title">浏览器 GPU</div>
            {cap ? (
              <div className="metric-grid compact">
                <Metric label="硬件合成" value={cap.browserGpu.hardwareCompositing == null ? NA : cap.browserGpu.hardwareCompositing ? '已启用' : '未启用'} />
                <Metric label="WebGL" value={cap.browserGpu.webgl == null ? NA : cap.browserGpu.webgl ? '可用' : '不可用'} />
                <Metric label="WebGL2" value={cap.browserGpu.webgl2 == null ? NA : cap.browserGpu.webgl2 ? '可用' : '不可用'} />
                <Metric label="软件渲染" value={cap.browserGpu.softwareOnly ? '是（SwiftShader）' : '否'} />
                <Metric label="活动 GPU" value={cap.browserGpu.activeGpuName ?? NA} muted={!cap.browserGpu.activeGpuName} />
                <Metric label="CLI 版本" value={props.cliVersion ? `v${props.cliVersion}` : NA} muted={!props.cliVersion} />
              </div>
            ) : (
              <div className="empty-line">正在探测…</div>
            )}
          </div>

          {(hw.warnings.length > 0 || (cap?.warnings.length ?? 0) > 0) && (
            <ul className="warn-list">
              {hw.warnings.map((w, i) => (
                <li key={`hw-${i}`}>{w}</li>
              ))}
              {(cap?.warnings ?? []).map((w, i) => (
                <li key={`cap-${i}`}>{w}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  )
}

const SOURCE_LABEL: Record<string, string> = {
  'cli-info': 'HyperFrames info',
  composition: 'Compositions JSON',
  'entry-html': '根元素 data-*',
  'cli-default': 'CLI 默认值',
  unknown: '未识别'
}

function sourceText(source: string | undefined): string {
  return source ? (SOURCE_LABEL[source] ?? source) : '未识别'
}

function Fact(props: {
  label: string
  value: string
  hint?: string
  muted?: boolean
  strong?: boolean
}): JSX.Element {
  return (
    <div className="workload-fact" title={props.hint}>
      <dt>{props.label}</dt>
      <dd className={`${props.muted ? 'muted' : ''}${props.strong ? ' strong' : ''}`}>{props.value}</dd>
    </div>
  )
}

export function WorkloadPanel(props: {
  workload: WorkloadProfile | null
  projectName: string
  compositionId?: string | null
}): JSX.Element {
  const w = props.workload
  const durationText =
    w?.durationSec != null ? `${w.durationSec} 秒` : '时长待检测'
  const projectFpsText = w?.fps != null ? `${w.fps} fps` : '未声明'
  const exportFpsText = w?.exportFps != null ? `${w.exportFps} fps` : '未确定'
  const frameText = w?.frameCount != null ? `${w.frameCount} 帧` : '待检测'
  const assetScale = w
    ? `${w.imageCount} 图 / ${w.videoCount} 视频 · ${formatBytes(w.assetBytes)}`
    : NA
  const tone =
    w && (w.complexity === '4k-heavy' || w.complexity === 'high')
      ? 'warn'
      : w && w.complexity === 'unknown'
        ? 'neutral'
        : 'ok'

  return (
    <Panel
      title="项目负载"
      subtitle="按元素 / 轨道 / 素材 / GPU 合成综合估算，等级与时长无关"
      actions={
        w ? (
          <span className="workload-head-badge">
            <Badge tone={tone}>
              {WORKLOAD_LABEL[w.complexity]}
              {w.score > 0 ? ` · ${w.score}` : ''}
            </Badge>
          </span>
        ) : undefined
      }
    >
      {!w ? (
        <div className="empty-line">尚未选择项目，无法分析负载</div>
      ) : (
        <>
          <div className="workload-head">
            <div>
              <strong>{w.projectName || props.projectName}</strong>
              <span className="device-sub">
                {w.resolutionLabel}
                {w.compositionId || props.compositionId
                  ? ` · composition ${w.compositionId ?? props.compositionId}`
                  : ''}
              </span>
            </div>
            <span className="device-sub">
              可信度 {w.confidence === 'high' ? '高' : w.confidence === 'medium' ? '中' : '低'}
            </span>
          </div>

          <dl className="workload-facts">
            <Fact
              label="项目时长"
              value={durationText}
              muted={w.durationSec == null}
              strong
              hint={`来源：${sourceText(w.durationSource)}`}
            />
            <Fact
              label="项目 FPS"
              value={projectFpsText}
              muted={w.fps == null}
              hint={
                w.fps == null
                  ? `根元素没有 data-fps；当前 CLI 在未声明时按 ${w.cliDefaultFps ?? '默认值'}fps 输出`
                  : `来源：${sourceText(w.fpsSource)}（不随导出参数改变）`
              }
            />
            <Fact
              label="导出 FPS"
              value={exportFpsText}
              muted={w.exportFps == null}
              hint="本次导出实际使用的帧率；--fps 只影响输出，不改项目原始帧率"
            />
            <Fact
              label="预计总帧数"
              value={frameText}
              muted={w.frameCount == null}
              hint={
                w.frameCount == null
                  ? '时长或帧率有一个不可用时不计算，避免给出假数字'
                  : `${w.durationSec}s × ${w.exportFps}fps（CLI 的取帧规则）`
              }
            />
            <Fact label="项目分辨率" value={w.resolutionLabel} />
            <Fact label="素材规模" value={assetScale} />
            <Fact
              label="元素 / 轨道"
              value={`${w.elements ?? '未知'} / ${w.tracks ?? '未知'}`}
              muted={w.elements == null && w.tracks == null}
              hint="来自官方 info --json"
            />
            <Fact
              label="项目体积"
              value={w.projectBytes != null ? formatBytes(w.projectBytes) : '未知'}
              muted={w.projectBytes == null}
              hint="官方 info 报告的项目总体积"
            />
          </dl>

          {w.unknownFields.length > 0 && (
            <p className="muted-line">
              未识别：{w.unknownFields.join('、')}（显示为未知，不用默认值代替）
            </p>
          )}

          {w.scoreBreakdown.length > 0 && (
            <details className="workload-breakdown">
              <summary className="muted-line">负载得分构成（{w.score} / 100）</summary>
              <ul className="workload-parts">
                {w.scoreBreakdown.map((part) => (
                  <li key={part.key}>
                    <span className="part-label">{part.label}</span>
                    <span className="part-points">{part.points.toFixed(1)}</span>
                    <span className="part-detail">{part.detail}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {w.notes.length > 0 && (
            <ul className="note-list">
              {w.notes.slice(0, 6).map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          )}

          <p className="muted-line">
            分析时间 {new Date(w.analyzedAt).toLocaleString('zh-CN', { hour12: false })}
            {w.fromCache ? ' · 来自项目缓存（文件未变化）' : ' · 本次重新分析'}
          </p>
        </>
      )}
    </Panel>
  )
}

export function MonitorStrip(props: { monitor: MonitorState | null; intervalHint?: string }): JSX.Element {
  const m = props.monitor
  const sample = m?.latest
  return (
    <Panel
      title="实时资源"
      subtitle={
        m?.active
          ? `采样中${props.intervalHint ? ` · ${props.intervalHint}` : ''}`
          : '渲染或性能测试运行时才会采样'
      }
    >
      <div className="metric-grid compact">
        <Metric label="CPU" value={formatPct(sample?.cpuPct ?? null)} muted={!sample} />
        <Metric
          label="内存"
          value={sample?.memoryUsedBytes != null && sample?.memoryTotalBytes != null
            ? `${formatGb(sample.memoryUsedBytes)} / ${formatGb(sample.memoryTotalBytes)}`
            : NA}
          muted={!sample}
        />
        <Metric label="GPU 3D" value={formatPct(sample?.gpu3dPct ?? null)} muted={sample?.gpu3dPct == null} />
        <Metric label="Video Encode" value={formatPct(sample?.videoEncodePct ?? null)} muted={sample?.videoEncodePct == null} />
        <Metric label="Video Decode" value={formatPct(sample?.videoDecodePct ?? null)} muted={sample?.videoDecodePct == null} />
        <Metric label="显存占用" value={formatGb(sample?.vramUsedBytes ?? null)} muted={sample?.vramUsedBytes == null} />
        <Metric label="渲染进程" value={formatBytes(sample?.renderProcessBytes ?? null)} muted={sample?.renderProcessBytes == null} />
        <Metric label="Chrome 进程" value={formatBytes(sample?.chromeProcessBytes ?? null)} muted={sample?.chromeProcessBytes == null} />
      </div>
      <div className="pressure-row">
        <span>内存压力：{PRESSURE_LABEL[m?.pressure.memory ?? 'unknown']}</span>
        <span>显存压力：{PRESSURE_LABEL[m?.pressure.vram ?? 'unknown']}</span>
        <span>临时磁盘：{PRESSURE_LABEL[m?.pressure.disk ?? 'unknown']}</span>
        {sample?.frameDone != null && sample?.frameTotal != null && (
          <span>
            帧进度：{sample.frameDone}/{sample.frameTotal}
          </span>
        )}
      </div>
      {(m?.unavailable.length ?? 0) > 0 && (
        <p className="muted-line">未启用：{m?.unavailable.join('、')}</p>
      )}
    </Panel>
  )
}
