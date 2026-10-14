import { info as runtimeInfo } from '@/utils/runtimeLog'

const logs: string[] = []

/**
 * 启动日志：既保留原来的内存数组（启动失败弹窗、getBootLog() 用），
 * 又同时写入 runtimeLog 落盘。
 *
 * 这样"应用打开后空白"时，用户可以在 设置-错误日志 里看到完整启动链路，
 * 而不是只能看到最后一次失败的弹窗文本（原实现的硬伤）。
 */
export const bootLog = (...msgs: any[]) => {
  const line = msgs.map(m => typeof m == 'string' ? m : JSON.stringify(m)).join(' ')
  logs.push(line)
  runtimeInfo('BOOT', line)
}

export const getBootLog = () => {
  return logs.join('\n')
}
