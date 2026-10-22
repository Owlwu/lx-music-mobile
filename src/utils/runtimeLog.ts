import { appendFile, existsFile, readFile, stat, temporaryDirectoryPath, unlink, writeFile } from '@/utils/fs'

/**
 * 运行时日志基础设施
 *
 * 设计目标：排查"长时间听歌后歌曲不播放/应用空白"这类难以复现的问题。
 * 为此本模块需要做到：
 * 1. 全生命周期可埋点（播放、生命周期、渲染），而不是只记扫描歌曲；
 * 2. 持续写盘但不因日志 IO 造成抖动（批量 flush）；
 * 3. 永不无限增长（轮转 + 备份上限）；
 * 4. 崩溃/空白时能一次性把最近上下文导出（内存环形缓冲）；
 * 5. 日志本身任何失败都必须静默降级，绝不能反过来搞崩 App。
 */

export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RuntimeLogEntry {
  /** 时间戳（毫秒） */
  time: number
  /** 格式化后的时间，形如 2024-01-01 12:00:00.123 */
  timeText: string
  level: RuntimeLogLevel
  /** 业务标签，如 PLAYER / APP_STATE / RENDER */
  tag: string
  /** 已格式化好的单行文本（含时间、等级、tag、结构化字段） */
  text: string
  /** 结构化字段（原样保留，供导出 JSON 使用） */
  fields?: Record<string, any>
}

export interface RuntimeLogOptions {
  /** 内存环形缓冲条数，默认 1000 */
  maxMemoryEntries?: number
  /** 单文件轮转阈值（字节），默认 512 * 1024 */
  maxFileSize?: number
  /** 保留的备份数量，默认 2（即 runtime.log.1、runtime.log.2） */
  maxBackupCount?: number
  /** 批量 flush 的条数阈值，默认 20 */
  flushBatchSize?: number
  /** 批量 flush 的时间间隔（毫秒），默认 2000 */
  flushInterval?: number
  /** 最低输出等级，默认 debug */
  minLevel?: RuntimeLogLevel
}

const defaultOptions: Required<RuntimeLogOptions> = {
  maxMemoryEntries: 1000,
  // 保留期按"故障可能潜伏多久"来定，不是越大约好（实测播放中约 170KB/小时）：
  // 2MB × (1 当前 + 3 备份) = 8MB ≈ 48 小时，足以覆盖已观测到的 18.7h / 30.1h 潜伏期。
  maxFileSize: 2 * 1024 * 1024,
  maxBackupCount: 3,
  flushBatchSize: 20,
  flushInterval: 2000,
  minLevel: 'debug',
}

const levelWeight: Record<RuntimeLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

// 原 error.log 的分隔符，保留兼容（设置页按该分隔符切分展示）
const legacySeparator = '\n----lx log----\n'

/**
 * 无条件安全执行：日志模块自身的任何异常都必须被吞掉，
 * 否则"记录日志"反而会把 App 搞崩。
 */
const safeRun = (fn: () => void) => {
  try {
    fn()
  } catch (err) {
    // 只往控制台输出，且输出本身也要防炸
    try {
      console.log('[runtimeLog] internal error', err)
    } catch (err2) {}
  }
}

/** 异步安全执行包装：日志模块自身的异常一律吞掉 */
const safeRunAsync = async(fn: () => Promise<void>): Promise<void> => {
  try {
    await fn()
  } catch (err) {
    try {
      console.log('[runtimeLog] internal error', err)
    } catch (err2) {}
  }
}

const pad = (num: number, len = 2) => num.toString().padStart(len, '0')

const formatTimeText = (time: number) => {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

const normalizeLevel = (level: any): RuntimeLogLevel => {
  switch (level) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
      return level
    default:
      return 'info'
  }
}

/** 把任意入参转成可读字符串，语义与旧 log.ts 保持一致（Error 取 stack） */
const stringifyArg = (arg: any): string => {
  if (typeof arg == 'string') return arg
  if (arg instanceof Error) return arg.stack ?? arg.message
  if (arg === undefined) return 'undefined'
  try {
    return JSON.stringify(arg)
  } catch (err) {
    try {
      return String(arg)
    } catch (err2) {
      return '[unserializable]'
    }
  }
}

const isPlainObject = (val: any): val is Record<string, any> => {
  return val != null && typeof val == 'object' && !Array.isArray(val) && !(val instanceof Error)
}

const formatFields = (fields?: Record<string, any>): string => {
  if (fields == null) return ''
  const parts: string[] = []
  for (const key of Object.keys(fields)) {
    const value = fields[key]
    if (value === undefined) continue
    parts.push(`${key}=${typeof value == 'string' ? value : stringifyArg(value)}`)
  }
  return parts.length ? ` ${parts.join(' ')}` : ''
}

