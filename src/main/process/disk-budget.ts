import { existsSync, mkdirSync, statfsSync, type StatsFs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse as parsePath } from 'node:path'
import type { ProjectMeta, RenderRequest, ResolutionPreset, VideoFormat } from '@shared/types/render'

/**
 * 临时帧存储预算（对应 hyperframes >= 0.8.168 的磁盘捕获预检）。
 *
 * 背景：CLI 在两种情况下会把**每一帧**先写成本地图片文件（JPEG，带透明通道时 PNG），
 * 然后再编码：
 *   1) 输出是 png-sequence / gif；
 *   2) 多 worker 的截图捕获（Windows 上 mp4 / mov 只要 workers != 1 就会走这条路，
 *      而 mp4 / mov 在 workers = 1 时走流式编码，几乎不占用临时空间）。
 * 临时目录在 Windows 上固定是 `%TEMP%\hf-render-XXXXXX`，无法从命令行指定，
 * 但 Node 的 os.tmpdir() 会读取 TMP / TEMP 环境变量 —— 因此本模块在必要时
 * 把子进程这三个变量指向空间更充裕的盘，从根上避免 "Disk capture may need …" 失败。
 */

const GB = 1024 ** 3

/** 与界面「输出分辨率」一一对应的像素尺寸；project 需要用到项目自身宽高 */
export const RESOLUTION_DIMENSIONS: Record<ResolutionPreset, { width: number; height: number } | null> = {
  project: null,
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  'landscape-4k': { width: 3840, height: 2160 },
  'portrait-4k': { width: 2160, height: 3840 },
  'square-4k': { width: 2160, height: 2160 }
}

/** 病估：CLI 在高画质档位下 JPEG 约为原始 RGBA 的 1/4，草稿档为 1/8 */
const JPEG_RAW_RGBA_DIVISOR = 4
const JPEG_DRAFT_RAW_RGBA_DIVISOR = 8
/** CLI 自身的判据：所需空间 > 可用空间 × 0.9 即失败，这里再留一点余量 */
const CLI_HEADROOM_RATIO = 0.9
const SAFETY_FACTOR = 1.15
/** 估算不出帧数时，磁盘捕获至少要保留的空间 */
const MIN_SCRATCH_BYTES = 6 * GB
/** 候选盘至少要比"所需"多留的空间，避免刚好卡在边缘被系统回收 */
const CANDIDATE_RESERVE_BYTES = 1 * GB

export interface ScratchCandidate {
  dir: string
  freeBytes: number | null
  totalBytes: number | null
  label: string
}

export interface DiskBudgetInput {
  request: RenderRequest
  platform?: string
  /** 用户在设置里指定的临时帧目录；空表示未指定 */
  scratchDir?: string | null
  /** 是否允许自动切换暂存盘 */
  autoScratch?: boolean
}

export interface DiskBudgetPlan {
  platform: string
  /** 本次渲染是否需要把每一帧先写到磁盘 */
  willUseDiskCapture: boolean
  diskCaptureReason: string
  frames: number | null
  /** 单帧预估字节数 */
  frameBytes: number | null
  neededBytes: number | null
  /** CLI 实际会使用的临时目录（未重定向时 = 系统临时目录） */
  tempDir: string
  /** 需要重定向时给出目标目录，否则为 null */
  overrideTempDir: string | null
  systemTempFreeBytes: number | null
  candidates: ScratchCandidate[]
  warnings: string[]
  /** 无法找到足够空间时的可执行提示；为空表示可以继续渲染 */
  error: string | null
}

export function formatGB(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '未知'
  return `${(bytes / GB).toFixed(1)} GB`
}

/** 读取目录所在盘的可用空间；目录不存在时尝试向上找到存在的祖先目录 */
export function freeBytesAt(dir: string): { free: number | null; total: number | null } {
  let target = dir
  try {
    if (!existsSync(target)) {
      // statfsSync 在 Windows 上要求路径存在，逐级向上找存在的祖先
      let parent = parsePath(target).dir
      while (parent && parent !== parsePath(parent).dir && !existsSync(parent)) {
        parent = parsePath(parent).dir
      }
      if (!existsSync(parent)) return { free: null, total: null }
      target = parent
    }
    const stat: StatsFs = statfsSync(target)
    return {
      free: Number(stat.bavail) * Number(stat.bsize),
      total: Number(stat.blocks) * Number(stat.bsize)
    }
  } catch {
    return { free: null, total: null }
  }
}

