// @flow

import { Navigation } from 'react-native-navigation'

import {
  Home,
  PlayDetail,
  // Setting,
} from '@/screens'
import { Provider } from '@/store/Provider'

import {
  HOME_SCREEN,
  PLAY_DETAIL_SCREEN,
  PACT_MODAL,
  SYNC_MODE_MODAL,
} from './screenNames'
import PactModal from './components/PactModal'
import SyncModeModal from './components/SyncModeModal'
import ErrorBoundary from '@/components/common/ErrorBoundary'

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
  Navigation.registerComponent(PACT_MODAL, () => WrappedComponent(PactModal, PACT_MODAL))
  Navigation.registerComponent(SYNC_MODE_MODAL, () => WrappedComponent(SyncModeModal, SYNC_MODE_MODAL))
}
