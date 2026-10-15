import { NativeModules } from 'react-native'
import BackgroundTimer from 'react-native-background-timer'

/**
 * 原生诊断通道（DiagnosticsModule）
 *
 * 为什么需要原生侧证据：有些故障现场 JS 侧根本无法记录——
 * 例如 JS 线程被永久阻塞、进程被系统冻结/杀掉、React 树被卸载后界面空白。
 * 原生模块（android/app/src/main/java/cn/toside/music/mobile/diagnostics/）
 * 独立于 JS 线程写自己的日志文件，并周期性检查"JS 心跳是否还在"，
 * 因此即使在 JS 已经死掉的情况下，也能拿到时间线。
 *
 * 所有方法都做了降级：原生模块不存在（旧版本/其它平台）时返回空值，
 * 绝不影响任何业务逻辑。
 */

interface DiagnosticsNativeModule {
  heartbeat?: (jsTs: number) => Promise<boolean>
  readLog?: () => Promise<string>
  getStatus?: () => Promise<string>
  log?: (tag: string, message: string) => void
  addListener?: (eventName: string) => void
  removeListeners?: (count: number) => void
}

const getModule = (): DiagnosticsNativeModule | null => {
  try {
    const mod = (NativeModules as Record<string, any>)?.DiagnosticsModule as DiagnosticsNativeModule | undefined
    return mod ?? null
  } catch (err) {
    return null
  }
}

export const isNativeDiagnosticsAvailable = (): boolean => {
  const mod = getModule()
  return !!(mod && typeof mod.readLog == 'function')
}

/** 告知原生侧"JS 线程仍然活着"（原生侧据此判断 JS 是否已被阻塞/冻结） */
export const sendNativeJsAck = async(): Promise<boolean> => {
  try {
    const mod = getModule()
    if (!mod?.heartbeat) return false
    return await mod.heartbeat(Date.now())
  } catch (err) {
    return false
  }
}

/** 读取原生诊断日志全文（失败返回空串） */
export const readNativeDiagnosticsLog = async(): Promise<string> => {
  try {
    const mod = getModule()
    if (!mod?.readLog) return ''
    return await mod.readLog()
  } catch (err) {
    return ''
  }
}

/** 读取原生侧即时状态摘要（失败返回空串） */
export const getNativeDiagnosticsStatus = async(): Promise<string> => {
  try {
    const mod = getModule()
    if (!mod?.getStatus) return ''
    return await mod.getStatus()
  } catch (err) {
    return ''
  }
}

/** 往原生时间线里插一条 JS 侧标记（用于把两边日志对齐到同一时刻） */
export const logToNativeTimeline = (tag: string, message: string): void => {
  try {
    getModule()?.log?.(tag, message)
  } catch (err) {}
}

let ackTimer: number | null = null

/**
 * 启动 JS 存活应答循环。
 *
 * 关键点：这里用原生定时器（react-native-background-timer），因此在后台仍然会发；
 * 如果 JS 线程被阻塞或进程被冻结，应答就会中断 —— 原生侧据此写出
 * "no JS ack for Xms" 这条**在 JS 已经无法自救时仍然存在**的关键证据。
 */
export const startNativeJsAckLoop = (intervalMs = 10000): void => {
  try {
    if (ackTimer != null) return
    if (!isNativeDiagnosticsAvailable()) return
    ackTimer = BackgroundTimer.setInterval(() => {
      void sendNativeJsAck()
    }, intervalMs)
    void sendNativeJsAck()
    logToNativeTimeline('JS', `ack loop started intervalMs=${intervalMs}`)
  } catch (err) {}
}

export const stopNativeJsAckLoop = (): void => {
  try {
    if (ackTimer == null) return
    BackgroundTimer.clearInterval(ackTimer)
    ackTimer = null
    logToNativeTimeline('JS', 'ack loop stopped')
  } catch (err) {}
}

export const nativeDiagnostics = {
  isAvailable: isNativeDiagnosticsAvailable,
  sendAck: sendNativeJsAck,
  readLog: readNativeDiagnosticsLog,
  getStatus: getNativeDiagnosticsStatus,
  log: logToNativeTimeline,
  startAckLoop: startNativeJsAckLoop,
  stopAckLoop: stopNativeJsAckLoop,
}

export default nativeDiagnostics