function ensureDir(dir: string): boolean {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return existsSync(dir)
  } catch {
    return false
  }
}

/** 帧率：project 模式取项目自身帧率，custom 支持 30 或 30000/1001 */
export function effectiveFps(request: RenderRequest, meta?: ProjectMeta | null): number | null {
  const fromMode = (): number | null => {
    if (request.fpsMode === 'project') return meta?.fps ?? null
    if (request.fpsMode === 'custom') {
      const raw = (request.customFps ?? '').trim()
      if (!raw) return null
      const rational = raw.match(/^(\d+)\s*\/\s*(\d+)$/)
      if (rational) {
        const value = Number(rational[1]) / Number(rational[2])
        return Number.isFinite(value) && value > 0 ? value : null
      }
      const value = Number(raw)
      return Number.isFinite(value) && value > 0 ? value : null
    }
    const value = Number(request.fpsMode)
    return Number.isFinite(value) && value > 0 ? value : null
  }
  return fromMode() ?? meta?.fps ?? 30
}

function frameCountOf(fps: number | null, meta?: ProjectMeta | null): number | null {
  if (!fps || fps <= 0) return null
  const duration = meta?.durationSec
  if (!duration || duration <= 0) return null
  return Math.ceil(duration * fps)
}

/** 输出像素尺寸：优先用分辨率预设，project 模式回落到项目自身尺寸 */
export function outputDimensions(
  request: RenderRequest,
  meta?: ProjectMeta | null
): { width: number; height: number } | null {
  const preset = RESOLUTION_DIMENSIONS[request.resolution]
  if (preset) return preset
  if (meta?.width && meta?.height) return { width: meta.width, height: meta.height }
  return null
}

/**
 * 是否需要 alpha：带透明通道时 CLI 会改用 PNG 捕获（每帧原始 RGBA，体积约为 JPEG 的 4 倍）。
 * MOV 固定 ProRes 4444、PNG 序列必然保留 alpha；
 * WebM 取决于合成是否透明，这里按有 alpha 估算（保守）。
 */
function needsAlphaCapture(format: VideoFormat): boolean {
  return format === 'png-sequence' || format === 'mov' || format === 'webm'
}

/** 预估单帧字节数（与 CLI estimateDiskCaptureBytes 同一套算法） */
export function estimateFrameBytes(input: {
  width: number
  height: number
  quality: RenderRequest['quality']
  format: VideoFormat
}): number {
  const raw = input.width * input.height * 4
  if (needsAlphaCapture(input.format)) return raw
  const divisor = input.quality === 'draft' ? JPEG_DRAFT_RAW_RGBA_DIVISOR : JPEG_RAW_RGBA_DIVISOR
  return Math.ceil(raw / divisor)
}

/** 判断本次渲染是否会走磁盘捕获，并说明原因 */
export function diskCaptureDecision(input: {
  request: RenderRequest
  platform: string
}): { willUseDisk: boolean; reason: string } {
  const { request, platform } = input
  const format = request.format
  const workers = workerCountOf(request)

  // 流式被显式关闭的情况（性能引擎可能下发这些开关）
  const streamDisabled =
    request.env?.HF_CAPTURE_PARALLEL_STREAM === 'false' ||
    request.env?.PRODUCER_ENABLE_STREAMING_ENCODE === 'false'

  if (format === 'png-sequence' || format === 'gif') {
    return {
      willUseDisk: true,
      reason: `${format === 'gif' ? 'GIF' : 'PNG 序列'}输出必须先把全部帧写入磁盘`
    }
  }

  if (streamDisabled) {
    return { willUseDisk: true, reason: '环境变量已关闭流式编码（HF_CAPTURE_PARALLEL_STREAM / PRODUCER_ENABLE_STREAMING_ENCODE）' }
  }

  if (platform !== 'win32') {
    // Linux / macOS 的 BeginFrame 捕获可以多 worker 流式编码
    return { willUseDisk: false, reason: '非 Windows 平台使用 BeginFrame 流式捕获' }
  }

  if (format === 'hls') {
    return { willUseDisk: workers > 1, reason: multiWorkerReason(workers) }
  }

  if (workers === 1) {
    return { willUseDisk: false, reason: 'workers = 1，mp4 / mov 走流式编码' }
  }
  return {
    willUseDisk: true,
    reason: multiWorkerReason(workers)
  }
}

