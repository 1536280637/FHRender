import type { RenderSettings } from '@shared/types/render'

/** 渲染参数默认值（与应用主进程保持一致，仅作为前端初始值） */
export const DEFAULT_SETTINGS: { render: RenderSettings; cliCommand: string } = {
  render: {
    format: 'mp4',
    fpsMode: 'project',
    customFps: '',
    quality: 'looks',
    resolution: 'project',
    docker: false,
    gpu: false,
    browserGpu: 'auto',
    workers: 'auto',
    crf: null,
    videoBitrate: '',
    strict: false,
    gifLoop: 0,
    hlsSegmentSeconds: 4
  },
  cliCommand: 'npx --yes hyperframes@latest'
}
