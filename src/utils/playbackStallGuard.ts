import BackgroundTimer from 'react-native-background-timer'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { info, warn, error, flush } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'

/**
 * 原生播放器"进度卡死"看门狗（自动恢复）
 *
 * 为什么需要它 —— 2026-11-12 的诊断导出
 * （lx-diagnostics-2026-11-12T06-07-55-173Z.txt）给出现场：
 *
 * - 本地 FLAC《おかえり》(duration=330.47s) 播到 **277.42s** 后，原生播放器进入
 *   `BUFFERING → PLAYING → BUFFERING ...` 的死循环（约 0.58s 一轮，持续 60s 以上），
 *   每轮都伴随 `AUDIO playbackConfigChanged activeMedia=0/1`（AudioTrack 失活→重建）；
 * - 同一时间 `position` 一直停在 277.418，`buffered` 却有 296s —— 数据早就够了，是
 *   **音频输出没在消费**，不是网络/磁盘读取问题；
 * - 手动切走再切回（14:07:18/14:07:20 的 playPrev/playNext）后，播到同一个位置
 *   （277.4s）**再次卡死** —— 说明触发点和这首歌的音频数据/解码路径相关，不是偶发抖动；
 * - JS 侧完全健康（心跳、日志、getPosition 都正常），所以这是**原生播放器卡住**，
 *   而不是上一轮的 JS 线程死锁/OOM。
 *
 * 真正的用户痛点：这种情况**没有任何恢复机制**。
 * 原有三条超时都覆盖不到它：
 *   - `playerEvent.startLoadingTimeout()`（25s）只在 `playerLoadstart` 启动，卡死期间不会触发；
 *   - `addDelayNextTimeout()`（5s）只在 `playerError` 之后启动；
 *   - `playbackHeartbeat` 的 PLAYBACK_SILENT 只看日志、不做恢复，而且原来还要求
 *     `playerState.isPlay` 为真（缓冲事件会把它改成 false，于是检测被反复重置）。
 * 结果就是进度条永远停在 04:37，只能手动切歌。
 *
 * 本模块的做法（只用 BackgroundTimer 原生定时器，后台/息屏也会触发）：
 *   周期采样 `getState()` + `getPosition()`；只要 UI 认为在播放、原生状态是
 *   Playing/Buffering，而 position 超过 `stallThresholdMs` 没有前进，就判为卡死，然后
 *     1) 先 `app_event.setProgress(pos + 5s)`：一次 seek 会让 ExoPlayer flush 并重建
 *        AudioTrack，多数"解码/音频轨卡在某一帧"的情况可以在这一步恢复，且不切歌；
 *     2) 仍然不前进就 `playNext(true)` 跳过这一首（并写日志），避免用户对着"缓冲中"干等。
 *
 * 阈值与策略都是"足够宽松"的：正常播放/正常缓冲（本地文件通常 <1s）不会触发；
 * 恢复动作后有 12s 宽限期，不会连续抖动；连续跳歌超过 3 首会自动退化成"只 seek 不跳歌"，
 * 避免音频输出整体坏掉时把整个歌单跳完。
 */

/** 采样间隔（原生定时器，RN 的 JS 定时器在后台会被暂停） */
const sampleIntervalMs = 2000
/** position 多久不前进就判定为卡死（毫秒） */
export const stallThresholdMs = 10000
/** "同一位置"的判定容差（秒）：够大以忽略小数抖动，够小以识别真实前进 */
const positionEpsilon = 0.05
/** 卡死后 seek 跳过多少秒：用来跳开出问题的那一帧/那一段 */
const seekSkipSec = 5
/** 恢复动作后的宽限期（毫秒），期间不重复判定，给播放器重新起播的时间 */
const recoveryGraceMs = 12000
/** 连续跳歌上限：超过后只做 seek 重试，不再跳歌 */
const maxConsecutiveSkips = 3

let timerId: number | null = null
let isRunning = false
/** 实际使用的采样间隔（允许调用方覆盖） */
let currentIntervalMs = sampleIntervalMs

