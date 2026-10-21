/**
 * 渲染参数的硬性安全边界（主进程与界面共用）。
 *
 * 为什么需要：`--browser-timeout` 这个名字看起来像"浏览器启动超时"，
 * 但 HyperFrames CLI 实际把它当成 page.goto 的**导航超时**（秒 × 1000 → 毫秒）。
 * 一旦设成 1 秒，页面永远来不及跑到 domcontentloaded，每次渲染都会失败，
 * 并在 CLI 内部重试时抛出 Chromium 的 "Requesting main frame too early!"。
 *
 * 所以这里把「不允许下发的值」集中定义，主进程拼参数时过滤、界面输入时限制、
 * 设置读取时清掉历史脏值，三处使用同一份规则。
 */

/** 允许下发的最小导航超时（秒）；小于它是必然失败的地雷值 */
export const MIN_BROWSER_TIMEOUT_SEC = 10
/** 上限：超过 10 分钟的导航等待没有实际意义，还可能是输入错误 */
export const MAX_BROWSER_TIMEOUT_SEC = 600

export interface BrowserTimeoutCheck {
  /** 可以安全下发的值；null 表示不要传这个参数（使用 CLI 默认值） */
  value: number | null
  /** 输入里确实有值、但被判定为危险/非法而丢弃 */
  ignored: boolean
  /** 给用户看的原因（ignored 时非空） */
  reason: string | null
}

/**
 * 校验导航超时。
 * - 空 / 非数字 / 非正数 → 视为未设置（不传参数，用 CLI 默认 60s）
 * - 1–9 秒 → 危险值，丢弃并给出原因
 * - > 600 秒 → 明显误输入，丢弃
 * - 10–600 秒 → 正常下发
 */
export function checkBrowserTimeout(input: unknown): BrowserTimeoutCheck {
  if (input === null || input === undefined || input === '') {
    return { value: null, ignored: false, reason: null }
  }
  const num = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(num) || num <= 0) {
    return { value: null, ignored: false, reason: null }
  }
  const rounded = Math.round(num)
  if (rounded < MIN_BROWSER_TIMEOUT_SEC) {
    return {
      value: null,
      ignored: true,
      reason:
        `浏览器导航超时 ${rounded}s 小于 ${MIN_BROWSER_TIMEOUT_SEC}s：该参数实际是 page.goto 的导航超时，` +
        `过小会让页面必然加载失败（Navigation timeout / Requesting main frame too early），已忽略并使用 CLI 默认值`
    }
  }
  if (rounded > MAX_BROWSER_TIMEOUT_SEC) {
    return {
      value: null,
      ignored: true,
      reason: `浏览器导航超时 ${rounded}s 超过上限 ${MAX_BROWSER_TIMEOUT_SEC}s，已忽略并使用 CLI 默认值`
    }
  }
  return { value: rounded, ignored: false, reason: null }
}

/** 便捷版：只取可下发的值（危险值 / 非法值 → null） */
export function sanitizeBrowserTimeout(input: unknown): number | null {
  return checkBrowserTimeout(input).value
}
