import { runBinary, runPowerShell } from '../hardware/platform/shell'

/**
 * 清理**孤儿** chrome-headless-shell。
 *
 * 实测问题：渲染被中断（CLI 自己没收拾干净 / 应用退出）时，浏览器子进程会变成孤儿进程，
 * 之后再次渲染可能出现「退出码 0 但没有产物」、长时间卡住，甚至持续占用几百 MB 内存。
 *
 * 重要约束（2026-10-21 修正）：
 * 之前这里无条件杀掉所有 `chrome-headless-shell`。当同时存在另一个正在渲染的 HF Render
 * 实例（或用 npx 在终端里跑的渲染）时，会把别人的浏览器一起杀掉，对方表现为
 * navigation timeout / target closed。现在只杀**父进程已经不存在**的浏览器——
 * 正常渲染中的浏览器，其父进程（hyperframes CLI）还活着，绝不会被误杀。
 */
export async function cleanupStrayBrowsers(): Promise<number> {
  if (process.platform === 'win32') {
    const script = [
      '$shells = Get-CimInstance Win32_Process -Filter "Name=\'chrome-headless-shell.exe\'" -ErrorAction SilentlyContinue;',
      'if (-not $shells) { 0; exit 0 };',
      '$killed = 0;',
      'foreach ($s in $shells) {',
      '  $parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $s.ParentProcessId) -ErrorAction SilentlyContinue;',
      '  if (-not $parent) { Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }',
      '};',
      '$killed'
    ].join(' ')
    const res = await runPowerShell(script, 20_000)
    const killed = Number((res.stdout || '0').trim())
    return Number.isFinite(killed) && killed > 0 ? killed : 0
  }

  // macOS / Linux：进程名会被截断，按命令行匹配；同样只处理父进程已消失的
  const pattern = process.platform === 'darwin' ? 'chrome-headless-s' : 'chrome-headless-shell'
  const script = [
    `ps -axo pid=,ppid=,command= | grep -F '${pattern}' | grep -v grep | while read pid ppid cmd; do`,
    `  if ! kill -0 "$ppid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null && echo "$pid"; fi`,
    `done`
  ].join('\n')
  const res = await runBinary('sh', ['-c', script], { timeoutMs: 10_000 })
  if (res.code !== 0) return 0
  return res.stdout.split(/\r?\n/).filter((line) => line.trim() !== '').length
}
