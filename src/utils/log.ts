import {
  legacyLogPath,
  writeLegacy,
  info as runtimeInfo,
  init as initRuntimeLog,
  flush,
  flushSyncBestEffort,
  exportDiagnostics,
  getSnapshot,
  readLegacyLogFile,
  clearLegacyLogFile,
  rotateLegacyFileIfNeeded,
  setLevel,
  getLevel,
  type RuntimeLogLevel,
} from '@/utils/runtimeLog'

/**
 * 兼容层：保留原有导出（init / getLogs / clearLogs / log.{info,warn,error}），
 * 内部转接到 runtimeLog。这样既有调用方（errorHandle、localMediaMetadata、
 * userApi、plugins/sync/log、plugins/storage 等）无需改动。
 *
 * 与旧实现的差异（都是修复既有缺陷）：
 * 1. 旧实现每次日志都 await appendFile，IO 抖动明显；现在改为批量 flush；
 * 2. 旧 error.log 无上限、无轮转，长期运行会无限增长；现在按大小轮转，
 *    保留最近 2 个备份；
 * 3. 旧实现只在 init 之前缓存日志，init 之后无内存缓冲；现在始终保留
 *    最近 1000 条内存环形缓冲，"应用空白"时可一次性导出。
 */

/** 旧日志文件路径（惰性解析，保持向后兼容） */
export const getLogPath = (): string => legacyLogPath()

const stringify = (msgs: any[]): string => {
  try {
    return msgs.map(m => typeof m == 'string' ? m : m instanceof Error ? m.stack ?? m.message : JSON.stringify(m)).join(' ')
  } catch (err) {
    return '[unserializable]'
  }
}

/**
 * 初始化日志。可安全重复调用；init 之前产生的日志会在 init 后回灌。
 */
export const init = async(): Promise<void> => {
  // 先让 runtimeLog 就绪（内部已做异常兜底）
  await initRuntimeLog()
  try {
    // 旧 error.log 也启用轮转，避免其无限增长（历史遗留缺陷）
    await rotateLegacyFileIfNeeded()
  } catch (err) {}
  runtimeInfo('LOG', 'legacy log bridge initialized', { path: getLogPath() })
  // 回灌 init 前由旧通道产生的日志
  await flush()
}

/**
 * 读取错误日志（含轮转备份），保留旧的分隔符格式，
 * 设置页 Log.tsx 按 '\n----lx log----\n' 切分展示，行为不变。
 */
export const getLogs = async(): Promise<string> => {
  try {
    const text = await readLegacyLogFile()
    if (text) return text
    // 旧文件为空时，回退到运行时日志快照，避免"日志是空的、没法排查"
    return getSnapshot()
  } catch (err) {
    return ''
  }
}

/**
 * 清空错误日志（含备份与内存缓冲）。
 */
export const clearLogs = async(): Promise<void> => {
  try {
    await clearLegacyLogFile()
  } catch (err) {}
}

export const log = {
  info(...msgs: any[]) {
    const msg = stringify(msgs)
    if (msg.startsWith('%c')) return
    writeLegacy('LOG', msg)
  },
  warn(...msgs: any[]) {
    const msg = stringify(msgs)
    if (msg.startsWith('%c')) return
    writeLegacy('WARN', msg)
  },
  error(...msgs: any[]) {
    writeLegacy('ERROR', stringify(msgs))
  },
}

/** 供设置页/诊断页使用：把运行时日志与看门狗状态一次性导出 */
export const getDiagnostics = (): string => exportDiagnostics()

/** 透传：把待写日志立即落盘（AppState 变化、播放状态切换时调用） */
export const flushLogs = async(): Promise<void> => flush()

/** 透传：尽力立即落盘。可 await 以确认写完；不 await 则可能丢（见 runtimeLog 文档） */
export const flushLogsSyncBestEffort = (): Promise<void> => flushSyncBestEffort()

/** 透传：设置最低输出等级 */
export const setLogLevel = (level: RuntimeLogLevel): void => setLevel(level)

/** 透传：读取当前最低输出等级 */
export const getLogLevel = (): RuntimeLogLevel => getLevel()

/** 透传：取内存中的最近日志快照（"应用空白"场景直接展示） */
export const getLogSnapshot = (limit?: number): string => getSnapshot(limit)
