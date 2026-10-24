import {
  info as runtimeInfo,
  warn as runtimeWarn,
  error as runtimeError,
  init as initRuntimeLog,
  flush,
} from '@/utils/runtimeLog'

/**
 * 通用日志入口（兼容层）
 *
 * 历史：这里曾是一条独立的 `error.log` 通道，与 `runtimeLog` 并行存在。
 * 结果同一个 App 有两份日志：`error.log` 只被少数模块写入、还混进了全局异常，
 * 而「分享日志」导出的是 `runtime.log`，于是导出文件里看不到这些错误。
 *
 * 现在只保留一条通道：所有 `log.*` 一律写入 `runtime.log`，
 * 「分享日志」导出即覆盖全部模块的运行日志。
 *
 * 注意：**导入本地歌曲**的失败记录不走这里，而是 `@/utils/importLog`
 * （设置页「查看日志」只展示那一份，避免被这里的运行错误淹没）。
 */

/** 初始化日志（可安全重复调用；init 之前产生的日志会在 init 后回灌落盘） */
export const init = async(): Promise<void> => {
  await initRuntimeLog()
  runtimeInfo('LOG', 'log bridge initialized')
  await flush()
}

/** 把任意入参拼成一行可读文本，语义与旧实现保持一致（Error 取 stack） */
const stringify = (msgs: any[]): string => {
  try {
    return msgs.map(msg => typeof msg == 'string' ? msg : msg instanceof Error ? msg.stack ?? msg.message : JSON.stringify(msg)).join(' ')
  } catch (err) {
    return '[unserializable]'
  }
}

export const log = {
  info(...msgs: any[]) {
    const msg = stringify(msgs)
    // 旧调用方会传 '%c...' 这类 dev 样式日志，直接忽略
    if (msg.startsWith('%c')) return
    runtimeInfo('APP', msg)
  },
  warn(...msgs: any[]) {
    const msg = stringify(msgs)
    if (msg.startsWith('%c')) return
    runtimeWarn('APP', msg)
  },
  error(...msgs: any[]) {
    runtimeError('APP', stringify(msgs))
  },
}