interface RuntimeLogState {
  options: Required<RuntimeLogOptions>
  /** 内存环形缓冲，最新的在末尾 */
  entries: RuntimeLogEntry[]
  /** 待写盘队列 */
  pending: string[]
  /** 旧 error.log 的待写队列（保持旧分隔符格式） */
  legacyPending: string[]
  /** 已 init 且文件就绪 */
  isReady: boolean
  /** init 之前的日志，init 后回灌（与 bootLog 模式一致） */
  isInited: boolean
  /** 统一按 number 保存：background timer 与 RN 定时器都返回数字 id，
   * 但 TS 环境下 `ReturnType<typeof setTimeout>` 可能是 NodeJS.Timeout，故显式收窄。 */
  flushTimer: number | null
  /** flush 定时器由哪套定时器提供：后台必须用原生定时器，详见 scheduleFlush */
  flushTimerKind: 'none' | 'background' | 'js'
  /** 当前 runtime.log 的近似大小，用于免 IO 判断轮转 */
  currentSize: number
  isFlushing: boolean
  /** 轮转进行中标记，避免并发轮转把日志写乱 */
  isRotating: boolean
  /** recordMemory 不可用时只 warn 一次 */
  hasWarnedMemoryUnsupported: boolean
  /** 文件写失败时只 warn 一次，避免刷屏 */
  hasWarnedWriteFailure: boolean
  /** 写入失败计数，供诊断导出展示 */
  writeFailureCount: number
}

const state: RuntimeLogState = {
  options: { ...defaultOptions },
  entries: [],
  pending: [],
  legacyPending: [],
  isReady: false,
  isInited: false,
  flushTimer: null,
  flushTimerKind: 'none',
  currentSize: 0,
  isFlushing: false,
  isRotating: false,
  hasWarnedMemoryUnsupported: false,
  hasWarnedWriteFailure: false,
  writeFailureCount: 0,
}

/**
 * 路径惰性解析：不在模块加载期拼接（平台目录若在极早期尚未就绪，
 * 拼接会得到 'undefined/runtime.log' 这种坏路径）。任何异常都降级为空串，
 * 调用方见到空串即跳过所有文件操作，只保留内存缓冲。
 */
let cachedRuntimePath: string | null = null
let cachedLegacyPath: string | null = null

const getPaths = (): { runtime: string, legacy: string } => {
  if (cachedRuntimePath == null) {
    try {
      const dir = temporaryDirectoryPath
      cachedRuntimePath = typeof dir == 'string' && dir ? `${dir}/runtime.log` : ''
      cachedLegacyPath = typeof dir == 'string' && dir ? `${dir}/error.log` : ''
    } catch (err) {
      cachedRuntimePath = ''
      cachedLegacyPath = ''
    }
  }
  return { runtime: cachedRuntimePath, legacy: cachedLegacyPath ?? '' }
}

/** 运行时日志文件路径（惰性解析；不可用时返回空串） */
export const runtimeLogPath = (): string => getPaths().runtime

/** 兼容旧调用方（error.log）的文件路径（惰性解析；不可用时返回空串） */
export const legacyLogPath = (): string => getPaths().legacy

const backupPathOf = (path: string, index: number) => `${path}.${index}`

/**
 * 会话标识：每次 JS 进程启动生成一个。
 *
 * 为什么需要它：本模块的日志文件跨进程累积（同一次安装会留下多次启动的记录），
 * 而"故障发生的那一次启动"必须能被明确指认出来——否则跨会话导出后，
 * 读者无法判断哪一段属于出问题的那次运行、上一次是否正常退出。
 */
const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const sessionStartTime = Date.now()

/** 当前会话 id（跨会话日志中用于定位"这一次启动"） */
export const getSessionId = (): string => sessionId
/** 当前会话开始时间（毫秒时间戳） */
export const getSessionStartTime = (): number => sessionStartTime

/**
 * 后台可用的定时器。
 *
 * 背景（本文件最关键的一处修复）：RN 在 App 退到后台时会**暂停全部 JS 定时器**
 * （ReactAndroid JavaTimerManager.onHostPause() → isPaused=true，
 * setTimeout/setInterval/requestAnimationFrame 在后台完全不触发）。
 * 而"长时间后台播放后挂掉"恰恰是唯一需要日志的场景：若 flush 仍由 setTimeout 调度，
 * 后台期间产生的日志只会停在内存里，进程一旦被系统杀掉就全部丢失——
 * 这正是"导出的日志里故障窗口完全空白"的机制。
 *
 * react-native-background-timer 走原生 Handler + 事件回调
 * （node_modules/react-native-background-timer/android/.../BackgroundTimerModule.java:71-80），
 * 不受该暂停影响，因此 flush 优先用它；取不到时降级为普通 setTimeout（前台照常工作）。
 */
interface BackgroundTimerLike {
  setTimeout: (callback: () => void, timeout: number) => number
  clearTimeout: (id: number) => void
}

let backgroundTimerModule: BackgroundTimerLike | null | undefined

const getBackgroundTimer = (): BackgroundTimerLike | null => {
  if (backgroundTimerModule !== undefined) return backgroundTimerModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-background-timer')
    const timer = (mod?.default ?? mod) as Partial<BackgroundTimerLike> | undefined
    backgroundTimerModule = typeof timer?.setTimeout == 'function' && typeof timer?.clearTimeout == 'function'
      ? timer as BackgroundTimerLike
      : null
  } catch (err) {
    backgroundTimerModule = null
  }
  return backgroundTimerModule
}

