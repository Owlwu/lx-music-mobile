import { info, warn, error, flushSyncBestEffort } from '@/utils/runtimeLog'

/**
 * JS 线程心跳看门狗
 *
 * 用于排查"长时间听歌后歌曲不播放 / 应用空白"这类问题：
 * 这类现象往往由 JS 线程（事件循环）被长时间阻塞引起——被阻塞期间
 * 定时器不触发、渲染不提交，表现为界面空白且播放器状态不再更新。
 *
 * 做法：用一个周期定时器持续打点。正常情况下每 `interval` 打点一次；
 * 若某次打点距离上一次实测时间超过了 `stallThreshold`，说明这期间
 * JS 线程被卡住了，此时记录一条 STALL 日志，并附上"卡住前最后一次
 * 关键事件"（由 markEvent 记录），从而定位卡死前的最后一步。
 */

export interface StallWatchdogOptions {
  /** 心跳间隔（毫秒），默认 5000 */
  interval?: number
  /** 判定为卡顿的阈值（毫秒），默认 20000 */
  stallThreshold?: number
  /** 是否同时打点常规心跳日志（默认 false，避免日志噪音） */
  logHeartbeat?: boolean
}

export interface WatchdogEvent {
  name: string
  detail?: any
  time: number
  timeText: string
}

export interface StallRecord {
  /** 本次卡顿时长（毫秒） */
  duration: number
  /** 上次正常打点时间 */
  lastTickTime: number
  /** 恢复打点时间 */
  recoveredTime: number
  /** 卡死前最后一次关键事件 */
  lastEvent: WatchdogEvent | null
}

const defaultOptions: Required<StallWatchdogOptions> = {
  interval: 5000,
  stallThreshold: 20000,
  logHeartbeat: false,
}

/** 最近关键事件保留条数 */
const maxRecentEvents = 20

let options: Required<StallWatchdogOptions> = { ...defaultOptions }
let timer: ReturnType<typeof setInterval> | null = null
let lastTickTime = 0
let isRunning = false
let stallCount = 0
let lastStall: StallRecord | null = null
let onStallHandler: ((record: StallRecord) => void) | null = null

/** 最近关键事件环形缓冲，最新的在末尾 */
const recentEvents: WatchdogEvent[] = []

const pad = (num: number, len = 2) => num.toString().padStart(len, '0')

