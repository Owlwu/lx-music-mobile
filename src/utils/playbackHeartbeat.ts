import BackgroundTimer from 'react-native-background-timer'
import { AppState } from 'react-native'
import playerState from '@/store/player/state'
import { info, warn, error, flush } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'

/**
 * 后台播放心跳 + "没声音但状态仍在播放"检测器
 *
 * 为什么需要它（背景）：
 * 用户反馈的问题发生在**应用处于后台**播放时：突然没有声音、界面/进度条不再更新、
 * 切歌无效，回到前台后界面空白。这类问题最需要日志，但恰恰是最没有日志的场景：
 *
 * 1. RN 在 App 退到后台时会暂停**全部 JS 定时器**
 *    （ReactAndroid JavaTimerManager.onHostPause() → isPaused=true）。
 *    因此普通 setInterval / setTimeout 在后台一次都不会触发 —— 后台期间没有任何时间线。
 * 2. 本模块改用 react-native-background-timer：它是原生 Handler + 事件回调
 *    （node_modules/react-native-background-timer/android/.../BackgroundTimerModule.java:71-80），
 *    在后台仍然会触发，因此可以持续记录"后台到底发生了什么"。
 * 3. 每跳一次都主动 flush()：因为 flush 的定时器本身在后台不可靠，
 *    只有显式调用才能把证据写进文件（进程随时可能被系统杀掉）。
 *
 * 它提供三类关键证据：
 * - 时间线：后台期间的状态 + 原生播放器状态/进度/队列长度（原来后台是空白）。
 * - 卡死证据：两次心跳之间如果隔了远超间隔的时间，说明 JS 线程被阻塞或整个进程被冻结
 *   （原生定时器照常到期，事件却被排在 JS 线程后面 —— 这正是"假死"的直接证据）。
 * - 静默播放证据：状态 = Playing 但 position 长时间不前进 → 记录 PLAYBACK_SILENT。
 */

/** 心跳间隔（毫秒）。原生定时器开销极低，30s 一跳足够把时间线钉住。 */
const defaultInterval = 30000

/** 判定"进度不动"的阈值（毫秒） */
const silentThreshold = 20000
/** 重复上报"进度不动"的最小间隔（毫秒），避免刷屏 */
const silentLogInterval = 60000
/** 判定"UI 认为在播放但原生播放器不在播放"的阈值（毫秒） */
const mismatchThreshold = 30000

let timerId: number | null = null
let intervalMs = defaultInterval
let seq = 0
let startedAt = 0
let lastTickAt = 0

/** 最近一次采样到的原生播放器位置（用于判断位置是否前进） */
let lastPosition: number | null = null
let lastPositionAt = 0
let silentSince = 0
let lastSilentLogAt = 0
let mismatchSince = 0
let lastMismatchLogAt = 0
let lastSampleOkAt = 0
let pendingSampleCount = 0

interface HeartbeatBase {
  seq: number
  elapsedMs: number
  appState: string
  isPlay: boolean
  trackId: string
  gettingUrlIdAgeMs: number
  nowPlayTime: number
  maxPlayTime: number
}

/**
 * 惰性取模块：避免把播放器/初始化链路提前拉进启动路径，也避免循环依赖。
 *
 * ⚠️ 必须用**字符串字面量** require：Metro 无法解析变量形式的 require，
 * 会在打包时报 `Invalid call at line ...: require(path)` 并导致
 * `:app:createBundleReleaseJsAndAssets` 失败（release 打包直接失败）。
 * 字面量 require 依然是"调用时才求值"，因此惰性效果不变。
 */
const getProgressModule = (): any => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@/core/init/player/playProgress')
  } catch (err) {
    return null
  }
}

const getTrackPlayer = (): any => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('react-native-track-player')?.default ?? null
  } catch (err) {
    return null
  }
}

/**
 * 收集与"进度条是否还在走"直接相关的附加状态。
 * 全部惰性求值并吞掉异常：心跳绝不能因为某个模块不可用而中断。
 */
const collectProgressState = (): Record<string, any> => {
  const extra: Record<string, any> = {}
  try {
    const mod = getProgressModule()
    if (mod?.getProgressPollState) {
      const poll = mod.getProgressPollState()
      extra.pollArmSeq = poll.armSeq
      extra.pollTickSeq = poll.tickSeq
      extra.pollTickAgoMs = poll.lastTickAgoMs
      extra.progressScreenOn = poll.isScreenOn
      extra.pollArmed = poll.hasTimeout
    }
  } catch (err) {}
  return extra
}

