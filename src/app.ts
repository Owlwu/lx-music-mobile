import '@/utils/errorHandle'
import { init as initLog } from '@/utils/log'
import { bootLog, getBootLog } from '@/utils/bootLog'
import '@/config/globalData'
import { getFontSize } from '@/utils/data'
import { exitApp } from './utils/nativeModules/utils'
import { windowSizeTools } from './utils/windowSizeTools'
import { listenLaunchEvent } from './navigation/regLaunchedEvent'
import { tipDialog } from './utils/tools'
import { AppState } from 'react-native'
import {
  init as initRuntimeLog,
  info,
  warn,
  error as logError,
  flush,
  getSnapshot,
  startMemorySampling,
  isMemorySamplingSupported,
} from '@/utils/runtimeLog'
import { start as startWatchdog, markEvent, getWatchdogSnapshot, noteAppState } from '@/utils/stallWatchdog'
import { startPlaybackHeartbeat, getHeartbeatSnapshot } from '@/utils/playbackHeartbeat'
import { startNativeJsAckLoop, logToNativeTimeline } from '@/utils/nativeModules/diagnostics'

/**
 * 启动链路埋点说明（排查"应用打开后空白"）
 *
 * 现象：pushHomeScreen() 之前会 await handleInit()，而 handleInit 内部是
 * 一连串 await（动态 import + core/init 的 8 步串行初始化）。其中任何一步
 * 永不 resolve，首页就永远不会被 push，用户看到的就是全屏空白。
 * 原实现这条路径上**没有任何可落盘的日志**：bootLog 只在内存中、且只在
 * 启动失败弹窗里展示；而 tipDialog(Alert) 在 RootView 尚未 attach 时可能
 * 根本不显示 —— 于是"空白且无日志"。
 *
 * 本文件因此只做四件事（不改变任何业务分支与 UI 行为）：
 * 1. 尽早 init runtimeLog（早于原有的 void initLog()），并启动 JS 线程看门狗；
 * 2. 给启动链路每个阶段写带耗时的 [BOOT] 日志 + markEvent；
 * 3. 给 handleInit 加 30s 超时看门狗，超时只写诊断日志，不做任何 UI 动作；
 * 4. 启动 30s 周期的内存水位采样，为"长时间播放的内存压力"假设提供日志证据。
 */

const appStartTime = Date.now()
const bootCost = () => Date.now() - appStartTime

// 尽可能早地初始化运行时日志：init 之前的日志会先进入内存环形缓冲，
// init 后自动回灌落盘，因此放在模块加载期调用也不会丢日志。
void initRuntimeLog()

console.log('starting app...')
info('BOOT', 'app module loaded', { costMs: bootCost() })
markEvent('boot:appModuleLoaded', { costMs: bootCost() })

listenLaunchEvent()
info('BOOT', 'listenLaunchEvent registered', { costMs: bootCost() })

// JS 线程心跳看门狗：定时器回调本身即可反映事件循环是否被阻塞，
// 一旦阻塞超过阈值就会写入 [STALL] 日志（附最后关键事件）
startWatchdog({ interval: 5000, stallThreshold: 20000 })

// 后台播放心跳：使用**原生定时器**（react-native-background-timer）。
// 必须这样做的原因：RN 退到后台会暂停全部 JS 定时器，普通 setInterval/setTimeout
// 在后台一次都不触发 —— 而"后台播放时突然无声/假死"恰恰只发生在后台。
// 该心跳同时负责：后台时间线、JS 线程被卡住/进程被冻结的证据（心跳 gap）、
// 以及"状态是 Playing 但进度不前进"的 PLAYBACK_SILENT 检测。
startPlaybackHeartbeat({ intervalMs: 30000 })

// 原生侧存活应答：原生诊断模块据此判断"JS 是否已经无法响应"，
// 即使用户回到前台发现界面空白，也能从原生日志里读到 JS 何时停止应答。
startNativeJsAckLoop(10000)

// 内存水位周期采样：为"长时间听歌后内存压力"这一根因假设提供日志证据。
// 必须持有停止函数，否则 setInterval 会永久运行，反而在长时间播放场景制造资源泄漏。
// 注意：正式版 RN 通常无 performance.memory，此时 recordMemory() 降级为 no-op
// 并只写一次 warn（runtimeLog.ts:691），那条 warn 本身就是有用的诊断信息。
// 按约束**不调用**停止函数，也不加 AppState 启停逻辑：进程内持续采样。
// 保留句柄供将来需要时停止采样，故对 no-unused-vars 显式豁免并说明原因。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const stopMemorySampling = startMemorySampling(30000)
info('BOOT', 'memory sampling started', {
  supported: isMemorySamplingSupported(),
  intervalMs: 30000,
  costMs: bootCost(),
})

