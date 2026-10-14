import { Navigation } from 'react-native-navigation'
import { info, flush } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'

let launched = false
const handlers: Array<() => void> = []


export const listenLaunchEvent = () => {
  Navigation.events().registerAppLaunchedListener(() => {
    // console.log('Register app launched listener', launched)
    info('BOOT', 'app launched event received', { launched })
    markEvent('boot:appLaunched', { launched })
    launched = true
    setImmediate(() => {
      info('BOOT', 'run app launched handlers', { handlerCount: handlers.length })
      for (const handler of handlers) handler()
      // 冷启动阶段的关键日志立即落盘：若后续初始化卡死/进程被杀，
      // 这些日志是判断"卡在哪一步"的唯一依据
      void flush()
    })
  })
}

export const onAppLaunched = (handler: () => void) => {
  handlers.push(handler)
  info('BOOT', 'register app launched handler', { isAlreadyLaunched: launched, handlerCount: handlers.length })
  if (launched) {
    setImmediate(() => {
      handler()
    })
  }
}