/** 上一次采样的 position（秒）；null 表示"需要重新取基线"（启动/seek 恢复后） */
let lastPosition: number | null = null
/** 上一次观测到 position 前进的时间 */
let lastProgressAt = 0
/** 当前曲目标识（切歌后需要重置全部计数） */
let lastTrackKey = ''
/** 本轮卡死已经做到第几步：0=未恢复，1=已 seek，2=已跳下一首 */
let recoveryAttempt = 0
/** 上一次恢复动作的时间 */
let lastRecoveryAt = 0
let lastRecoveryKind = ''
/** 累计判定次数（诊断用） */
let stallDetections = 0
/** 最近一次卡死时的 position，用于诊断导出 */
let lastStallPosition = -1
/** 连续跳歌次数（真实前进后清零） */
let consecutiveSkips = 0
/**
 * 恢复 seek 的目标位置。
 *
 * 为什么需要它：seek 之后 position 会跳变一次，如果把这跳动当成"播放已恢复"，
 * 就会把 recoveryAttempt 清零 —— 而音频其实还卡着，于是永远走不到"跳下一首"这一步，
 * 变成每 20 秒 seek 一次的死循环。所以只有**位置继续越过 seek 目标**才算真的恢复。
 */
let pendingSeekTarget: number | null = null

const round2 = (num: number) => Math.round(num * 100) / 100

/**
 * 惰性取模块：避免在模块求值期把 TrackPlayer / core 播放器拉进启动路径。
 * 必须用**字符串字面量** require（Metro 无法解析变量形式的 require）。
 */
const getTrackPlayerModule = (): any => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('react-native-track-player') ?? null
  } catch (err) {
    return null
  }
}

const getIsTempId = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@/plugins/player/utils')
    return Boolean(mod?.isTempId?.())
  } catch (err) {
    // 模块不可用时不阻塞判定，退回与 plugins/player/utils 相同的正则
    return /\/\/default$|\/\/default\/\/restorePlay$/.test(global.lx?.playerTrackId ?? '')
  }
}

const getCorePlayer = (): any => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@/core/player/player') ?? null
  } catch (err) {
    return null
  }
}

const resetState = () => {
  lastPosition = null
  lastProgressAt = 0
  recoveryAttempt = 0
  lastRecoveryKind = ''
  pendingSeekTarget = null
}

/**
 * 卡死恢复。
 *
 * 注意：这里不直接调 TrackPlayer，而是走既有通道
 * （`app_event.setProgress` → `playProgress.setProgress` → `setCurrentTime`，
 * `core/player/player.ts` 的 `playNext`），保持"播放器动作统一从 core 暴露"的约定。
 */