const clearFlushTimer = () => {
  if (state.flushTimer == null) return
  if (state.flushTimerKind == 'background') getBackgroundTimer()?.clearTimeout(state.flushTimer)
  else clearTimeout(state.flushTimer)
  state.flushTimer = null
  state.flushTimerKind = 'none'
}

const scheduleFlush = (delayMs?: number) => {
  if (state.flushTimer != null) return
  const interval = delayMs ?? state.options.flushInterval
  const onTimer = () => {
    state.flushTimer = null
    state.flushTimerKind = 'none'
    void flush()
  }
  const backgroundTimer = getBackgroundTimer()
  if (backgroundTimer) {
    state.flushTimerKind = 'background'
    state.flushTimer = backgroundTimer.setTimeout(onTimer, interval)
  } else {
    state.flushTimerKind = 'js'
    state.flushTimer = setTimeout(onTimer, interval) as unknown as number
  }
}

/**
 * 安全地把 from 内容搬到 to：读内容 → 写目标 → 校验 → 再删源。
 *
 * 为什么不用 FileSystem.mv / rename：原生实现（FsFile.java:143-156）为
 * ```java
 * this.file.renameTo(desFile);   // 返回值被丢弃
 * this.file.delete();            // 无条件删除源文件
 * ```
 * `java.io.File.renameTo` 在目标已存在/失败时返回 false 且不抛异常，而 Java 层
 * 不检查返回值就无条件删除源文件 —— 结果是"源被删、目标也没写对"，
 * JS 侧 mv 却正常 resolve，异常被完全吞掉。对排查崩溃用的日志而言，
 * 证据被静默销毁比不写日志更糟，因此这里改为显式 copy + 校验 + 删源。
 *
 * @returns 是否成功搬运
 */
const safeMoveFile = async(from: string, to: string): Promise<boolean> => {
  try {
    const fromSize = await readSize(from)
    const data = await readFile(from)
    await writeFile(to, data)
    // 校验目标确实写成功且大小一致，才允许删除源文件
    const toSize = await readSize(to)
    if (toSize !== fromSize) {
      pushEntry('warn', 'RUNTIME_LOG', 'rotate copy size mismatch, keep source', { from, to, fromSize, toSize }, false)
      return false
    }
    return true
  } catch (err) {
    // 搬运失败：保留源文件（宁可不轮转，也不能丢日志），并留一条 warn
    pushEntry('warn', 'RUNTIME_LOG', 'rotate copy failed, keep source', { from, to, error: stringifyArg(err) }, false)
    return false
  }
}

/**
 * 轮转：runtime.log -> runtime.log.1 -> runtime.log.2，超出备份数的最旧文件被删除。
 * 全部使用 fs.ts 已有封装（existsFile/readFile/writeFile/stat/unlink），不引入新依赖。
 *
 * 取舍（重要）：任何一步搬运失败时，**宁可放弃本次轮转、让文件继续增长，也绝不丢日志**。
 * 因此主日志只有在"成功搬进备份"之后才会被清空重建；搬运失败则原文件保持原样。
 * 文件因此可能暂时超过 maxFileSize，下一次 flush 会再用 `readSize` 的真实字节数
 * 重新判断并重试轮转，不会永久失效。
 */
const rotateFile = async(path: string): Promise<void> => {
  const maxBackup = state.options.maxBackupCount
  if (maxBackup <= 0) {
    await unlink(path).catch(() => {})
    return
  }
  // 先删掉最旧的备份，再从后往前滚动
  await unlink(backupPathOf(path, maxBackup)).catch(() => {})
  for (let i = maxBackup - 1; i >= 1; i--) {
    const from = backupPathOf(path, i)
    const to = backupPathOf(path, i + 1)
    const isExists = await existsFile(from).catch(() => false)
    if (!isExists) continue
    await unlink(to).catch(() => {})
    // 只有搬运成功才删除源文件（safeMoveFile 内部已校验）
    if (await safeMoveFile(from, to)) await unlink(from).catch(() => {})
  }
  const isExists = await existsFile(path).catch(() => false)
  if (isExists) {
    const backup = backupPathOf(path, 1)
    await unlink(backup).catch(() => {})
    // 关键：只有搬运成功，才允许清空/重建主文件。
    // 若搬运失败（复制校验不通过等），保留主文件原样、放弃本次轮转，
    // 否则会出现"备份被删 + 主文件被清空 = 新旧日志同时消失"。
    if (await safeMoveFile(path, backup)) {
      await unlink(path).catch(() => {})
      await writeFile(path, '').catch(() => {})
    }
  } else {
    await writeFile(path, '').catch(() => {})
  }
}

const ensureFileReady = async(path: string): Promise<boolean> => {
  if (!path) return false
  const isExists = await existsFile(path).catch(() => false)
  if (isExists) return true
  await writeFile(path, '').catch(() => {})
  return await existsFile(path).catch(() => false)
}

const readSize = async(path: string): Promise<number> => {
  try {
    const info = await stat(path)
    return info.size ?? 0
  } catch (err) {
    return 0
  }
}

