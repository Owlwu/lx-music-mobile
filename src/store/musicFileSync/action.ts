import state from './state'

const emit = () => {
  global.state_event.musicFileSyncUpdated({ ...state })
}

export default {
  setProgress(progress: LX.Sync.MusicFile.Progress) {
    state.progress = progress
    emit()
  },
  setPlan(result: LX.Sync.MusicFile.CompareResult) {
    state.plan = result.plan
    state.localRoot = result.localRoot
    state.remoteRoot = result.remoteRoot
    state.remoteDeviceName = result.remoteDeviceName
    emit()
  },
  clearPlan() {
    state.plan = null
    emit()
  },
  setBusy(busy: boolean) {
    state.busy = busy
    emit()
  },
  setError(error: string) {
    state.error = error
    emit()
  },
  reset() {
    state.plan = null
    state.error = ''
    emit()
  },
}
