import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import { cacheCounters } from '../cache/counters'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.svg'])
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi'])
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  'renders',
  'dist',
  'build',
  'out',
  '.hf-segments',
  '.debug',
  'cache',
  '.cache'
])

export interface AssetScan {
  imageCount: number
  videoCount: number
  assetBytes: number
  largestAssetBytes: number
  largestAssetPath: string | null
  /** 扫描到的视频文件尺寸（仅记录，不解析编码） */
  videoFiles: string[]
  truncated: boolean
}

export interface EntryAnalysis {
  webgl: boolean
  canvasCount: number
  domElements: number | null
  animationHints: string[]
  /** 入口 HTML 与内联脚本的总体积 */
  entryBytes: number
  htmlFiles: string[]
  /** 是否真的读到了入口文件（读不到时不能据此判断「没有 WebGL」） */
  found: boolean
}

const ANIMATION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /gsap|GreenSock/i, label: 'GSAP' },
  { pattern: /anime\.js|animejs/i, label: 'anime.js' },
  { pattern: /lottie|bodymovin/i, label: 'Lottie' },
  { pattern: /three(\.min)?\.js|THREE\./i, label: 'Three.js' },
  { pattern: /pixi(\.min)?\.js|PIXI\./i, label: 'PixiJS' },
  { pattern: /@keyframes/i, label: 'CSS 关键帧' },
  { pattern: /requestAnimationFrame/i, label: 'requestAnimationFrame' },
  { pattern: /getContext\(\s*['"]webgl/i, label: 'WebGL 上下文' },
  { pattern: /shader|glsl|fragmentShader/i, label: 'Shader' },
  { pattern: /<video[\s>]/i, label: '视频元素' },
  { pattern: /<canvas[\s>]/i, label: 'Canvas 元素' }
]

/** 递归统计素材（浅层扫描，跳过依赖与产物目录） */
export async function scanAssets(root: string, maxFiles = 6000, maxDepth = 6): Promise<AssetScan> {
  const result: AssetScan = {
    imageCount: 0,
    videoCount: 0,
    assetBytes: 0,
    largestAssetBytes: 0,
    largestAssetPath: null,
    videoFiles: [],
    truncated: false
  }
  let visited = 0

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
      cacheCounters.dirListings += 1
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited > maxFiles) {
        result.truncated = true
        return
      }
      const name = entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
        await walk(join(dir, name), depth + 1)
        continue
      }
      visited += 1
      const ext = extname(name).toLowerCase()
      const isImage = IMAGE_EXT.has(ext)
      const isVideo = VIDEO_EXT.has(ext)
      if (!isImage && !isVideo) continue
      const full = join(dir, name)
      let size = 0
      try {
        const stat = await fs.stat(full)
        size = stat.size
        cacheCounters.assetFileStats += 1
      } catch {
        continue
      }
      result.assetBytes += size
      if (isImage) result.imageCount += 1
      if (isVideo) {
        result.videoCount += 1
        if (result.videoFiles.length < 20) result.videoFiles.push(relative(root, full))
      }
      if (size > result.largestAssetBytes) {
        result.largestAssetBytes = size
        result.largestAssetPath = relative(root, full)
      }
    }
  }

  await walk(root, 0)
  return result
}

/** 分析入口 HTML：WebGL / Canvas / DOM 规模 / 动画库特征 */
export async function analyzeEntry(root: string, entryFiles: string[]): Promise<EntryAnalysis> {
  const files = entryFiles.slice(0, 4)
  let combined = ''
  let entryBytes = 0
  const htmlFiles: string[] = []

  for (const rel of files) {
    const full = join(root, rel)
    try {
      const stat = await fs.stat(full)
      if (stat.size > 4 * 1024 * 1024) continue
      const text = await fs.readFile(full, 'utf-8')
      combined += `\n${text}`
      entryBytes += stat.size
      htmlFiles.push(rel)
    } catch {
      /* ignore */
    }
  }

  const hints = ANIMATION_PATTERNS.filter((item) => item.pattern.test(combined)).map((item) => item.label)
  const canvasCount = (combined.match(/<canvas[\s>]/gi) ?? []).length
  const webgl =
    /getContext\(\s*['"]webgl/i.test(combined) ||
    /WebGLRenderer|THREE\.|GLSL|fragmentShader/i.test(combined) ||
    hints.includes('WebGL 上下文')

  // DOM 元素数量只能对静态 HTML 做近似统计，动态生成的内容无法可靠计数
  const tagMatches = combined.match(/<[a-zA-Z][a-zA-Z0-9-]*/g)
  const domElements = tagMatches ? tagMatches.length : null

  return {
    webgl,
    canvasCount,
    domElements,
    animationHints: hints,
    entryBytes,
    htmlFiles,
    found: htmlFiles.length > 0
  }
}

export function projectKeyOf(projectPath: string): string {
  return basename(projectPath)
}