/**
 * 估算 UTF-8 字节数。
 *
 * 注意：`String.length` 是 UTF-16 码元数，**不是字节数**。本模块日志以中文为主，
 * UTF-8 下中文 1 字符 = 3 字节，直接用 `length` 比较会把文件大小低估最多约 3 倍，
 * 导致 512KB 的轮转阈值形同虚设。
 *
 * 这里不引入 @craftzdog/react-native-buffer（避免新增运行时依赖），
 * 改为按码点统计真实 UTF-8 长度：ASCII 1 字节、U+0080~U+07FF 2 字节、
 * U+0800~U+FFFF 3 字节、代理对（U+10000+）4 字节。
 */
const utf8ByteLength = (text: string): number => {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // 高代理项：与后继低代理项共同构成一个 4 字节码点
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

const doFlush = async(): Promise<void> => {
  const { runtime, legacy } = getPaths()
  if (!state.isReady || !runtime) return
  if (state.isFlushing || state.isRotating) return
  // 分别取走两份待写内容
  const runtimeText = state.pending.join('')
  const legacyText = state.legacyPending.join('')
  if (!runtimeText && !legacyText) return
  state.pending = []
  state.legacyPending = []
  state.isFlushing = true
  try {
    if (runtimeText) {
      const addBytes = utf8ByteLength(runtimeText)
      // 以 fs.stat 的真实字节数为权威来源，累加值只作为兜底估算
      const size = await readSize(runtime)
      state.currentSize = size
      if (size + addBytes > state.options.maxFileSize) {
        state.isRotating = true
        clearFlushTimer()
        try {
          await appendFile(runtime, runtimeText)
          await rotateFile(runtime)
          state.currentSize = 0
        } finally {
          state.isRotating = false
        }
      } else {
        await appendFile(runtime, runtimeText)
        state.currentSize = size + addBytes
      }
    }
    // 旧 error.log 通道：同样轮转，避免历史遗留的无限增长。
    // 必须以「文件总大小」而非「本批长度」比较，否则几乎永不触发轮转。
    if (legacyText && legacy) {
      const addBytes = utf8ByteLength(legacyText)
      const size = await readSize(legacy)
      if (size + addBytes > state.options.maxFileSize) {
        await appendFile(legacy, legacyText)
        await rotateFile(legacy)
      } else {
        await appendFile(legacy, legacyText)
      }
    }
    state.hasWarnedWriteFailure = false
  } catch (err) {
    // 写失败：把内容放回队列下次再试，并且绝不抛出
    state.writeFailureCount++
    if (runtimeText) state.pending = [runtimeText, ...state.pending]
    if (legacyText) state.legacyPending = [legacyText, ...state.legacyPending]
    // 放回后仍要防止队列无限增长
    if (state.pending.length > state.options.maxMemoryEntries) {
      state.pending = state.pending.slice(-state.options.maxMemoryEntries)
    }
    if (state.legacyPending.length > state.options.maxMemoryEntries) {
      state.legacyPending = state.legacyPending.slice(-state.options.maxMemoryEntries)
    }
    if (!state.hasWarnedWriteFailure) {
      state.hasWarnedWriteFailure = true
      pushEntry('warn', 'RUNTIME_LOG', 'write log failed, will retry later', { error: stringifyArg(err) }, false)
    }
  } finally {
    state.isFlushing = false
    // 只要还有未落盘内容就继续调度。
    // 原实现仅在"攒够一批"时调度：并发 flush 之后剩余的内容会一直留在内存里，
    // 后台进程被系统杀掉时这些日志全部丢失。
    if (state.pending.length || state.legacyPending.length) scheduleFlush()
  }
}

/**
 * 内部入队。isPersist=false 表示该条只进内存、不写盘（用于避免告警自身造成递归）。
 */
const pushEntry = (level: RuntimeLogLevel, tag: string, message: string, fields?: Record<string, any>, isPersist = true) => {
  const time = Date.now()
  const entry: RuntimeLogEntry = {
    time,
    timeText: formatTimeText(time),
    level,
    tag,
    text: `${formatTimeText(time)} ${level.toUpperCase()} [${tag}] ${message}${formatFields(fields)}`,
    fields,
  }

  state.entries.push(entry)
  if (state.entries.length > state.options.maxMemoryEntries) {
    state.entries.splice(0, state.entries.length - state.options.maxMemoryEntries)
  }

  if (!isPersist) return
  state.pending.push(entry.text + '\n')
  // init 之前只进内存队列，init 后统一回灌（与 bootLog 模式一致）
  if (!state.isReady) return
  if (state.pending.length >= state.options.flushBatchSize) {
    void flush()
    return
  }
  // warn/error 直接落盘：doFlush 不依赖任何定时器，因此在后台（JS 定时器被系统暂停）
  // 也能真正写文件。普通 info/debug 只调度 flush 定时器。
  if (levelWeight[level] >= levelWeight.warn) {
    void flush()
    return
  }
  scheduleFlush()
}

const resolveArgs = (args: any[]): { message: string, fields?: Record<string, any> } => {
  // 约定：最后一个参数若是纯对象则视为结构化字段
  if (args.length > 1 && isPlainObject(args[args.length - 1])) {
    const fields = args[args.length - 1] as Record<string, any>
    const rest = args.slice(0, -1)
    return { message: rest.map(stringifyArg).join(' '), fields }
  }
  return { message: args.map(stringifyArg).join(' ') }
}

const shouldOutput = (level: RuntimeLogLevel) => levelWeight[level] >= levelWeight[state.options.minLevel]

const write = (level: RuntimeLogLevel, tag: string, args: any[]) => {
  safeRun(() => {
    if (!shouldOutput(level)) return
    // 旧调用方会传 '%c...' 这类 dev 样式日志，直接忽略
    if (typeof args[0] == 'string' && args[0].startsWith('%c')) return
    const { message, fields } = resolveArgs(args)
    pushEntry(level, tag || 'APP', message, fields)
  })
}

/**
 * 只进内存缓冲、不写盘的原始行注入。
 *
 * 用途：把"上一次会话"的文件内容复制进本次会话的内存缓冲。
 * 为什么不写盘：这些内容本来就已经在文件里，重复写入只会让文件翻倍。
 */
const pushRawEntry = (level: RuntimeLogLevel, tag: string, text: string) => {
  const time = Date.now()
  const entry: RuntimeLogEntry = {
    time,
    timeText: formatTimeText(time),
    level,
    tag,
    text,
  }
  state.entries.push(entry)
  if (state.entries.length > state.options.maxMemoryEntries) {
    state.entries.splice(0, state.entries.length - state.options.maxMemoryEntries)
  }
}

const sessionStartMark = '[SESSION] session start'
const sessionEndMark = '[SESSION] session end'

/**
 * 分析"上一次会话"是否正常结束，并取出它最后的若干行。
 *
 * 为什么必须做这件事：设置页的「复制诊断信息」只导出**当前进程的内存缓冲**。
 * 用户遇到"应用空白/不播放"时的习惯做法是杀掉应用重开再看日志——一旦重开，
 * 上一次进程（也就是出故障的那一次）的现场就完全消失了。
 * 这里在启动时从落盘文件里把上一次会话的尾巴捞回来，注入本次内存缓冲，
 * 于是即使只点「复制诊断信息」，也能看到上一次启动的记录。
 */
const analyzePreviousSession = async(path: string): Promise<{
  unclean: boolean
  prevSessionId: string
  prevStartText: string
  tail: string[]
} | null> => {
  try {
    const isExists = await existsFile(path).catch(() => false)
    if (!isExists) return null
    const text = await readFile(path).catch(() => '')
    if (!text) return null
    const lines = text.split('\n')
    let lastStart = -1
    let lastEnd = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lastStart < 0 && lines[i].includes(sessionStartMark)) lastStart = i
      if (lastEnd < 0 && lines[i].includes(sessionEndMark)) lastEnd = i
      if (lastStart >= 0 && lastEnd >= 0) break
    }
    if (lastStart < 0) return null
    const idMatch = /\bid=(\S+)/.exec(lines[lastStart])
    // 最后一次 start 之后没有 end → 上一次是非正常结束（被杀/被冻结/崩溃）
    const unclean = lastEnd < lastStart
    const tail = lines
      .slice(Math.max(lastStart + 1, lines.length - 80))
      .filter(line => line.trim() !== '')
    return {
      unclean,
      prevSessionId: idMatch ? idMatch[1] : '',
      prevStartText: lines[lastStart],
      tail,
    }
  } catch (err) {
    return null
  }
}

