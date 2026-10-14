import { Alert } from 'react-native'
// import { exitApp } from '@/utils/common'
import { setJSExceptionHandler, setNativeExceptionHandler } from 'react-native-exception-handler'
import { log } from '@/utils/log'
import { error as runtimeError, flushSyncBestEffort, getSnapshot } from '@/utils/runtimeLog'
import { getWatchdogSnapshot } from '@/utils/stallWatchdog'
import { toast } from './tools'

/**
 * 收集崩溃时的播放上下文。
 * 这些字段是排查"长时间听歌后歌曲不播放/应用空白"时判断"崩溃前在播什么、
 * 播放器处于什么状态"的直接证据，因此必须随异常一起落盘。
 */
const getPlayContext = () => {
  try {
    return {
      trackId: global.lx?.playerTrackId ?? '',
      gettingUrlId: global.lx?.gettingUrlId ?? '',
      isPlayedStop: global.lx?.isPlayedStop ?? false,
      isIniting: global.lx?.playerStatus?.isIniting ?? false,
      isInitialized: global.lx?.playerStatus?.isInitialized ?? false,
      isRegisteredService: global.lx?.playerStatus?.isRegisteredService ?? false,
    }
  } catch (err) {
    return { contextError: true }
  }
}

/** 崩溃前紧急落盘：写入播放上下文 + 内存快照 + 看门狗状态 */
const flushFatalContext = (source: string, detail: any) => {
  try {
    runtimeError('FATAL', source, { ...getPlayContext(), ...detail })
    runtimeError('FATAL', 'memory snapshot', { snapshot: getSnapshot(200) })
    runtimeError('FATAL', 'watchdog snapshot', { snapshot: getWatchdogSnapshot() })
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
      toast('应用遇到了错误，如果你有固定的复现方式，请截图并在 GitHub 反馈（并附上具体的操作步骤，以及“设置-错误日志”的内容）')
    } else {
      Alert.alert(
        '💥Unexpected error occurred💥',
        `
  应用出 bug 了😭，以下是错误异常信息。请截图并在 GitHub 反馈（并附上刚才你进行了什么操作，以及附上“设置-错误日志”的内容）。现在应用可能会出现异常，若出现异常请尝试强制结束应用后重新启动！

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
  log.error(e.stack)
  // 除现有 log.error 外，同时写入 runtimeLog 并带上播放上下文 + 栈，然后紧急落盘
  flushFatalContext('JS exception', {
    name: e.name,
    message: e.message,
    isFatal,
    stack: e.stack ?? '',
  })
}

if (process.env.NODE_ENV !== 'development') {
  setJSExceptionHandler(errorHandler)

  setNativeExceptionHandler((errorString) => {
    log.error(errorString)
    // 原生异常同样必须带上播放上下文并紧急落盘，否则崩溃时会丢失全部排查线索
    flushFatalContext('native exception', { errorString })
    console.log('+++++', errorString, '+++++')
  }, false)
}
