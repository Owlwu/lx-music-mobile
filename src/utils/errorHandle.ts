import { Alert, AppState } from 'react-native'
// import { exitApp } from '@/utils/common'
import { setJSExceptionHandler, setNativeExceptionHandler } from 'react-native-exception-handler'
import { error as runtimeError, flushSyncBestEffort, getSnapshot } from '@/utils/runtimeLog'
import { getWatchdogSnapshot } from '@/utils/stallWatchdog'
import { getHeartbeatSnapshot } from '@/utils/playbackHeartbeat'
import { toast, isActive } from './tools'

/**
 * 收集崩溃时的播放上下文。
 * 这些字段是排查"长时间听歌后歌曲不播放/应用空白"时判断"崩溃前在播什么、
 * 播放器处于什么状态"的直接证据，因此必须随异常一起落盘。
 *
 * 注意：这里的字段会被写进"用户几乎必然会上报"的运行日志（设置页「分享日志」），
 * 因此宁可多带几个标量，也不要在事后靠猜。
 */
const getPlayContext = () => {
  try {
    const now = Date.now()
    let nowPlayTime = -1
    let statusText = ''
    try {
      // 惰性取：本文件在 app 启动最早期就被 import，避免把 store 提前拉进启动路径
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const playerState: any = require('@/store/player/state').default
      nowPlayTime = Math.round(Number(playerState?.progress?.nowPlayTime ?? -1))
      statusText = String(playerState?.statusText ?? '')
    } catch (err) {}
    return {
      appState: AppState.currentState,
      uiVisible: isActive(),
      trackId: global.lx?.playerTrackId ?? '',
      gettingUrlId: global.lx?.gettingUrlId ?? '',
      // "取链接闩锁"持续多久：闩锁期间全部播放状态事件都会被丢弃
      gettingUrlIdAgeMs: global.lx?.gettingUrlId ? now - (global.lx.gettingUrlIdSince || now) : 0,
      isPlayedStop: global.lx?.isPlayedStop ?? false,
      nowPlayTime,
      statusText,
      isIniting: global.lx?.playerStatus?.isIniting ?? false,
      isInitialized: global.lx?.playerStatus?.isInitialized ?? false,
      isRegisteredService: global.lx?.playerStatus?.isRegisteredService ?? false,
    }
  } catch (err) {
    return { contextError: true }
  }
}

/** 崩溃前紧急落盘：写入播放上下文 + 内存快照 + 看门狗/心跳状态 */
const flushFatalContext = (source: string, detail: any) => {
  try {
    runtimeError('FATAL', source, { ...getPlayContext(), ...detail })
    runtimeError('FATAL', 'memory snapshot', { snapshot: getSnapshot(200) })
    runtimeError('FATAL', 'watchdog snapshot', { snapshot: getWatchdogSnapshot() })
    runtimeError('FATAL', 'heartbeat snapshot', { snapshot: getHeartbeatSnapshot() })
  } catch (err) {
    // 日志模块自身异常绝不能掩盖原始错误
    console.log('flushFatalContext failed', err)
  }
  // flushSyncBestEffort 内部自行 try/catch，不会抛出
  // （显式 void：崩溃收尾路径无法 await，这里接受 best effort 的丢失窗口）
  void flushSyncBestEffort()
}

const errorHandler = (e: Error, isFatal: boolean) => {
  const excludedErrors = [
    'Failed to construct \'Response\'',
  ]
  if (isFatal) {
    if (excludedErrors.some((excludedError) => e.message.includes(excludedError))) {
      toast('应用遇到了错误，如果你有固定的复现方式，请截图并在 GitHub 反馈（并附上具体的操作步骤，以及“设置-其他-日志”里「分享日志」导出的文件）')
    } else {
      Alert.alert(
        '💥Unexpected error occurred💥',
        `
  应用出 bug 了😭，以下是错误异常信息。请截图并在 GitHub 反馈（并附上刚才你进行了什么操作，以及附上“设置-其他-日志”里「分享日志」导出的文件）。现在应用可能会出现异常，若出现异常请尝试强制结束应用后重新启动！

  Error:
  ${isFatal ? 'Fatal:' : ''} ${e.name} ${e.message}
  `,
        [{
          text: '关闭 (Close)',
          onPress: () => {
            // exitApp()
          },
        }],
      )
    }
  }
  // 异常本身（含栈）由下面的 flushFatalContext 写进运行日志（tag=FATAL），
  // 并带上播放上下文后紧急落盘，因此这里不再额外写一条纯文本日志。
  flushFatalContext('JS exception', {
    name: e.name,
    message: e.message,
    isFatal,
    stack: e.stack ?? '',
    // 崩溃弹窗只在界面前台时可见；后台崩溃时用户看不到任何提示，
    // 只会在切回前台时看到"空白"，因此必须记录当时是否可见。
    alertVisible: isActive(),
  })
}

if (process.env.NODE_ENV !== 'development') {
  setJSExceptionHandler(errorHandler)

  setNativeExceptionHandler((errorString) => {
    // 原生异常同样必须带上播放上下文并紧急落盘，否则崩溃时会丢失全部排查线索
    flushFatalContext('native exception', {
      errorString,
      // 说明清楚"用户会看到什么"：forceToQuit=false 时，
      // react-native-exception-handler 会用 DefaultErrorScreen 接管界面并 finish 当前 Activity，
      // 但**不会** System.exit —— 进程、前台播放服务、悬浮歌词都会继续存活，
      // 于是现象正是"界面空白、歌词还在、声音却没了"。
      uiTakeover: 'native exception handler shows DefaultErrorScreen and finishes the activity (forceToQuit=false); process and foreground service survive',
    })
    console.log('+++++', errorString, '+++++')
  }, false)
}
