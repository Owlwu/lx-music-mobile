import { AppState, Platform } from 'react-native'
import {
  readLogFile,
  legacyLogPath,
  runtimeLogPath,
  getSessionId,
  getSessionStartTime,
  getSnapshot,
  getOptions,
} from '@/utils/runtimeLog'
import { getWatchdogSnapshot, getStallCount, getLastStall } from '@/utils/stallWatchdog'
import { getHeartbeatSnapshot, resolvePlayerStateName } from '@/utils/playbackHeartbeat'
import { readNativeDiagnosticsLog, getNativeDiagnosticsStatus, isNativeDiagnosticsAvailable } from '@/utils/nativeModules/diagnostics'
import { temporaryDirectoryPath, writeFile } from '@/utils/fs'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'

/**
 * 完整诊断导出
 *
 * 与旧的「复制诊断信息」的本质区别（这就是本次修复的核心）：
 * 旧实现调用 runtimeLog.exportDiagnostics()，它只导出**当前进程的内存缓冲**。
 * 但故障发生在后台播放时，而用户的习惯是"杀掉应用重开再看日志"——
 * 于是故障那一次进程的记录全部消失，导出的日志里只剩下重启后的几行启动日志，
 * 完全无法排查（这正是用户提供的三份日志的真实情况）。
 *
 * 现在改为导出：
 * 1. 当前进程内存缓冲（含启动时回灌的"上一次会话尾部"，见 runtimeLog.analyzePreviousSession）；
 * 2. **落盘文件全文**（runtime.log + 轮转备份，跨多次启动）；
 * 3. **原生侧日志**（独立于 JS 线程，JS 死后仍然有记录）；
 * 4. 即时状态快照（原生播放器 state/position/duration/queue、心跳、看门狗、相关设置）。
 */

/** 单段日志最多导出多少字符，避免生成超大文本 */
const maxSectionChars = 120000
/** 原生日志段的独立上限 */
const maxNativeSectionChars = 60000

/**
 * 「复制诊断信息」用的预算：剪贴板同样有大小限制（且大文本会让系统卡顿），
 * 因此这条路径只导出精简版，完整内容请走「分享日志」（文件方式，不受限）。
 */
export const clipboardBudget = {
  maxSectionChars: 18000,
  maxNativeSectionChars: 12000,
  memoryLimit: 120,
}

/** 剪贴板文本上限（字符）。超过则截断并提示用户改用「分享日志」 */
export const maxClipboardChars = 60000