/**
 * 初始化日志文件。可安全重复调用。
 * init 之前产生的日志会保留在内存队列中，init 后统一回灌到文件。
 */
export const init = async(options?: RuntimeLogOptions): Promise<void> => {
  return safeRunAsync(async() => {
    if (options) state.options = { ...state.options, ...options }
    const { runtime, legacy } = getPaths()
    if (!runtime) return
    if (state.isReady) return
    state.isReady = await ensureFileReady(runtime)
    if (!state.isReady) return
    state.currentSize = await readSize(runtime)
    // 旧 error.log 也确保存在（设置页直接读它）
    if (legacy) await ensureFileReady(legacy)
    // 读取上一次会话的信息（必须在写入本次会话标记之前完成）
    const previousSession = await analyzePreviousSession(runtime)
    // 回灌 init 之前的日志
    state.isInited = true
    if (state.pending.length || state.legacyPending.length) await flush()
    pushEntry('info', 'RUNTIME_LOG', 'runtime log initialized', {
      path: runtime,
      maxMemoryEntries: state.options.maxMemoryEntries,
      maxFileSize: state.options.maxFileSize,
      maxBackupCount: state.options.maxBackupCount,
      minLevel: state.options.minLevel,
      flushTimer: getBackgroundTimer() ? 'background' : 'js',
    })
    pushEntry('info', 'SESSION', 'session start', {
      id: sessionId,
      fileSizeAtStart: state.currentSize,
      prevSessionId: previousSession?.prevSessionId ?? '',
    })
    if (previousSession) {
      if (previousSession.unclean) {
        warn('SESSION', 'previous session did not end cleanly (killed, frozen or crashed)', {
          prevSessionId: previousSession.prevSessionId,
          prevStartAt: previousSession.prevStartText,
          tailLines: previousSession.tail.length,
        })
        // 把上一次会话的尾部注入内存缓冲：这样「复制诊断信息」（只含内存）也能看到故障现场
        pushRawEntry('warn', 'PREV_SESSION', `----- begin previous session tail (id=${previousSession.prevSessionId}, lines=${previousSession.tail.length}) -----`)
        for (const line of previousSession.tail) pushRawEntry('info', 'PREV_SESSION_RAW', line)
        pushRawEntry('warn', 'PREV_SESSION', '----- end previous session tail -----')
      } else {
        info('SESSION', 'previous session ended cleanly', { prevSessionId: previousSession.prevSessionId })
      }
    }
    await flush()
  })
}

