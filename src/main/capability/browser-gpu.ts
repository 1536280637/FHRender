import { app } from 'electron'
import type { BrowserGpuProbe } from '@shared/types/performance'

interface CompleteGpuInfo {
  gpuDevice?: {
    active?: boolean
    vendorId?: number
    deviceId?: number
    deviceString?: string
    vendorString?: string
    driverVersion?: string
    driverVendor?: string
  }[]
  auxAttributes?: {
    glRenderer?: string
    glVendor?: string
    glVersion?: string
    displayType?: string
  }
}

const SOFTWARE_HINTS = /swiftshader|llvmpipe|software|microsoft basic/i

/**
 * 浏览器侧 GPU 能力探测：直接使用 Electron / Chromium 自己的判定结果，
 * 不做任何基于显卡名称的猜测。
 */
export async function probeBrowserGpu(): Promise<BrowserGpuProbe> {
  let status: Record<string, string> = {}
  try {
    status = (app.getGPUFeatureStatus() ?? {}) as unknown as Record<string, string>
  } catch {
    status = {}
  }

  let info: CompleteGpuInfo | null = null
  try {
    info = (await app.getGPUInfo('complete')) as CompleteGpuInfo
  } catch {
    info = null
  }

  const devices = info?.gpuDevice ?? []
  const active = devices.find((d) => d.active) ?? devices[0] ?? null
  const glRenderer = info?.auxAttributes?.glRenderer ?? null

  const compositingValue = status.gpu_compositing ?? status['gpu_compositing'] ?? ''
  const webglValue = status.webgl ?? ''
  const webgl2Value = status.webgl2 ?? ''
  const videoDecodeValue = status.video_decode ?? ''

  const hardwareCompositing = compositingValue ? compositingValue === 'enabled' : null
  const webgl = webglValue ? webglValue === 'enabled' : null
  const webgl2 = webgl2Value ? webgl2Value === 'enabled' : null
  const hardwareVideoDecode = videoDecodeValue ? videoDecodeValue === 'enabled' : null

  const softwareOnly =
    (hardwareCompositing === false && /software/i.test(compositingValue)) ||
    SOFTWARE_HINTS.test(glRenderer ?? '') ||
    SOFTWARE_HINTS.test(active?.deviceString ?? '') ||
    SOFTWARE_HINTS.test(active?.driverVendor ?? '')

  const reasons: string[] = []
  if (hardwareCompositing === false) reasons.push(`Chromium 合成状态：${compositingValue || '不可用'}`)
  if (glRenderer) reasons.push(`GL 渲染器：${glRenderer}`)
  if (softwareOnly) reasons.push('检测到软件渲染（SwiftShader / Basic Render）')

  return {
    probed: Object.keys(status).length > 0 || devices.length > 0,
    hardwareCompositing,
    webgl,
    webgl2,
    softwareOnly,
    activeGpuName: active?.deviceString ?? active?.vendorString ?? null,
    activeVendorId: typeof active?.vendorId === 'number' ? active.vendorId : null,
    activeDeviceId: typeof active?.deviceId === 'number' ? active.deviceId : null,
    driverVersion: active?.driverVersion ?? null,
    hardwareVideoDecode,
    reason: reasons.join(' · ') || undefined
  }
}