const collectBase = (elapsedMs: number): HeartbeatBase => {
  const now = Date.now()
  const gettingUrlId = global.lx?.gettingUrlId
  const gettingUrlIdSince = (global.lx as any)?.gettingUrlIdSince as number | undefined
  return {
    seq,
    elapsedMs,
    appState: AppState.currentState,
    isPlay: playerState.isPlay,
    trackId: global.lx?.playerTrackId || '',
    gettingUrlIdAgeMs: gettingUrlId ? now - (gettingUrlIdSince ?? now) : 0,
    nowPlayTime: Math.round(playerState.progress.nowPlayTime),
    maxPlayTime: Math.round(playerState.progress.maxPlayTime),
  }
}

/**
 * 采样原生播放器。
 *
 * 关键设计：这一跳先同步写日志，再去 await 原生调用。
 * 因此"有 tick 但没有 player sample"本身就是证据 —— 说明原生调用永不返回
 * （播放器卡死），而这正是"进度条不动、切歌无效"的一个真实机制。
 */
const samplePlayer = async(base: HeartbeatBase, now: number) => {
  pendingSampleCount++
  const startedSampleAt = Date.now()
  let stateName = 'unavailable'
  let position = -1
  let duration = -1
  let buffered = -1
  let queueLen = -1
  try {
    const TrackPlayer = getTrackPlayer()
    if (!TrackPlayer) throw new Error('track-player module unavailable')
    const [state, pos, dur, buf, queue] = await Promise.all([
      TrackPlayer.getState(),
      TrackPlayer.getPosition(),
      TrackPlayer.getDuration(),
      TrackPlayer.getBufferedPosition(),
      TrackPlayer.getQueue(),
    ])
    stateName = typeof state == 'number' ? (TrackPlayer.State?.[state] ?? String(state)) : String(state)
    position = typeof pos == 'number' ? pos : -1
    duration = typeof dur == 'number' ? dur : -1
    buffered = typeof buf == 'number' ? buf : -1
    queueLen = Array.isArray(queue) ? queue.length : -1
  } catch (err: any) {
    pendingSampleCount--
    error('HEARTBEAT', 'player sample failed', {
      ...base,
      sampleCostMs: Date.now() - startedSampleAt,
      message: err?.message ?? String(err),
    })
    return
  }
  pendingSampleCount--
  lastSampleOkAt = Date.now()

  info('HEARTBEAT', 'player sample', {
    ...base,
    sampleCostMs: Date.now() - startedSampleAt,
    state: stateName,
    position: Math.round(position * 100) / 100,
    duration: Math.round(duration * 100) / 100,
    buffered: Math.round(buffered * 100) / 100,
    queueLen,
    silentForMs: silentSince ? now - silentSince : 0,
    ...collectProgressState(),
  })

  detectAbnormal(base, stateName, position, now)
}

/** 检测两类"用户可感知的假死"：进度不动、UI 状态与原生状态矛盾 */
const detectAbnormal = (base: HeartbeatBase, stateName: string, position: number, now: number) => {
  const isPlayingState = stateName == 'Playing' || stateName == 'Buffering'

  if (base.isPlay && isPlayingState && position >= 0) {
    if (lastPosition != null && Math.abs(position - lastPosition) < 0.25) {
      if (!silentSince) silentSince = lastPositionAt || now
      const silentFor = now - silentSince
      if (silentFor >= silentThreshold && now - lastSilentLogAt >= silentLogInterval) {
        lastSilentLogAt = now
        // 这是与用户描述完全对应的信号："显示正在播放，但没有声音、进度也不动"
        error('PLAYBACK_SILENT', 'player reports playing but position is not advancing', {
          ...base,
          state: stateName,
          position: Math.round(position * 100) / 100,
          silentForMs: silentFor,
          lastPositionAt: lastPositionAt ? new Date(lastPositionAt).toISOString() : '',
        })
        markEvent('playback.silent', { state: stateName, silentForMs: silentFor })
        void flush()
      }
    } else {
      silentSince = 0
    }
    lastPosition = position
    lastPositionAt = now
  } else {
    silentSince = 0
    if (position >= 0) {
      lastPosition = position
      lastPositionAt = now
    }
  }

  // UI 认为在播放，但原生播放器并不在播放：常见于"状态事件被 guard 丢弃/丢失"
  if (base.isPlay && !isPlayingState && stateName != 'unavailable') {
    if (!mismatchSince) mismatchSince = now
    const mismatchFor = now - mismatchSince
    if (mismatchFor >= mismatchThreshold && now - lastMismatchLogAt >= silentLogInterval) {
      lastMismatchLogAt = now
      warn('PLAYBACK_MISMATCH', 'app thinks it is playing but native player state differs', {
        ...base,
        state: stateName,
        mismatchForMs: mismatchFor,
        ...collectProgressState(),
      })
      markEvent('playback.mismatch', { state: stateName, mismatchForMs: mismatchFor })
      void flush()
    }
  } else {
    mismatchSince = 0
  }
}