function multiWorkerReason(workers: number): string {
  return `Windows 上 workers = ${workers}（≠ 1）时使用多进程截图捕获，每一帧都会先写盘`
}

/** workers：auto 视作多 worker（CLI 会按硬件自动分配，通常 > 1） */
function workerCountOf(request: RenderRequest): number {
  if (request.workers === 'auto') return 2
  const value = Number(request.workers)
  return Number.isFinite(value) && value > 0 ? value : 1
}

/** 枚举候选暂存目录（系统临时目录 / 用户指定 / 输出盘 / 其他本地盘） */
function collectCandidates(input: {
  request: RenderRequest
  scratchDir?: string | null
  systemTemp: string
}): ScratchCandidate[] {
  const candidates: ScratchCandidate[] = []
  const seen = new Set<string>()

  const push = (dir: string, label: string): void => {
    const key = dir.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const { free, total } = freeBytesAt(dir)
    candidates.push({ dir, freeBytes: free, totalBytes: total, label })
  }

  push(input.systemTemp, '系统临时目录')
  if (input.scratchDir && input.scratchDir.trim()) {
    push(input.scratchDir.trim(), '自定义临时帧目录')
  }
  const outputDir = input.request.outputDir?.trim()
  if (outputDir) push(outputDir, '输出目录所在盘')

  // 其余本地固定盘：取根目录作为落点
  for (const root of localDriveRoots()) {
    if (seen.has(join(root, 'HF-Render-scratch').toLowerCase())) continue
    if (!existsSync(root)) continue
    const dir = join(root, 'HF-Render-scratch')
    push(dir, `${root} 盘`)
  }

  return candidates
}

/** 列出本机所有可用盘符根目录（仅 Windows 有意义，其他平台为空） */
function localDriveRoots(): string[] {
  if (process.platform !== 'win32') return []
  const roots: string[] = []
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      if (existsSync(root)) roots.push(root)
    } catch {
      /* 忽略不可访问的盘 */
    }
  }
  return roots
}

function pickCandidate(candidates: ScratchCandidate[], neededBytes: number | null): ScratchCandidate | null {
  const threshold = neededBytes
    ? neededBytes / CLI_HEADROOM_RATIO + CANDIDATE_RESERVE_BYTES
    : MIN_SCRATCH_BYTES
  const viable = candidates
    .filter((c) => c.freeBytes !== null && c.freeBytes >= threshold)
    .sort((a, b) => (b.freeBytes ?? 0) - (a.freeBytes ?? 0))
  return viable[0] ?? null
}

function describeFree(candidate: ScratchCandidate | undefined): string {
  if (!candidate || candidate.freeBytes === null) return '可用空间未知'
  return `仅剩 ${formatGB(candidate.freeBytes)}`
}

function describeShortage(input: {
  neededBytes: number | null
  systemTemp: string
  systemTempFree: number | null
  request: RenderRequest
}): string {
  const need = input.neededBytes === null ? '数量较大' : `约 ${formatGB(input.neededBytes)}`
  const freeText = input.systemTempFree === null ? '可用空间未知' : `仅剩 ${formatGB(input.systemTempFree)}`
  const advice: string[] = []
  if (input.request.format === 'mp4' || input.request.format === 'mov') {
    advice.push('把 Workers 改成 1（mp4 / mov 在 workers = 1 时走流式编码，不再落盘）')
  }
  advice.push('在「高级参数 → 临时帧存储目录」里把暂存盘指向剩余空间更大的分区')
  advice.push('清理目标盘的临时文件后重试')
  return (
    `临时空间不足：磁盘捕获本次需要 ${need} 存放每一帧，而 ${input.systemTemp} ${freeText}。` +
    `建议：${advice.join('；或 ')}。`
  )
}