const handleStall = (position: number, frozenMs: number, stateName: string, now: number) => {
  const musicInfo = playerState.playMusicInfo.musicInfo
  const musicId = musicInfo?.id ?? ''
  stallDetections++
  lastStallPosition = position

  error('PLAYBACK_STALL', 'native player position stopped advancing while playing', {
    id: musicId,
    position: round2(position),
    frozenMs,
    state: stateName,
    attempt: recoveryAttempt + 1,
    stallDetections,
    consecutiveSkips,
    // 卡死点高度依赖原生音频路径；把与它相关的设置一并记下，方便判断是否与音频卸载有关
    audioOffload: settingState.setting['player.isEnableAudioOffload'],
    maxPlayTime: Math.round(playerState.progress.maxPlayTime),
    nowPlayTime: Math.round(playerState.progress.nowPlayTime),
    isPlay: playerState.isPlay,
    trackId: global.lx?.playerTrackId ?? '',
  })
  markEvent('playback.stall', {
    position: round2(position),
    frozenMs,
    state: stateName,
    attempt: recoveryAttempt + 1,
  })
  void flush()

  if (recoveryAttempt === 0) {
    // 第一步：seek 跳过一小段，让 ExoPlayer flush 并重建 AudioTrack。
    // 这一步不切歌，正常情况下用户只损失几秒；卡死的解码/音频轨多半能就此恢复。
    const maxPlayTime = playerState.progress.maxPlayTime
    const upperBound = maxPlayTime > 0 ? Math.max(maxPlayTime - 2, position + 1) : position + seekSkipSec
    const target = round2(Math.min(position + seekSkipSec, upperBound))

    lastRecoveryKind = 'seek'
    lastRecoveryAt = now
    lastProgressAt = now
    // seek 之后位置会跳变：要让下一次采样重新取基线，且**不能**把这跳动当成"恢复成功"
    lastPosition = null
    pendingSeekTarget = target
    recoveryAttempt = 1
    info('PLAYBACK_STALL', 'recovery: seek forward to skip the stalled frame', {
      id: musicId,
      from: round2(position),
      to: target,
      state: stateName,
    })
    markEvent('playback.stall.recover.seek', { from: round2(position), to: target })
    global.app_event.setProgress(target)
    return
  }

  if (consecutiveSkips >= maxConsecutiveSkips) {
    // 连续跳了好几首还是卡：更可能是设备音频输出整体坏了，继续跳只会把歌单跳完。
    // 退化成"只做 seek 重试"，把判断权交回用户。
    warn('PLAYBACK_STALL', 'too many consecutive skips, stop skipping tracks', {
      id: musicId,
      position: round2(position),
      consecutiveSkips,
      stallDetections,
    })
    markEvent('playback.stall.skipSuppressed', { consecutiveSkips })
    recoveryAttempt = 0
    lastProgressAt = now
    lastRecoveryAt = now
    lastPosition = null
    pendingSeekTarget = null
    return
  }

  // 第二步：seek 过一次仍然不前进 —— 这一首已经没救了，跳下一首，别让用户干等。
  lastRecoveryKind = 'playNext'
  lastRecoveryAt = now
  lastProgressAt = now
  recoveryAttempt = 2
  consecutiveSkips++
  warn('PLAYBACK_STALL', 'recovery: still stalled after seek, skip to next track', {
    id: musicId,
    position: round2(position),
    frozenMs,
    consecutiveSkips,
    stallDetections,
  })
  markEvent('playback.stall.recover.playNext', {
    position: round2(position),
    frozenMs,
    consecutiveSkips,
  })
  const corePlayer = getCorePlayer()
  if (corePlayer?.playNext) {
    void corePlayer.playNext(true)
  } else {
    error('PLAYBACK_STALL', 'recovery failed: core player module unavailable')
  }
}

