import type { GpuInfo, GpuKind, GpuVendor } from '@shared/types/hardware'

const VENDOR_ID_MAP: Record<number, GpuVendor> = {
  0x10de: 'nvidia',
  0x1002: 'amd',
  0x1022: 'amd',
  0x8086: 'intel',
  0x106b: 'apple',
  0x5143: 'qualcomm',
  0x1414: 'microsoft'
}

/** 依据名称 / 厂商字符串 / PNP ID 判断 GPU 厂商 */
export function detectVendor(input: {
  name?: string | null
  compatibility?: string | null
  pnpId?: string | null
  vendorId?: number | null
}): GpuVendor {
  const fromId = input.vendorId != null ? VENDOR_ID_MAP[input.vendorId] : undefined
  if (fromId) return fromId

  const name = (input.name ?? '').toLowerCase()
  const compat = (input.compatibility ?? '').toLowerCase()
  const pnp = (input.pnpId ?? '').toUpperCase()

  const venMatch = pnp.match(/VEN_([0-9A-F]{4})/)
  if (venMatch) {
    const vendorId = Number.parseInt(venMatch[1], 16)
    const mapped = VENDOR_ID_MAP[vendorId]
    if (mapped) return mapped
  }

  if (/nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b/.test(name) || /nvidia/.test(compat)) return 'nvidia'
  if (/amd|radeon|firepro|instinct|\brx\s?\d/.test(name) || /advanced micro devices|amd/.test(compat)) return 'amd'
  if (/intel|iris|uhd graphics|hd graphics|\barc\b/.test(name) || /intel/.test(compat)) return 'intel'
  if (/apple|\bm1\b|\bm2\b|\bm3\b|\bm4\b/.test(name) || /apple/.test(compat)) return 'apple'
  if (/qualcomm|adreno/.test(name)) return 'qualcomm'
  if (/microsoft|basic render|remote display/.test(name)) return 'microsoft'
  return 'unknown'
}

/** 判断独显 / 核显 / 虚拟显卡 */
export function detectKind(input: { name?: string | null; vendor: GpuVendor; pnpId?: string | null }): GpuKind {
  const name = (input.name ?? '').toLowerCase()
  const pnp = (input.pnpId ?? '').toUpperCase()

  if (/virtual|reflector|remote|parsec|spacedesk|vmware|virtualbox|hyper-v|mumu|basic render|indirect display/i.test(name)) {
    return 'virtual'
  }
  if (pnp.startsWith('ROOT\\') || pnp.startsWith('SWD\\')) return 'virtual'

  // 核显特征
  if (input.vendor === 'intel') {
    if (/iris|uhd|hd graphics|arc graphics|integrated/i.test(name)) return 'integrated'
    return 'integrated'
  }
  if (input.vendor === 'amd') {
    if (/radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|renoir|cezanne|lucienne|rembrandt|phoenix/i.test(name) && !/rx\s?\d|pro w\d|firepro/i.test(name)) {
      return 'integrated'
    }
    return 'discrete'
  }
  if (input.vendor === 'apple') return 'integrated'
  if (input.vendor === 'nvidia') return 'discrete'
  if (input.vendor === 'microsoft') return 'virtual'
  return 'unknown'
}

/** 归一化显卡名，用于指纹与去重 */
export function normalizeGpuName(name: string): string {
  return name
    .replace(/\((R|TM|C)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function gpuIdOf(input: { name: string; pnpId?: string | null; vendor: GpuVendor }): string {
  const pnp = input.pnpId ?? ''
  const dev = pnp.match(/DEV_([0-9A-F]{4})/i)
  const ven = pnp.match(/VEN_([0-9A-F]{4})/i)
  if (dev && ven) return `${input.vendor}:${ven[1].toUpperCase()}:${dev[1].toUpperCase()}`
  return `${input.vendor}:${normalizeGpuName(input.name).toLowerCase()}`
}

/** 该 GPU 可能涉及的编码器线索（仅线索，真实可用性由 capability 层实测） */
export function encoderHintsFor(vendor: GpuVendor): string[] {
  switch (vendor) {
    case 'nvidia':
      return ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc']
    case 'amd':
      return ['h264_amf', 'hevc_amf', 'av1_amf', 'h264_vaapi', 'hevc_vaapi']
    case 'intel':
      return ['h264_qsv', 'hevc_qsv', 'av1_qsv', 'h264_vaapi', 'hevc_vaapi']
    case 'apple':
      return ['h264_videotoolbox', 'hevc_videotoolbox', 'prores_videotoolbox']
    default:
      return []
  }
}

export function emptyGpuMetrics(): GpuInfo['metrics'] {
  return {
    usage3dPct: null,
    videoEncodePct: null,
    videoDecodePct: null,
    copyPct: null,
    vramUsedBytes: null,
    temperatureC: null,
    powerW: null,
    powerLimitW: null
  }
}

/** 选出用于渲染的 GPU：优先非虚拟的独显，其次非虚拟核显，最后任意 */
export function pickPrimaryGpu(gpus: GpuInfo[]): GpuInfo | null {
  const usable = gpus.filter((g) => g.kind !== 'virtual')
  if (usable.length === 0) return gpus[0] ?? null
  const active = usable.find((g) => g.activeForBrowser)
  if (active) return active
  const discrete = usable.find((g) => g.kind === 'discrete')
  return discrete ?? usable[0]
}
