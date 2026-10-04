import * as musicFileSync from '@/plugins/sync/client/modules/musicFile'
import musicFileSyncActions from '@/store/musicFileSync/action'

// 底层传输进度 → 界面状态
musicFileSync.setProgressListener((progress: LX.Sync.MusicFile.Progress) => {
  musicFileSyncActions.setProgress(progress)
})

const errorMessage = (err: unknown) => (err as Error)?.message ?? String(err)

export const getFolders = async() => musicFileSync.getFolders()

/** 扫描两端并生成变更清单 */
export const compare = async(): Promise<LX.Sync.MusicFile.CompareResult | null> => {
  musicFileSyncActions.setBusy(true)
  musicFileSyncActions.setError('')
  try {
    const result = await musicFileSync.compare()
    musicFileSyncActions.setPlan(result)
    return result
  } catch (err) {
    musicFileSyncActions.setError(errorMessage(err))
    return null
  } finally {
    musicFileSyncActions.setBusy(false)
  }
}

/** 执行用户在清单中勾选的传输动作 */
export const applySync = async(selection: LX.Sync.MusicFile.Selection): Promise<LX.Sync.MusicFile.ApplyResult | null> => {
  musicFileSyncActions.setError('')
  try {
    const result = await musicFileSync.apply(selection)
    musicFileSyncActions.clearPlan()
    return result
  } catch (err) {
    musicFileSyncActions.setError(errorMessage(err))
    return null
  }
}

export const cancel = () => {
  musicFileSync.cancel()
}

export const getProgress = () => musicFileSync.getProgress()

export const reset = () => {
  musicFileSyncActions.reset()
}