/** 主入口：给出本次渲染的临时磁盘预算与处置方案 */
export function planDiskBudget(input: DiskBudgetInput): DiskBudgetPlan {
  const request = input.request
  const platform = input.platform ?? process.platform
  const meta = request.projectMeta ?? null
  const systemTemp = tmpdir()

  const decision = diskCaptureDecision({ request, platform })
  const systemTempSpace = freeBytesAt(systemTemp)

  const base: DiskBudgetPlan = {
    platform,
    willUseDiskCapture: decision.willUseDisk,
    diskCaptureReason: decision.reason,
    frames: null,
    frameBytes: null,
    neededBytes: null,
    tempDir: systemTemp,
    overrideTempDir: null,
    systemTempFreeBytes: systemTempSpace.free,
    candidates: [],
    warnings: [],
    error: null
  }

  if (!decision.willUseDisk) return base

  const fps = effectiveFps(request, meta)
  const frames = frameCountOf(fps, meta)
  const dims = outputDimensions(request, meta)
  const frameBytes = dims ? estimateFrameBytes({ ...dims, quality: request.quality, format: request.format }) : null
  const neededBytes =
    frames && frameBytes ? Math.ceil(frames * frameBytes * SAFETY_FACTOR) : null

  const candidates = collectCandidates({ request, scratchDir: input.scratchDir, systemTemp })
  const plan: DiskBudgetPlan = {
    ...base,
    frames,
    frameBytes,
    neededBytes,
    candidates
  }

  const systemCandidate = candidates.find((c) => c.dir.toLowerCase() === systemTemp.toLowerCase())
  const systemFree = systemCandidate?.freeBytes ?? systemTempSpace.free
  const systemFits =
    systemFree !== null &&
    systemFree >= (neededBytes ? neededBytes / CLI_HEADROOM_RATIO : MIN_SCRATCH_BYTES)

  // 用户明确指定了暂存目录：只要放得下就优先使用，不再看系统临时目录是否够用
  const preferred = input.scratchDir?.trim()
  const fits = (candidate: ScratchCandidate | undefined): boolean =>
    !!candidate &&
    candidate.freeBytes !== null &&
    candidate.freeBytes >= (neededBytes ? neededBytes / CLI_HEADROOM_RATIO : MIN_SCRATCH_BYTES)

  const preferredCandidate = preferred
    ? candidates.find((c) => c.dir.toLowerCase() === preferred.toLowerCase())
    : undefined

  if (preferred) {
    if (fits(preferredCandidate)) {
      if (!ensureDir(preferredCandidate!.dir)) {
        plan.warnings.push(`自定义暂存目录 ${preferredCandidate!.dir} 无法创建，已回退到系统临时目录`)
        return plan
      }
      return {
        ...plan,
        tempDir: preferredCandidate!.dir,
        overrideTempDir: preferredCandidate!.dir,
        warnings: [
          ...plan.warnings,
          `按设置在 ${preferredCandidate!.dir} 存放本次渲染的临时帧（` +
            `${preferredCandidate!.freeBytes === null ? '空间未知' : `剩余 ${formatGB(preferredCandidate!.freeBytes)}`}）`
        ]
      }
    }
    plan.warnings.push(
      `自定义暂存目录 ${preferred} ${describeFree(preferredCandidate)}，放不下本次的临时帧`
    )
  }

  if (systemFits) return plan

  // 其余情况按 autoScratch 决定是否自动挑选空间更充裕的盘
  const chosen = input.autoScratch !== false ? pickCandidate(candidates, neededBytes) : null
  if (chosen) {
    if (!ensureDir(chosen.dir)) {
      plan.warnings.push(`暂存目录 ${chosen.dir} 无法创建，已保持使用系统临时目录`)
      return plan
    }
    const verified = freeBytesAt(chosen.dir)
    return {
      ...plan,
      tempDir: chosen.dir,
      overrideTempDir: chosen.dir,
      warnings: [
        ...plan.warnings,
        `系统临时目录 ${systemTemp} ${systemFree === null ? '空间未知' : `仅剩 ${formatGB(systemFree)}`}，` +
          `本次渲染的临时帧改用 ${chosen.dir}（${verified.free === null ? '空间未知' : `剩余 ${formatGB(verified.free)}`}）`
      ]
    }
  }

  plan.error = describeShortage({
    neededBytes,
    systemTemp,
    systemTempFree: systemFree,
    request
  })
  return plan
}

/** 面向日志的一行摘要 */
export function describeBudget(plan: DiskBudgetPlan): string {
  if (!plan.willUseDiskCapture) {
    return `临时空间  ${plan.diskCaptureReason}，不会落盘（约 0 额外占用）`
  }
  const frames = plan.frames ? `${plan.frames} 帧` : '帧数未知'
  const need = plan.neededBytes ? `预计 ${formatGB(plan.neededBytes)}` : '预计占用未知'
  return (
    `临时空间  ${plan.diskCaptureReason} · ${frames} · ${need} · ` +
    `暂存目录 ${plan.tempDir}${plan.overrideTempDir ? '（已自动切换）' : ''}`
  )
}
