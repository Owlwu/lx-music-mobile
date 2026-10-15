// @flow

import { Navigation } from 'react-native-navigation'

import {
  Home,
  PlayDetail,
  SonglistDetail,
  Comment,
  // Setting,
} from '@/screens'
import { Provider } from '@/store/Provider'

import {
  HOME_SCREEN,
  PLAY_DETAIL_SCREEN,
  SONGLIST_DETAIL_SCREEN,
  COMMENT_SCREEN,
  VERSION_MODAL,
  PACT_MODAL,
  SYNC_MODE_MODAL,
  // SETTING_SCREEN,
} from './screenNames'
import VersionModal from './components/VersionModal'
import PactModal from './components/PactModal'
import SyncModeModal from './components/SyncModeModal'
import ErrorBoundary from '@/components/common/ErrorBoundary'

/**
 * 每个屏幕都套一层错误边界。
 *
 * 原因：React 对渲染期未捕获异常的默认行为是卸载整棵树 → 整屏空白，
 * 而原生播放服务/悬浮歌词仍然存活，用户看到的就是"界面空白但歌词还在显示"。
 * 边界会把异常变成一条 [RENDER] 日志 + 一个可见的降级页（见 ErrorBoundary.tsx）。
 */
function WrappedComponent(Component: any, screenName: string) {
  return function inject(props: Record<string, any>) {
    const EnhancedComponent = () => (
      <ErrorBoundary name={screenName}>
        <Provider>
          <Component
            {...props}
          />
        </Provider>
      </ErrorBoundary>
    )

    return <EnhancedComponent />
  }
}

export default () => {
  Navigation.registerComponent(HOME_SCREEN, () => WrappedComponent(Home, HOME_SCREEN))
  Navigation.registerComponent(PLAY_DETAIL_SCREEN, () => WrappedComponent(PlayDetail, PLAY_DETAIL_SCREEN))
  Navigation.registerComponent(SONGLIST_DETAIL_SCREEN, () => WrappedComponent(SonglistDetail, SONGLIST_DETAIL_SCREEN))
  Navigation.registerComponent(COMMENT_SCREEN, () => WrappedComponent(Comment, COMMENT_SCREEN))
  Navigation.registerComponent(VERSION_MODAL, () => WrappedComponent(VersionModal, VERSION_MODAL))
  Navigation.registerComponent(PACT_MODAL, () => WrappedComponent(PactModal, PACT_MODAL))
  Navigation.registerComponent(SYNC_MODE_MODAL, () => WrappedComponent(SyncModeModal, SYNC_MODE_MODAL))
  // Navigation.registerComponent(SETTING_SCREEN, () => WrappedComponent(Setting))

  console.info('All screens have been registered...')
}
