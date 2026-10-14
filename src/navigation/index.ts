import { Navigation } from 'react-native-navigation'
import * as screenNames from './screenNames'
import * as navigations from './navigation'

import registerScreens from './registerScreens'
import { removeComponentId } from '@/core/common'
import { onAppLaunched } from './regLaunchedEvent'
import { info, flush } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'

let unRegisterEvent: ReturnType<ReturnType<typeof Navigation.events>['registerScreenPoppedListener']>

const init = (callback: () => void | Promise<void>) => {
  // Register all screens on launch
  registerScreens()
  info('BOOT', 'navigation: screens registered')

  if (unRegisterEvent) unRegisterEvent.remove()

  Navigation.setDefaultOptions({
    // animations: {
    //   setRoot: {
    //     waitForRender: true,
    //   },
    // },
  })
  unRegisterEvent = Navigation.events().registerScreenPoppedListener(({ componentId }) => {
    removeComponentId(componentId)
  })
  info('BOOT', 'navigation: default options set, waiting for app launched event')
  onAppLaunched(() => {
    info('BOOT', 'navigation: app launched listener fired')
    markEvent('boot:navigationListener')
    const startTime = Date.now()
    // 导航初始化回调：handleInit() 会在这里被 await，它的任何一步永不 resolve
    // 都会导致 pushHomeScreen() 永不执行 → 应用全屏空白。
    // 因此这里必须记录"进入/返回/耗时"，这是定位白屏的关键分界点。
    void Promise.resolve(callback()).then(() => {
      info('BOOT', 'navigation: init callback resolved (home screen pushed)', { costMs: Date.now() - startTime })
      markEvent('boot:homeScreenPushed', { costMs: Date.now() - startTime })
      void flush()
    }).catch((err) => {
      info('BOOT', 'navigation: init callback rejected', {
        costMs: Date.now() - startTime,
        error: err?.stack ?? err?.message ?? String(err),
      })
      void flush()
    })
  })
}

export * from './utils'
export * from './event'
export * from './hooks'

export {
  init,
  screenNames,
  navigations,
}