/** 把待写队列落盘；可随时调用（AppState 变化、播放状态切换等关键点） */
export const flush = async(): Promise<void> => {
  return safeRunAsync(async() => {
    clearFlushTimer()
    await doFlush()
  })
}

/**
 * "尽力"落盘，**不保证一定落盘**。
 *
 * RN 没有真正的同步文件写（平台限制）：`doFlush` 内部是
 * `await appendFile(...)` 这类跨桥异步原生调用，无法在同步栈内完成。
 * 因此本函数只是"立即发起一次 flush 并返回 Promise"：
 * - 若你能 `await`，请 `await flushSyncBestEffort()` 以确认真正写完；
 * - 若你在同步收尾路径（如崩溃处理）无法 await，数据可能在 flush 完成前
 *   随进程一起消失 —— 这是 best effort 的固有限制，不要把它当作持久化保证。
 * - 降低丢失窗口的办法是调小 `flushInterval` / `flushBatchSize`。
 */
export const flushSyncBestEffort = async(): Promise<void> => {
  return safeRunAsync(async() => {
    clearFlushTimer()
    await doFlush()
  })
}

export const debug = (tag: string, ...args: any[]) => { write('debug', tag, args) }
export const info = (tag: string, ...args: any[]) => { write('info', tag, args) }
export const warn = (tag: string, ...args: any[]) => { write('warn', tag, args) }
export const error = (tag: string, ...args: any[]) => { write('error', tag, args) }

/** 设置最低输出等级，低于该等级的日志直接丢弃（不入内存也不写盘） */
export const setLevel = (level: RuntimeLogLevel): void => {
  safeRun(() => {
    state.options.minLevel = normalizeLevel(level)
    info('RUNTIME_LOG', 'log level changed', { level: state.options.minLevel })
  })
}

export const getLevel = (): RuntimeLogLevel => state.options.minLevel

/** 更新配置（可在 init 之后调用，用于动态调整轮转/缓冲参数） */
export const setOptions = (options: RuntimeLogOptions): void => {
  safeRun(() => {
    state.options = { ...state.options, ...options }
    if (state.entries.length > state.options.maxMemoryEntries) {
      state.entries.splice(0, state.entries.length - state.options.maxMemoryEntries)
    }
  })
}

/** 获取当前配置副本 */
export const getOptions = (): Required<RuntimeLogOptions> => ({ ...state.options })

/** 取内存环形缓冲（结构化），用于"空白页"场景直接渲染 */
export const getEntries = (): RuntimeLogEntry[] => {
  let result: RuntimeLogEntry[] = []
  safeRun(() => {
    result = state.entries.slice()
  })
  return result
}

/**
 * 取内存环形缓冲文本，供"应用空白"时一次性导出。
 * 失败时返回空串（本函数会在 App 已经不正常时被调用，因此必须静默降级）。
 * @param limit 最多返回多少条（默认全部，最新的在最后）
 * @param level 只导出不低于该等级的日志
 */
export const getSnapshot = (limit?: number, level?: RuntimeLogLevel): string => {
  let result = ''
  safeRun(() => {
    let list = state.entries
    if (level != null) {
      const min = levelWeight[normalizeLevel(level)]
      list = list.filter(entry => levelWeight[entry.level] >= min)
    }
    if (limit != null && limit > 0 && list.length > limit) list = list.slice(-limit)
    result = list.map(entry => entry.text).join('\n')
  })
  return result
}

/** 一次性导出全部诊断信息（内存快照 + 状态），用于反馈问题时粘贴 */
export const exportDiagnostics = (): string => {
  const { runtime } = getPaths()
  const lines = [
    '===== lx runtime log diagnostics =====',
    `export time: ${formatTimeText(Date.now())}`,
    `session id: ${sessionId}`,
    `session uptime: ${Date.now() - sessionStartTime}ms`,
    `log path: ${runtime || '[unavailable]'}`,
    `level: ${state.options.minLevel}`,
    `inited: ${state.isInited}`,
    `file ready: ${state.isReady}`,
    `flush timer: ${state.flushTimerKind}`,
    `memory entries: ${state.entries.length} / ${state.options.maxMemoryEntries}`,
    `pending entries: ${state.pending.length}`,
    `approx file size: ${state.currentSize}`,
    `write failures: ${state.writeFailureCount}`,
    // 注意：这里只有"本次进程"的内存缓冲。上一次启动（往往才是出故障的那一次）
    // 的记录需要通过 buildFullDiagnostics()（设置页「分享日志」/「复制诊断信息」）导出，
    // 或在本次启动时由 analyzePreviousSession() 注入到下方缓冲中。
    '===== recent logs (current process memory buffer only) =====',
    getSnapshot(),
    '===== end =====',
  ]
  return lines.join('\n')
}