const tick = () => {
  try {
    const now = Date.now()
    seq++
    const elapsed = lastTickAt ? now - lastTickAt : 0
    lastTickAt = now
    const base = collectBase(elapsed)

    // JS 线程被阻塞 / 进程被冻结的直接证据：
    // 原生定时器照常到期，但回调只能等 JS 线程空闲后才执行，于是出现远超间隔的 gap。
    // 注意：RN 自带的 stallWatchdog 用的是普通 setInterval，后台完全不走，
    // 既检测不到这个 gap，还会在回到前台时报出"整段后台时长"的假 STALL。
    if (elapsed > intervalMs * 2.5 && base.elapsedMs > 0) {
      warn('HEARTBEAT', 'heartbeat gap: JS thread was blocked or the process was frozen', {
        ...base,
        expectedMs: intervalMs,
      })
      markEvent('heartbeat.gap', { elapsedMs: elapsed, appState: base.appState })
    }

    // 空闲时降频记录（每 4 跳一次），播放中每跳都记，兼顾时间线与日志体积
    if (base.isPlay || seq % 4 == 1) {
      info('HEARTBEAT', 'tick', {
        ...base,
        intervalMs,
        samplePending: pendingSampleCount,
        lastSampleAgoMs: lastSampleOkAt ? now - lastSampleOkAt : -1,
        ...collectProgressState(),
      })
    }

    // 采样频率：播放中每跳都采；空闲时降频（每 4 跳一次，约 2 分钟），
    // 既保留状态迁移证据，又不让长时间挂后台的应用持续产生日志。
    if (base.isPlay || seq % 4 == 1) void samplePlayer(base, now)

    // 显式落盘：后台期间 flush 定时器不可靠，只有这里能保证证据进文件
    void flush()
  } catch (err) {
    try {
      console.log('[playbackHeartbeat] tick failed', err)
    } catch (err2) {}
  }
}

/** 启动心跳（可重复调用，已启动时只更新间隔） */
export const startPlaybackHeartbeat = (options?: { intervalMs?: number }): void => {
  try {
    if (options?.intervalMs && options.intervalMs > 0) intervalMs = options.intervalMs
    if (timerId != null) {
      info('HEARTBEAT', 'already started, interval updated', { intervalMs })
      return
    }
    startedAt = Date.now()
    lastTickAt = startedAt
    timerId = BackgroundTimer.setInterval(tick, intervalMs)
    info('HEARTBEAT', 'started', {
      intervalMs,
      silentThresholdMs: silentThreshold,
      appState: AppState.currentState,
      note: 'native timer: keeps ticking in background (RN JS timers are suspended)',
    })
  } catch (err) {
    try {
      console.log('[playbackHeartbeat] start failed', err)
    } catch (err2) {}
  }
}

/** 停止心跳 */
export const stopPlaybackHeartbeat = (): void => {
  try {
    if (timerId == null) return
    BackgroundTimer.clearInterval(timerId)
    timerId = null
    info('HEARTBEAT', 'stopped', { seq })
  } catch (err) {}
}

/** 心跳状态快照（供诊断导出） */
export const getHeartbeatSnapshot = (): string => {
  try {
    const now = Date.now()
    return [
      '[HEARTBEAT]',
      `running: ${timerId != null}`,
      `intervalMs: ${intervalMs}`,
      `seq: ${seq}`,
      `startedAt: ${startedAt ? new Date(startedAt).toISOString() : 'never'}`,
      `lastTickAgoMs: ${lastTickAt ? now - lastTickAt : -1}`,
      `lastSampleAgoMs: ${lastSampleOkAt ? now - lastSampleOkAt : -1}`,
      `pendingSamples: ${pendingSampleCount}`,
      `silentForMs: ${silentSince ? now - silentSince : 0}`,
      `appState: ${AppState.currentState}`,
      `isPlay: ${playerState.isPlay}`,
      `trackId: ${global.lx?.playerTrackId || ''}`,
      `gettingUrlIdAgeMs: ${collectBase(0).gettingUrlIdAgeMs}`,
      `progress: ${JSON.stringify(collectProgressState())}`,
    ].join('\n')
  } catch (err) {
    return '[HEARTBEAT]\nunavailable'
  }
}

export const playbackHeartbeat = {
  start: startPlaybackHeartbeat,
  stop: stopPlaybackHeartbeat,
  getSnapshot: getHeartbeatSnapshot,
}

export default playbackHeartbeat