const formatTimeText = (time: number) => {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/** 看门狗自身也不能抛异常 */
const safeRun = (fn: () => void) => {
  try {
    fn()
  } catch (err) {
    try {
      console.log('[stallWatchdog] internal error', err)
    } catch (err2) {}
  }
}

const stringifyDetail = (detail: any): string => {
  if (detail == null) return ''
  if (typeof detail == 'string') return detail
  if (detail instanceof Error) return detail.stack ?? detail.message
  try {
    return JSON.stringify(detail)
  } catch (err) {
    return '[unserializable]'
  }
}

/**
 * 限制 detail 为"可安全长期持有"的标量/浅结构。
 *
 * 原因：markEvent 会被高频调用（每个关键步骤），而看门狗需要长期保留最近若干条。
 * 若调用方传入 `musicInfo`（可能含完整歌词、base64 封面）或整个 playerState，
 * 这些引用会一直阻止 GC —— 而"长时间听歌内存压力"正是本任务要排查的根因，
 * 看门狗自己不能变成泄漏源。因此这里只保留标量，其余折叠为简短字符串。
 */
const sanitizeDetail = (detail: any, depth = 0): any => {
  if (detail == null) return detail
  const type = typeof detail
  if (type == 'string') {
    // 超长字符串（歌词/封面 base64）截断，避免把大对象留在内存里
    const maxLen = 200
    return detail.length > maxLen ? `${detail.slice(0, maxLen)}…(+${detail.length - maxLen})` : detail
  }
  if (type == 'number' || type == 'boolean' || type == 'bigint') return detail
  if (detail instanceof Error) return detail.stack ?? detail.message
  if (type == 'function' || type == 'symbol') return `[${type}]`
  // 只为浅层对象做一次浅拷贝（且限制层数），更深的一律折叠成字符串
  if (depth >= 1) return stringifyDetail(detail)
  try {
    if (Array.isArray(detail)) {
      return detail.slice(0, 20).map(item => sanitizeDetail(item, depth + 1))
    }
    const result: Record<string, any> = {}
    let count = 0
    for (const key of Object.keys(detail as Record<string, unknown>)) {
      if (count++ >= 20) break
      result[key] = sanitizeDetail((detail as Record<string, any>)[key], depth + 1)
    }
    return result
  } catch (err) {
    return stringifyDetail(detail)
  }
}

/**
 * 记录一次"关键事件"。看门狗检测到卡顿时，会把最近的事件一并写入日志，
 * 这样就能知道卡死前用户/播放器最后做了什么。
 *
 * 约定用法：在可能耗时或关键的路径入口调用，如
 *   markEvent('loadMusicUrl', { id: musicInfo.id, source: musicInfo.source })
 *   markEvent('render', 'HomeScreen')
 *
 * 注意：detail 会被**浅拷贝并裁剪**（只保留标量、最多 20 项/层、字符串截断到 200 字符），
 * 因此请只传少量标量字段，不要传整个对象（如 musicInfo / playerState），
 * 既避免 GC 压力，也让日志更可读。
 */
export const markEvent = (name: string, detail?: any): void => {
  safeRun(() => {
    const time = Date.now()
    const event: WatchdogEvent = {
      name,
      detail: sanitizeDetail(detail),
      time,
      timeText: formatTimeText(time),
    }
    recentEvents.push(event)
    if (recentEvents.length > maxRecentEvents) {
      recentEvents.splice(0, recentEvents.length - maxRecentEvents)
    }
  })
}

/** 取最近关键事件（最新的在末尾） */
export const getRecentEvents = (): WatchdogEvent[] => recentEvents.slice()

/** 取最后一次卡顿记录 */
export const getLastStall = (): StallRecord | null => lastStall

/** 取累计检测到的卡顿次数 */
export const getStallCount = (): number => stallCount

/** 注册卡顿回调（例如用于弹提示/上报），传 null 取消 */
export const setOnStall = (handler: ((record: StallRecord) => void) | null): void => {
  safeRun(() => {
    onStallHandler = handler
  })
}

const handleTick = () => {
  safeRun(() => {
    const now = Date.now()
    const elapsed = now - lastTickTime
    if (lastTickTime !== 0 && elapsed > options.stallThreshold) {
      stallCount++
      const lastEvent = recentEvents.length ? recentEvents[recentEvents.length - 1] : null
      const record: StallRecord = {
        duration: elapsed,
        lastTickTime,
        recoveredTime: now,
        lastEvent,
      }
      lastStall = record
      // 用 error 等级，保证在设置成较高等级时也一定被记录
      error('STALL', `JS thread blocked for ${elapsed}ms`, {
        durationMs: elapsed,
        lastTickAt: formatTimeText(lastTickTime),
        recoveredAt: formatTimeText(now),
        stallCount,
        lastEvent: lastEvent ? `${lastEvent.name} @ ${lastEvent.timeText}` : 'none',
        lastEventDetail: lastEvent?.detail != null ? stringifyDetail(lastEvent.detail) : undefined,
        recentEvents: recentEvents.slice(-5).map(e => `${e.timeText} ${e.name}${e.detail != null ? ` ${stringifyDetail(e.detail)}` : ''}`).join(' | '),
      })
      // 卡顿恢复后立即落盘，避免恢复瞬间再次卡死导致这条关键日志丢失
      void flushSyncBestEffort()
      if (onStallHandler) onStallHandler(record)
    } else if (options.logHeartbeat) {
      info('HEARTBEAT', 'tick', { elapsedMs: elapsed, recentEventCount: recentEvents.length })
    }
    lastTickTime = now
  })
}

/**
 * 启动看门狗。可安全重复调用（已启动时仅更新配置）。
 * 注意：使用普通 setInterval，其回调本身即可反映 JS 线程是否被阻塞。
 */
export const start = (opts?: StallWatchdogOptions): void => {
  safeRun(() => {
    if (opts) options = { ...options, ...opts }
    if (isRunning) {
      warn('WATCHDOG', 'watchdog already started, options updated', {
        interval: options.interval,
        stallThreshold: options.stallThreshold,
      })
      return
    }
    isRunning = true
    lastTickTime = Date.now()
    timer = setInterval(handleTick, options.interval)
    info('WATCHDOG', 'watchdog started', {
      interval: options.interval,
      stallThreshold: options.stallThreshold,
      maxRecentEvents,
    })
  })
}

/** 停止看门狗 */
export const stop = (): void => {
  safeRun(() => {
    if (timer != null) clearInterval(timer)
    timer = null
    isRunning = false
    lastTickTime = 0
    info('WATCHDOG', 'watchdog stopped')
  })
}

/** 是否运行中 */
export const isStarted = (): boolean => isRunning

/** 手动打点一次（用于那些不使用定时器的场景，例如后台恢复后立即校验） */
export const tick = (): void => { handleTick() }

/** 导出看门狗状态文本，供"应用空白"时一并展示 */
export const getWatchdogSnapshot = (): string => {
  const lines = [
    '[WATCHDOG]',
    `running: ${isRunning}`,
    `interval: ${options.interval}`,
    `stallThreshold: ${options.stallThreshold}`,
    `stallCount: ${stallCount}`,
    `lastTick: ${lastTickTime ? formatTimeText(lastTickTime) : 'never'}`,
  ]
  if (lastStall) {
    lines.push(
      `lastStall: ${lastStall.duration}ms (${formatTimeText(lastStall.lastTickTime)} -> ${formatTimeText(lastStall.recoveredTime)})`,
      `lastStallEvent: ${lastStall.lastEvent ? `${lastStall.lastEvent.name} @ ${lastStall.lastEvent.timeText}` : 'none'}`,
    )
  } else {
    lines.push('lastStall: none')
  }
  lines.push('recentEvents:')
  for (const event of recentEvents.slice(-10)) {
    lines.push(`  ${event.timeText} ${event.name}${event.detail != null ? ` ${stringifyDetail(event.detail)}` : ''}`)
  }
  return lines.join('\n')
}

export const stallWatchdog = {
  start,
  stop,
  isStarted,
  tick,
  markEvent,
  getRecentEvents,
  getLastStall,
  getStallCount,
  setOnStall,
  getWatchdogSnapshot,
}

export default stallWatchdog
