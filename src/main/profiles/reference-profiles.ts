import type { HardwareReport } from '@shared/types/hardware'
import type { CapturePath } from '@shared/types/performance'

export interface HardwareReference {
  id: string
  name: string
  description: string
  /** 只有 CPU、GPU、内存同时匹配时才认为"同一台机器" */
  match: { cpu: RegExp; gpu: RegExp; memoryGb: [number, number] }
  /** 该设备上值得优先尝试的 worker 候选（仅作候选，不代表结论） */
  workerCandidates: number[]
  preferred: { gpuEncode: boolean; browserGpu: 'auto' | 'on'; capturePath: CapturePath }
  notes: string[]
  /** 实测数据；只有真正跑过 benchmark 才会填写 */
  measured: {
    testedAt: string
    cliVersion: string
    hardware: string
    runs: { config: string; seconds: number; sizeBytes: number | null; note?: string }[]
  } | null
}

/**
 * 开发者实机档案：AMD Ryzen 7 5800H + NVIDIA RTX 3060 Laptop 6GB + 16GB RAM + Windows 11。
 *
 * 注意：
 * 1) 该档案只用于本地开发验证与"同型号机器"的候选推荐；
 * 2) 即使硬件型号一致，也不会自动把这里的数值当作结论应用；
 * 3) 其他用户的设备永远不会读取该档案，除非硬件指纹同样匹配且用户主动运行优化。
 */
export const DEVELOPER_REFERENCE: HardwareReference = {
  id: 'Ryzen7_5800H_RTX3060_16GB',
  name: 'Ryzen7_5800H_RTX3060_16GB',
  description: '开发者实测参考档案 · AMD Ryzen 7 5800H + NVIDIA RTX 3060 Laptop 6GB + 16GB + Windows 11',
  match: { cpu: /Ryzen 7 5800H/i, gpu: /RTX 3060/i, memoryGb: [14, 18] },
  workerCandidates: [1, 2, 3, 4],
  preferred: { gpuEncode: true, browserGpu: 'auto', capturePath: 'default' },
  notes: [
    '本机为 8 核 16 线程，官方建议每 worker 约 256MB Chrome 内存',
    '4K 输出为主要场景，优先验证 GPU 编码与浏览器 GPU 两条链路',
    '该档案不构成其他 RTX 3060 用户的默认配置'
  ],
  measured: {
    testedAt: '2026-10-19T14:36:00.000Z',
    cliVersion: '0.8.174',
    hardware: 'Windows 11 · Ryzen 7 5800H (8C/16T) · RTX 3060 Laptop 6GB · 15.8GB RAM',
    runs: [
      { config: 'auto · GPU 编码', seconds: 24.3, sizeBytes: 24473, note: 'CLI 自行决定 worker 数，本次不是最快' },
      { config: '1 worker · GPU 编码', seconds: 18.8, sizeBytes: 24473, note: '本轮最快' },
      { config: '2 worker · GPU 编码', seconds: 21.5, sizeBytes: 24473 },
      { config: '3 worker · GPU 编码', seconds: 19.4, sizeBytes: 24473 },
      {
        config: '3 worker · CPU 编码（对照）',
        seconds: 22.9,
        sizeBytes: 13619,
        note: '相同 CRF 下 libx264 体积明显更小，说明两者画质并不等价，只用于比较速度'
      }
    ]
  }
}

export function matchReference(hw: HardwareReport): HardwareReference | null {
  const cpu = hw.cpu.model ?? ''
  const gpuNames = hw.gpus.filter((g) => g.kind !== 'virtual').map((g) => g.name).join(' | ')
  const memoryGb = hw.memory.totalBytes / 1024 ** 3
  const ref = DEVELOPER_REFERENCE
  const withinRam = memoryGb >= ref.match.memoryGb[0] && memoryGb <= ref.match.memoryGb[1]
  if (ref.match.cpu.test(cpu) && ref.match.gpu.test(gpuNames) && withinRam) return ref
  return null
}

export function referenceProfileFor(hw: HardwareReport): { id: string; name: string; notes: string[] } | null {
  const ref = matchReference(hw)
  if (!ref) return null
  return { id: ref.id, name: ref.name, notes: ref.notes }
}