/** 按字符数裁剪文本（保留头部：诊断的结论与即时状态在最前面） */
export const clipText = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`
}

/** 按字符数裁剪并保留尾部（日志类文本的最新内容在末尾，查看弹窗用这个） */
export const tailClip = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text
  return `[truncated ${text.length - maxChars} chars from the beginning]\n${text.slice(text.length - maxChars)}`
}

const tailOf = (text: string, max = maxSectionChars): string => {
  if (!text) return ''
  return text.length <= max ? text : `[truncated ${text.length - max} chars from the beginning]\n${text.slice(text.length - max)}`
}

const field = (key: string): any => {
  try {
    return (settingState.setting as Record<string, any>)?.[key]
  } catch (err) {
    return undefined
  }
}

/** 采样原生播放器（带超时，避免导出卡住；导出只会在前台由用户触发） */
const samplePlayer = async(): Promise<Record<string, any>> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-track-player')
    const TrackPlayer = mod?.default
    if (!TrackPlayer) return { error: 'track-player unavailable' }
    const timeout = new Promise<never>((resolve, reject) => {
      timeoutHandle = setTimeout(() => { reject(new Error('sample timeout')) }, 3000)
    })
    const sample = Promise.all([
      TrackPlayer.getState(),
      TrackPlayer.getPosition(),
      TrackPlayer.getDuration(),
      TrackPlayer.getBufferedPosition(),
      TrackPlayer.getQueue(),
    ]).then(([state, position, duration, buffered, queue]: any[]) => ({
      // 注意：State 是具名导出，不在 default 上（用错会退化成 '3' 这种数字字符串）
      state: resolvePlayerStateName(mod, state),
      stateNum: typeof state == 'number' ? state : -1,
      position,
      duration,
      buffered,
      queueLen: Array.isArray(queue) ? queue.length : -1,
    }))
    return await Promise.race([sample, timeout])
  } catch (err: any) {
    return { error: err?.message ?? String(err) }
  } finally {
    if (timeoutHandle != null) clearTimeout(timeoutHandle)
  }
}

const playerStoreSnapshot = (): Record<string, any> => {
  try {
    const now = Date.now()
    return {
      isPlay: playerState.isPlay,
      statusText: playerState.statusText,
      playerTrackId: global.lx?.playerTrackId || '',
      gettingUrlId: global.lx?.gettingUrlId || '',
      gettingUrlIdAgeMs: global.lx?.gettingUrlId ? now - (global.lx.gettingUrlIdSince || now) : 0,
      isPlayedStop: global.lx?.isPlayedStop ?? false,
      playerStatus: { ...(global.lx?.playerStatus ?? {}) },
      musicId: playerState.musicInfo?.id ?? '',
      musicName: playerState.musicInfo?.name ?? '',
      playMusicInfoId: playerState.playMusicInfo?.musicInfo?.id ?? '',
      isTempPlay: playerState.playMusicInfo?.isTempPlay ?? false,
      listId: playerState.playMusicInfo?.listId ?? '',
      playIndex: playerState.playInfo?.playIndex ?? -1,
      nowPlayTime: Math.round(playerState.progress.nowPlayTime),
      maxPlayTime: Math.round(playerState.progress.maxPlayTime),
      playedListLen: playerState.playedList?.length ?? -1,
      tempPlayListLen: playerState.tempPlayList?.length ?? -1,
    }
  } catch (err: any) {
    return { error: err?.message ?? String(err) }
  }
}

const settingsSnapshot = (): Record<string, any> => ({
  'player.isEnableAudioOffload': field('player.isEnableAudioOffload'),
  'player.isHandleAudioFocus': field('player.isHandleAudioFocus'),
  'player.cacheSize': field('player.cacheSize'),
  'player.playbackRate': field('player.playbackRate'),
  'player.togglePlayMethod': field('player.togglePlayMethod'),
  'player.isSavePlayTime': field('player.isSavePlayTime'),
  'player.isShowBluetoothLyric': field('player.isShowBluetoothLyric'),
  'player.isShowNotificationImage': field('player.isShowNotificationImage'),
})

/**
 * 构造完整诊断文本。永远 resolve，任何一步失败都降级为占位文本。
 *
 * @param options 可覆盖各段上限（「复制诊断信息」用精简预算，见 clipboardBudget）
 */
export const buildFullDiagnostics = async(options?: {
  maxSectionChars?: number
  maxNativeSectionChars?: number
  memoryLimit?: number
}): Promise<string> => {
  const sectionLimit = options?.maxSectionChars ?? maxSectionChars
  const nativeLimit = options?.maxNativeSectionChars ?? maxNativeSectionChars
  const now = Date.now()
  const logOptions = getOptions()
  const sections: string[] = []

  sections.push([
    '===== lx diagnostics (full) =====',
    `export time: ${new Date(now).toISOString()}`,
    `session id: ${getSessionId()}`,
    `session uptime: ${now - getSessionStartTime()}ms`,
    `app version: ${(global as any).process?.versions?.app ?? 'unknown'}`,
    `platform: ${Platform.OS} ${String(Platform.Version)}`,
    `app state: ${AppState.currentState}`,
    `runtime log path: ${runtimeLogPath() || '[unavailable]'}`,
    `legacy log path: ${legacyLogPath() || '[unavailable]'}`,
    `log options: ${JSON.stringify(logOptions)}`,
    `native diagnostics module: ${isNativeDiagnosticsAvailable() ? 'available' : 'UNAVAILABLE'}`,
  ].join('\n'))

  // ---- 即时状态 ----
  let nativeStatus = ''
  let playerSample: Record<string, any> = {}
  try {
    nativeStatus = await getNativeDiagnosticsStatus()
  } catch (err) {}
  try {
    playerSample = await samplePlayer()
  } catch (err: any) {
    playerSample = { error: err?.message ?? String(err) }
  }
  sections.push([
    '===== live state =====',
    `player store: ${JSON.stringify(playerStoreSnapshot())}`,
    `native player: ${JSON.stringify(playerSample)}`,
    `settings: ${JSON.stringify(settingsSnapshot())}`,
    `native status: ${nativeStatus || '[unavailable]'}`,
  ].join('\n'))

  // ---- 看门狗 / 心跳 ----
  sections.push([
    '===== watchdog & heartbeat =====',
    `stallCount: ${getStallCount()}`,
    `lastStall: ${JSON.stringify(getLastStall())}`,
    getWatchdogSnapshot(),
    getHeartbeatSnapshot(),
  ].join('\n'))

  // ---- 当前进程内存缓冲（含启动时回灌的上一次会话尾部）----
  sections.push([
    '===== memory buffer (current process; includes previous-session tail injected at startup) =====',
    getSnapshot(options?.memoryLimit),
  ].join('\n'))

  // ---- 落盘文件：跨多次启动 ----
  let persisted = ''
  try {
    persisted = await readLogFile()
  } catch (err) {
    persisted = '[read runtime.log failed]'
  }
  sections.push([
    `===== persisted runtime.log (all sessions, tail ${sectionLimit} chars) =====`,
    tailOf(persisted.replace(/^\n+|\n+$/g, ''), sectionLimit),
  ].join('\n'))

  // ---- 原生侧日志 ----
  let nativeLog = ''
  try {
    nativeLog = await readNativeDiagnosticsLog()
  } catch (err) {
    nativeLog = '[read native log failed]'
  }
  sections.push([
    `===== native diagnostics log (independent of JS thread, tail ${nativeLimit} chars) =====`,
    tailOf(nativeLog.replace(/^\n+|\n+$/g, ''), nativeLimit) || '[empty or unavailable]',
  ].join('\n'))

  sections.push('===== end =====')
  return sections.join('\n\n')
}

/**
 * 把完整诊断写入 CacheDir 下的一个文本文件，返回路径与字符数。
 *
 * 为什么要落文件：分享超大文本走的是 Intent.EXTRA_TEXT（Binder 事务有上限），
 * 日志变大后 `startActivity` 会抛异常 —— 之前正是这样把界面打死的
 * （"Critical Error Occured !"）。改为文件后由 FileProvider 以 content:// 分享，
 * 不经过 Binder，因此没有大小限制，也便于用户直接作为附件提交。
 */
export const writeFullDiagnosticsToFile = async(options?: {
  maxSectionChars?: number
  maxNativeSectionChars?: number
  memoryLimit?: number
}): Promise<{ path: string, size: number, text: string }> => {
  const text = await buildFullDiagnostics(options)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = `${temporaryDirectoryPath}/lx-diagnostics-${stamp}.txt`
  await writeFile(path, text)
  return { path, size: text.length, text }
}

export const diagnostics = {
  buildFullDiagnostics,
  writeFullDiagnosticsToFile,
  clipboardBudget,
  maxClipboardChars,
  clipText,
  tailClip,
}

export default diagnostics