const tick = async() => {
  try {
    const musicInfo = playerState.playMusicInfo.musicInfo
    // 只有在"UI 认为在播放 + 不是临时轨/取链接中/已停止"时才判定
    if (
      !musicInfo ||
      !playerState.isPlay ||
      global.lx?.isPlayedStop ||
      global.lx?.gettingUrlId ||
      getIsTempId()
    ) {
      resetState()
      return
    }

    const trackKey = `${musicInfo.id}__${playerState.playInfo.playIndex}`
    if (trackKey != lastTrackKey) {
      lastTrackKey = trackKey
      lastPosition = null
      lastProgressAt = Date.now()
      recoveryAttempt = 0
      lastRecoveryKind = ''
      pendingSeekTarget = null
    }

    const mod = getTrackPlayerModule()
    const TrackPlayer = mod?.default
    const State = mod?.State
    if (!TrackPlayer || !State) return

    const [state, position] = await Promise.all([
      TrackPlayer.getState(),
      TrackPlayer.getPosition(),
    ])

    if (typeof position != 'number' || position < 0) return

    const stateName = String(State[state] ?? state)
    const isPlayingState = state == State.Playing || state == State.Buffering
    const now = Date.now()

    // 非"在播/缓冲"状态（暂停、停止、结束、连接中）不判定，只同步基线
    if (!isPlayingState) {
      lastPosition = position
      lastProgressAt = now
      return
    }

    const isFirstSample = lastPosition == null
    const advanced = lastPosition != null && Math.abs(position - lastPosition) >= positionEpsilon
    if (isFirstSample || advanced) {
      if (advanced) {
        // 这次跳变是不是我们自己 seek 造成的？（seek 目标附近的一次跳动不算恢复）
        if (pendingSeekTarget != null) {
          const isSeekJump = Math.abs(position - pendingSeekTarget) <= 1.5
          pendingSeekTarget = null
          if (isSeekJump) {
            lastPosition = position
            lastProgressAt = now
            return
          }
        }
        consecutiveSkips = 0
        // seek 之后位置真的继续前进了，才算恢复成功
        if (recoveryAttempt > 0) {
          info('PLAYBACK_STALL', 'playback recovered', {
            id: musicInfo.id,
            kind: lastRecoveryKind,
            position: round2(position),
            frozenMs: lastProgressAt ? now - lastProgressAt : 0,
            stallDetections,
          })
          markEvent('playback.stall.recovered', { kind: lastRecoveryKind, position: round2(position) })
          void flush()
          recoveryAttempt = 0
          lastRecoveryKind = ''
        }
      }
      lastPosition = position
      lastProgressAt = now
      return
    }

    // 刚做过恢复动作，先给播放器 12s 重新起播的时间
    if (lastRecoveryAt && now - lastRecoveryAt < recoveryGraceMs) return

    const frozenMs = now - lastProgressAt
    if (frozenMs < stallThresholdMs) return

    handleStall(position, frozenMs, stateName, now)
  } catch (err: any) {
    try {
      console.log('[playbackStallGuard] tick failed', err)
    } catch (err2) {}
  }
}

/** 启动看门狗（可重复调用；已启动时只更新间隔） */
export const startPlaybackStallGuard = (options?: { intervalMs?: number }): void => {
  try {
    if (isRunning) {
      info('PLAYBACK_STALL', 'guard already started', { intervalMs: currentIntervalMs })
      return
    }
    if (options?.intervalMs && options.intervalMs > 0) {
      currentIntervalMs = options.intervalMs
    }
    timerId = BackgroundTimer.setInterval(tick, currentIntervalMs)
    isRunning = true
    info('PLAYBACK_STALL', 'guard started', {
      intervalMs: currentIntervalMs,
      stallThresholdMs,
      seekSkipSec,
      recoveryGraceMs,
      maxConsecutiveSkips,
      note: 'native timer: keeps sampling in background',
    })
  } catch (err: any) {
    console.log('[playbackStallGuard] start failed', err)
  }
}

export const stopPlaybackStallGuard = (): void => {
  try {
    if (!isRunning || timerId == null) return
    BackgroundTimer.clearInterval(timerId)
    timerId = null
    isRunning = false
    resetState()
    info('PLAYBACK_STALL', 'guard stopped')
  } catch (err) {}
}

/** 供诊断导出使用 */
export const getPlaybackStallGuardSnapshot = (): string => {
  try {
    const now = Date.now()
    return [
      `running: ${isRunning}`,
      `sampleIntervalMs: ${currentIntervalMs}`,
      `stallThresholdMs: ${stallThresholdMs}`,
      `position: ${lastPosition == null ? 'none' : round2(lastPosition)}`,
      `positionAgeMs: ${lastProgressAt ? now - lastProgressAt : -1}`,
      `recoveryAttempt: ${recoveryAttempt}`,
      `lastRecoveryKind: ${lastRecoveryKind || 'none'}`,
      `lastRecoveryAgoMs: ${lastRecoveryAt ? now - lastRecoveryAt : -1}`,
      `consecutiveSkips: ${consecutiveSkips}`,
      `stallDetections: ${stallDetections}`,
      `lastStallPosition: ${lastStallPosition < 0 ? 'none' : round2(lastStallPosition)}`,
    ].join('\n')
  } catch (err) {
    return 'unavailable'
  }
}

export const playbackStallGuard = {
  start: startPlaybackStallGuard,
  stop: stopPlaybackStallGuard,
  getSnapshot: getPlaybackStallGuardSnapshot,
}

export default playbackStallGuard
