import TrackPlayer from 'react-native-track-player'
import { updateOptions, setVolume, setPlaybackRate, migratePlayerCache } from './utils'
import { info, flush } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'

// const listenEvent = () => {
//   TrackPlayer.addEventListener('playback-error', err => {
//     console.log('playback-error', err)
//   })
//   TrackPlayer.addEventListener('playback-state', info => {
//     console.log('playback-state', info)
//   })
//   TrackPlayer.addEventListener('playback-track-changed', info => {
//     console.log('playback-track-changed', info)
//   })
//   TrackPlayer.addEventListener('playback-queue-ended', info => {
//     console.log('playback-queue-ended', info)
//   })
// }

const initial = async({ volume, playRate, cacheSize, isHandleAudioFocus, isEnableAudioOffload }: {
  volume: number
  playRate: number
  cacheSize: number
  isHandleAudioFocus: boolean
  isEnableAudioOffload: boolean
}) => {
  if (global.lx.playerStatus.isIniting || global.lx.playerStatus.isInitialized) {
    info('PLAYER', 'initial skipped by guard', {
      isIniting: global.lx.playerStatus.isIniting,
      isInitialized: global.lx.playerStatus.isInitialized,
    })
    markEvent('player.initial.skip', { isIniting: global.lx.playerStatus.isIniting })
    return
  }
  global.lx.playerStatus.isIniting = true
  console.log('Cache Size', cacheSize * 1024)
  const startTime = Date.now()
  info('PLAYER', 'initial start', {
    volume,
    playRate,
    cacheSize,
    isHandleAudioFocus,
    isEnableAudioOffload,
  })
  markEvent('player.initial.start', { cacheSize })

  await migratePlayerCache()

  markEvent('player.setupPlayer.start')
  const setupStart = Date.now()
  await TrackPlayer.setupPlayer({
    maxCacheSize: cacheSize * 1024,
    maxBuffer: 1000,
    waitForBuffer: true,
    handleAudioFocus: isHandleAudioFocus,
    audioOffload: isEnableAudioOffload,
    autoUpdateMetadata: false,
  })
  global.lx.playerStatus.isInitialized = true
  global.lx.playerStatus.isIniting = false
  info('PLAYER', 'setupPlayer done', { elapsed: Date.now() - setupStart })
  markEvent('player.setupPlayer.done', { elapsed: Date.now() - setupStart })

  // 注意：以下三步保持"裸 await"，不加 try/catch、不加 .catch —— 让异常照原样向上冒泡。
  // initial() 的唯一调用点 src/core/player/player.ts 会 await 它，异常冒泡出 handlePlay()，
  // 播放器初始化失败必须"可见且中断"；若在此吞掉异常，initial() 会正常返回，
  // 而 isInitialized 已于上面置 true → 播放器陷入"半初始化"（音量/倍速/通知选项未生效）却被认为一切正常。
  // 失败证据不会丢：异常最终由 errorHandle.ts 的 setJSExceptionHandler 写入 [FATAL] + 播放上下文。
  info('PLAYER', 'updateOptions start', { elapsed: Date.now() - startTime })
  await updateOptions()
  info('PLAYER', 'updateOptions done', { elapsed: Date.now() - startTime })

  info('PLAYER', 'setVolume start', { volume, elapsed: Date.now() - startTime })
  await setVolume(volume)
  info('PLAYER', 'setVolume done', { elapsed: Date.now() - startTime })

  info('PLAYER', 'setPlaybackRate start', { playRate, elapsed: Date.now() - startTime })
  await setPlaybackRate(playRate)
  info('PLAYER', 'setPlaybackRate done', { elapsed: Date.now() - startTime })
  // listenEvent()

  info('PLAYER', 'initial finished', { elapsed: Date.now() - startTime })
  markEvent('player.initial.finished', { elapsed: Date.now() - startTime })
  void flush()
}


const isInitialized = () => global.lx.playerStatus.isInitialized


export {
  initial,
  isInitialized,
  setVolume,
  setPlaybackRate,
}

export {
  setResource,
  setPause,
  setPlay,
  setCurrentTime,
  getDuration,
  setStop,
  resetPlay,
  getPosition,
  updateMetaData,
  onStateChange,
  isEmpty,
  useBufferProgress,
  initTrackInfo,
} from './utils'