void Promise.all([getFontSize(), windowSizeTools.init()]).then(async([fontSize]) => {
  global.lx.fontSize = fontSize
  bootLog('Font size setting loaded.')
  info('BOOT', 'font size & window size tools ready', { fontSize, costMs: bootCost() })
  markEvent('boot:fontSizeReady', { costMs: bootCost() })

  let isInited = false
  let handlePushedHomeScreen: () => void | Promise<void>

  const tryGetBootLog = () => {
    try {
      return getBootLog()
    } catch (err) {
      return 'Get boot log failed.'
    }
  }

  const handleInit = async() => {
    if (isInited) {
      info('BOOT', 'handleInit skipped (already inited)')
      return
    }
    const initStart = Date.now()
    info('BOOT', 'handleInit start', { costMs: bootCost() })
    markEvent('boot:handleInitStart', { costMs: bootCost() })
    void initLog()
    info('BOOT', "importing '@/core/init'...")
    const { default: init } = await import('@/core/init')
    info('BOOT', "imported '@/core/init'", { costMs: Date.now() - initStart })
    try {
      markEvent('boot:coreInitStart')
      handlePushedHomeScreen = await init()
      info('BOOT', 'handleInit done', { costMs: Date.now() - initStart, totalCostMs: bootCost() })
      markEvent('boot:handleInitDone', { costMs: Date.now() - initStart })
    } catch (err: any) {
      // 启动失败路径：原实现只弹 tipDialog（RootView 未 attach 时可能根本不显示，
      // 用户只会看到空白），因此这里必须先把现场落盘再走原有流程
      logError('BOOT', 'handleInit failed', {
        costMs: Date.now() - initStart,
        error: (err.stack ?? err.message) as string,
        bootLog: tryGetBootLog(),
      })
      markEvent('boot:handleInitFailed', { costMs: Date.now() - initStart })
      await flush()
      void tipDialog({
        title: '初始化失败 (Init Failed)',
        message: `Boot Log:\n${tryGetBootLog()}\n\n${(err.stack ?? err.message) as string}`,
        btnText: 'Exit',
        bgClose: false,
      }).then(() => {
        exitApp()
      })
      return
    }
    isInited ||= true
  }

  // 启动超时看门狗：handleInit 卡住时只记录诊断日志，
  // 不改变任何 UI 行为（原实现是无限期等待，行为保持不变）
  let isTimeoutReported = false
  const bootTimeoutTimer = setTimeout(async() => {
    if (isInited || isTimeoutReported) return
    isTimeoutReported = true
    const bootLogText = tryGetBootLog()
    logError('BOOT', 'handleInit did not finish in 30000ms, home screen is likely blank', {
      elapsedMs: bootCost(),
      isInited,
    })
    markEvent('boot:initTimeout', { elapsedMs: bootCost() })
    // 超时场景下用户很可能无法进入设置页，因此把完整现场写入 runtime.log
    info('BOOT', 'boot timeout diagnostics', {
      bootLog: bootLogText,
      watchdog: getWatchdogSnapshot(),
      heartbeat: getHeartbeatSnapshot(),
      snapshot: getSnapshot(200, 'info'),
    })
    // 最终快照：必须 await flush()，否则进程若被杀这些日志会丢在半路。
    // 这是"启动卡死现场"唯一的落盘机会，不能降级为 void flush()。
    await flush()
  }, 30000)

  const clearBootTimeout = () => {
    clearTimeout(bootTimeoutTimer)
  }

  info('BOOT', "importing '@/navigation'...")
  const { init: initNavigation, navigations } = await import('@/navigation')
  info('BOOT', "imported '@/navigation'", { costMs: bootCost() })

  initNavigation(async() => {
    info('BOOT', 'navigation callback fired', { costMs: bootCost() })
    await handleInit()
    if (!isInited) {
      warn('BOOT', 'handleInit returned without inited, home screen will not be pushed', { costMs: bootCost() })
      return
    }

    // import('@/utils/nativeModules/cryptoTest')

    info('BOOT', 'push home screen...', { costMs: bootCost() })
    markEvent('boot:pushHomeScreen', { costMs: bootCost() })
    await navigations.pushHomeScreen().then(() => {
      clearBootTimeout()
      info('BOOT', 'home screen pushed', { costMs: bootCost() })
      markEvent('boot:homeScreenPushed', { costMs: bootCost() })
      void handlePushedHomeScreen()
    }).catch((err: any) => {
      logError('BOOT', 'push home screen failed', {
        costMs: bootCost(),
        error: (err.stack ?? err.message) as string,
      })
      void flush()
      void tipDialog({
        title: 'Error',
        message: err.message,
        btnText: 'Exit',
        bgClose: false,
      }).then(() => {
        exitApp()
      })
    })
  })
}).catch((err) => {
  // 启动前置步骤（fontSize / windowSizeTools）失败：原实现只弹 tipDialog，
  // 这里同样先落盘再走原有流程
  logError('BOOT', 'boot prerequisites failed', {
    costMs: bootCost(),
    error: (err.stack ?? err.message) as string,
  })
  void flush()
  void tipDialog({
    title: '初始化失败 (Init Failed)',
    message: `Boot Log:\n\n${(err.stack ?? err.message) as string}`,
    btnText: 'Exit',
    bgClose: false,
  }).then(() => {
    exitApp()
  })
})

/**
 * 生命周期埋点：退到后台前必须真正落盘
 * （系统可能在后台直接杀进程，未落盘的日志就是丢失的现场）。
 * 因此 background/inactive 用 await flush() 等真正落盘完成；
 * active 只做尽力落盘，不阻塞前台恢复。
 */
AppState.addEventListener('change', async(state) => {
  info('APP_STATE', `app state changed: ${state}`, {
    costMs: bootCost(),
    isPlayedStop: global.lx.isPlayedStop,
    playerTrackId: global.lx.playerTrackId || '',
  })
  markEvent('appState', state)
  // 让看门狗能区分"RN 在后台暂停了 JS 定时器"与"JS 真的被卡住"
  noteAppState(state)
  // 在原生时间线上打同样的锚点，便于把两份日志对齐
  logToNativeTimeline('APP_STATE', `js app state changed: ${state}`)
  if (state === 'background' || state === 'inactive') {
    // 最可能被系统杀进程的时刻，必须等落盘完成
    await flush()
  } else {
    void flush()
  }
})
