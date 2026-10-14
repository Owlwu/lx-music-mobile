import { getMusicUrl } from '@/core/music'
import { getNextPlayMusicInfo, resetRandomNextMusicInfo } from '@/core/player/player'
import { checkUrl } from '@/utils/request'
import playerState from '@/store/player/state'
import { isCached } from '@/plugins/player/utils'
import { info, warn, error } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'


const preloadMusicInfo = {
  isLoading: false,
  preProgress: 0,
  info: null as LX.Player.PlayMusicInfo | null,
}
const resetPreloadInfo = () => {
  info('PRELOAD', 'reset preload info', {
    isLoading: preloadMusicInfo.isLoading,
    id: preloadMusicInfo.info?.musicInfo.id,
  })
  preloadMusicInfo.preProgress = 0
  preloadMusicInfo.info = null
  preloadMusicInfo.isLoading = false
}
const preloadNextMusicUrl = async(curTime: number) => {
  if (preloadMusicInfo.isLoading || curTime - preloadMusicInfo.preProgress < 3) return
  preloadMusicInfo.isLoading = true
  console.log('preload next music url')
  const startTime = Date.now()
  info('PRELOAD', 'preload next music start', {
    curTime,
    preProgress: preloadMusicInfo.preProgress,
  })
  markEvent('preload.start', { curTime })
  try {
    const info_ = await getNextPlayMusicInfo()
    if (info_) {
      preloadMusicInfo.info = info_
      info('PRELOAD', 'preload target resolved', {
        id: info_.musicInfo.id,
        listId: info_.listId,
        elapsed: Date.now() - startTime,
      })
      const url = await getMusicUrl({ musicInfo: info_.musicInfo }).catch(() => '')
      if (url) {
        info('PRELOAD', 'preload url got', { id: info_.musicInfo.id })
        const [cached, available] = await Promise.all([isCached(url), checkUrl(url).then(() => true).catch(() => false)])
        info('PRELOAD', 'preload url check', { id: info_.musicInfo.id, cached, available })
        if (!cached && !available) {
          warn('PRELOAD', 'preload url not cached and not available, refreshing', { id: info_.musicInfo.id })
          markEvent('preload.refresh', { id: info_.musicInfo.id })
          const url2 = await getMusicUrl({ musicInfo: info_.musicInfo, isRefresh: true }).catch(() => '')
          console.log('preload url refresh', url2)
          info('PRELOAD', 'preload url refreshed', { id: info_.musicInfo.id, hasUrl: !!url2 })
        }
      } else {
        warn('PRELOAD', 'preload getMusicUrl returned empty', { id: info_.musicInfo.id })
      }
    } else {
      info('PRELOAD', 'no next music to preload')
    }
    info('PRELOAD', 'preload next music done', { elapsed: Date.now() - startTime })
    markEvent('preload.done', { elapsed: Date.now() - startTime })
  } catch (err: any) {
    // 注意：isLoading 在 finally 中释放；若某次 await 永不 resolve，布尔锁将永久卡住预加载
    error('PRELOAD', 'preload next music failed', { message: err?.message, elapsed: Date.now() - startTime })
    markEvent('preload.failed', { message: err?.message })
  } finally {
    preloadMusicInfo.isLoading = false
  }
}

export default () => {
  const setProgress = (time: number) => {
    if (!playerState.musicInfo.id) return
    preloadMusicInfo.preProgress = time
  }

  const handleSetPlayInfo = () => {
    resetPreloadInfo()
  }

  const handleConfigUpdated: typeof global.state_event.configUpdated = (keys, settings) => {
    if (!keys.includes('player.togglePlayMethod')) return
    if (!preloadMusicInfo.info || preloadMusicInfo.info.isTempPlay) return
    info('PRELOAD', 'togglePlayMethod changed, reset preload target', {
      togglePlayMethod: settings['player.togglePlayMethod'],
    })
    resetRandomNextMusicInfo()
    preloadMusicInfo.info = null
    preloadMusicInfo.preProgress = playerState.progress.nowPlayTime
  }

  const handlePlayProgressChanged: typeof global.state_event.playProgressChanged = (progress) => {
    const duration = progress.maxPlayTime
    if (duration > 10 && duration - progress.nowPlayTime < 10 && !preloadMusicInfo.info) {
      if (preloadMusicInfo.isLoading) {
        warn('PRELOAD', 'preload skipped, isLoading lock still held', {
          nowPlayTime: progress.nowPlayTime,
          maxPlayTime: duration,
        })
        return
      }
      void preloadNextMusicUrl(progress.nowPlayTime)
    }
  }

  global.app_event.on('setProgress', setProgress)
  global.app_event.on('musicToggled', handleSetPlayInfo)
  global.state_event.on('configUpdated', handleConfigUpdated)
  global.state_event.on('playProgressChanged', handlePlayProgressChanged)
}