/**
 * 标记"本次会话正常结束"并落盘。
 *
 * 下一次启动时 analyzePreviousSession() 依赖这个标记判断上一次是否为非正常结束
 * （被系统杀掉/被冻结/崩溃都不会有这一行）。请在应用真正退出前调用。
 */
export const markCleanExit = async(reason: string): Promise<void> => {
  return safeRunAsync(async() => {
    info('SESSION', 'session end', {
      id: sessionId,
      reason,
      uptimeMs: Date.now() - sessionStartTime,
    })
    await flush()
  })
}

/** 清空内存缓冲与待写队列（清文件请用 clearLogFiles） */
export const clear = (): void => {
  safeRun(() => {
    state.entries = []
    state.pending = []
    state.legacyPending = []
    clearFlushTimer()
  })
}

/** 清空内存 + 删除日志文件及全部备份 */
export const clearLogFiles = async(): Promise<void> => {
  return safeRunAsync(async() => {
    clear()
    const { runtime } = getPaths()
    if (!runtime) return
    await unlink(runtime).catch(() => {})
    const maxBackup = state.options.maxBackupCount
    for (let i = 1; i <= maxBackup; i++) {
      await unlink(backupPathOf(runtime, i)).catch(() => {})
    }
    if (state.isReady) await writeFile(runtime, '').catch(() => {})
    state.currentSize = 0
    state.writeFailureCount = 0
    state.hasWarnedWriteFailure = false
    if (state.isReady) info('RUNTIME_LOG', 'log files cleared')
  })
}

/** 读取日志文本（当前文件 + 备份，最旧在前），供设置页展示 */
export const readLogFile = async(): Promise<string> => {
  const { runtime } = getPaths()
  if (!runtime) return ''
  try {
    await flush()
    const chunks: string[] = []
    const maxBackup = state.options.maxBackupCount
    for (let i = maxBackup; i >= 1; i--) {
      const isExists = await existsFile(backupPathOf(runtime, i)).catch(() => false)
      if (!isExists) continue
      const text = await readFile(backupPathOf(runtime, i)).catch(() => '')
      if (text) chunks.push(text)
    }
    const isExists = await existsFile(runtime).catch(() => false)
    if (isExists) {
      const text = await readFile(runtime).catch(() => '')
      if (text) chunks.push(text)
    }
    return chunks.join('\n')
  } catch (err) {
    return ''
  }
}

/**
 * 只读取日志**尾部**（当前文件优先，不足再往前取备份），最多返回 maxChars 个字符。
 *
 * 为什么需要它：保留期提高后全文可达数 MB，一次性 `readFile` 进 JS 会占十几 MB 内存，
 * 把设置页的「查看运行时日志」拖慢甚至卡住。这里按需从最新往旧取，凑够就停。
 * 需要**完整**内容时请用 {@link readLogFile}（例如文件分享导出）。
 */
export const readLogFileTail = async(maxChars: number): Promise<string> => {
  const { runtime } = getPaths()
  if (!runtime || !(maxChars > 0)) return ''
  try {
    await flush()
    const chunks: string[] = []
    let total = 0
    const isCurrentExists = await existsFile(runtime).catch(() => false)
    if (isCurrentExists) {
      const text = await readFile(runtime).catch(() => '')
      if (text) {
        chunks.unshift(text)
        total += text.length
      }
    }
    const maxBackup = state.options.maxBackupCount
    for (let i = 1; i <= maxBackup && total < maxChars; i++) {
      const path = backupPathOf(runtime, i)
      const isExists = await existsFile(path).catch(() => false)
      if (!isExists) continue
      const text = await readFile(path).catch(() => '')
      if (!text) continue
      // 备份编号越大越旧，因此继续往前插
      chunks.unshift(text)
      total += text.length
    }
    const joined = chunks.join('\n')
    return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined
  } catch (err) {
    return ''
  }
}

interface PerformanceMemory {
  jsHeapSizeLimit?: number
  totalJSHeapSize?: number
  usedJSHeapSize?: number
}

const getMemoryInfo = (): PerformanceMemory | null => {
  try {
    const perf: any = (global as any).performance
    if (perf?.memory?.usedJSHeapSize != null) return perf.memory as PerformanceMemory
    return null
  } catch (err) {
    return null
  }
}

/**
 * 记录一次内存水位。
 * 优先使用 global.performance.memory（Hermes/Chrome 调试环境提供）；
 * 该能力在正式版 RN 中通常不存在，此时降级为 no-op，并只记录一次 warn。
 */
export const recordMemory = (tag = 'MEMORY', extra?: Record<string, any>): void => {
  safeRun(() => {
    const memory = getMemoryInfo()
    if (memory == null) {
      if (!state.hasWarnedMemoryUnsupported) {
        state.hasWarnedMemoryUnsupported = true
        warn(tag, 'performance.memory unavailable, memory sampling disabled', extra)
      }
      return
    }
    const used = memory.usedJSHeapSize ?? 0
    const total = memory.totalJSHeapSize ?? 0
    const limit = memory.jsHeapSizeLimit ?? 0
    info(tag, 'memory', {
      usedMB: +(used / 1024 / 1024).toFixed(2),
      totalMB: +(total / 1024 / 1024).toFixed(2),
      limitMB: +(limit / 1024 / 1024).toFixed(2),
      usedRatio: limit ? +(used / limit).toFixed(4) : 0,
      ...extra,
    })
  })
}

/** 内存采样是否可用（供 UI 决定是否展示内存行） */
export const isMemorySamplingSupported = (): boolean => getMemoryInfo() != null

/**
 * 周期性内存采样。
 *
 * ⚠️ 会持续运行直到调用返回的停止函数，**调用方必须保存并使用它**
 * （例如在 App 卸载/关闭对应界面时调用），否则 `setInterval` 永不停止。
 * 若只是想要一次性水位，直接调用 `recordMemory()`。
 *
 * @returns 停止函数（幂等，可重复调用）
 */
export const startMemorySampling = (interval = 30000): (() => void) => {
  let timer: ReturnType<typeof setInterval> | null = null
  safeRun(() => {
    recordMemory()
    timer = setInterval(() => {
      safeRun(() => {
        recordMemory()
      })
    }, interval)
    // 若运行环境支持 unref（Node），不要让该定时器拖住进程退出
    if (typeof timer?.unref == 'function') timer.unref()
  })
  return () => {
    safeRun(() => {
      if (timer != null) clearInterval(timer)
      timer = null
    })
  }
}

/**
 * 兼容旧版 log.ts 的导出通道：
 * 旧 error.log 使用 '\n----lx log----\n' 分隔，设置页 Log.tsx 按该分隔符切分展示，
 * 因此这里继续沿用同样的落盘格式与文件名，保证既有调用方与 UI 行为不变；
 * 同时该条日志也进入内存环形缓冲，供"应用空白"时一次性导出。
 */
export const writeLegacy = (level: 'LOG' | 'WARN' | 'ERROR', msg: string): void => {
  safeRun(() => {
    const normalized: RuntimeLogLevel = level == 'LOG' ? 'info' : level == 'WARN' ? 'warn' : 'error'
    if (!shouldOutput(normalized)) return
    const time = new Date().toLocaleString()
    const timeNum = Date.now()
    const entry: RuntimeLogEntry = {
      time: timeNum,
      timeText: formatTimeText(timeNum),
      level: normalized,
      tag: 'LEGACY',
      text: `${time} ${level} ${msg}`,
    }
    state.entries.push(entry)
    if (state.entries.length > state.options.maxMemoryEntries) {
      state.entries.splice(0, state.entries.length - state.options.maxMemoryEntries)
    }
    // 旧格式：每条日志前加分隔符
    state.legacyPending.push(`${legacySeparator}${msg}\n`)
    if (!state.isReady) return
    if (state.legacyPending.length >= state.options.flushBatchSize) {
      void flush()
    } else {
      scheduleFlush()
    }
  })
}

/** 读取旧 error.log（含备份），并保留备份能力，避免历史文件无限增长 */
export const readLegacyLogFile = async(): Promise<string> => {
  const { legacy } = getPaths()
  if (!legacy) return ''
  try {
    const isExists = await existsFile(legacy).catch(() => false)
    if (!isExists) return ''
    return await readFile(legacy).catch(() => '')
  } catch (err) {
    return ''
  }
}

/** 清空旧 error.log 并保留轮转备份 */
export const clearLegacyLogFile = async(): Promise<void> => {
  return safeRunAsync(async() => {
    const { legacy } = getPaths()
    state.legacyPending = []
    if (!legacy) return
    await unlink(legacy).catch(() => {})
    await writeFile(legacy, '').catch(() => {})
  })
}

/** 启用旧 error.log 的轮转，防止其无限增长 */
export const rotateLegacyFileIfNeeded = async(): Promise<void> => {
  return safeRunAsync(async() => {
    const { legacy } = getPaths()
    if (!legacy) return
    const isExists = await existsFile(legacy).catch(() => false)
    if (!isExists) return
    const size = await readSize(legacy)
    if (size < state.options.maxFileSize) return
    await rotateFile(legacy)
  })
}

export const runtimeLog = {
  init,
  flush,
  flushSyncBestEffort,
  debug,
  info,
  warn,
  error,
  setLevel,
  getLevel,
  setOptions,
  getOptions,
  getEntries,
  getSnapshot,
  exportDiagnostics,
  getSessionId,
  getSessionStartTime,
  markCleanExit,
  clear,
  clearLogFiles,
  readLogFile,
  readLogFileTail,
  recordMemory,
  isMemorySamplingSupported,
  startMemorySampling,
  writeLegacy,
  readLegacyLogFile,
  clearLegacyLogFile,
  rotateLegacyFileIfNeeded,
}

export default runtimeLog
