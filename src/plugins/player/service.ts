/* eslint-disable @typescript-eslint/no-misused-promises */
import TrackPlayer, { State as TPState, Event as TPEvent } from 'react-native-track-player'
// import { store } from '@/store'
// import { action as playerAction, STATUS } from '@/store/modules/player'
import { isTempId, isEmpty } from './utils'
// import { play as lrcPlay, pause as lrcPause } from '@/core/lyric'
import { exitApp } from '@/core/common'
import { getCurrentTrackId } from './playList'
import { pause, play, playNext, playPrev } from '@/core/player/player'
import { setStatusText } from '@/core/player/playStatus'
import playerState from '@/store/player/state'
import { info, warn, error, flush } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'

let isInitialized = false

// let retryTrack: LX.Player.Track | null = null
// let retryGetUrlId: string | null = null
// let retryGetUrlNum = 0
// let errorTime = 0
// let prevDuration = 0
// let isPlaying = false

// 销毁播放器并退出
const handleExitApp = async(reason: string) => {
  warn('PLAYER', 'exit app', {
    reason,
    playerTrackId: global.lx.playerTrackId,
    isPlayedStop: global.lx.isPlayedStop,
  })
  markEvent('player.exitApp', { reason })
  global.lx.isPlayedStop = false
  exitApp(reason)
}


// 把 native 侧的 remote-duck 三字段翻译成可读语义。
// 字段含义来自 ExoPlayback 的映射（media3 1.8.0）：
//   permanent=true                  → AUDIOFOCUS_LOSS：media3 会放弃焦点，不会自动恢复
//   permanent=false, ducking=true   → LOSS_TRANSIENT 抑制：GAIN 后自动恢复（不是 0.2 音量 duck）
//   permanent=false, ducking=false, paused=true → becoming-noisy（拔耳机）等
//   permanent=false, paused=false   → 抑制结束（GAIN）
// 注意：真正的 CAN_DUCK（音量 ×0.2）不会发 remote-duck，UI 会一直显示"播放中"。
const classifyRemoteDuck = ({ permanent, paused, ducking }: { permanent: boolean, paused: boolean, ducking: boolean }) => {
  if (!paused) return 'focus-regained'
  if (permanent) return 'focus-lost-permanent'
  if (ducking) return 'focus-suppressed-transient'
  return 'audio-becoming-noisy'
}

const registerPlaybackService = async() => {
  if (isInitialized) {
    info('PLAYER', 'registerPlaybackService skipped, already initialized')
    return
  }

  console.log('reg services...')
  info('PLAYER', 'registerPlaybackService start')
  TrackPlayer.addEventListener(TPEvent.RemotePlay, () => {
    // console.log('remote-play')
    info('PLAYER', 'remote event', { event: 'RemotePlay' })
    markEvent('remote.RemotePlay')
    play()
  })

  TrackPlayer.addEventListener(TPEvent.RemotePause, () => {
    // console.log('remote-pause')
    info('PLAYER', 'remote event', { event: 'RemotePause' })
    markEvent('remote.RemotePause')
    void pause()
  })

  TrackPlayer.addEventListener(TPEvent.RemoteNext, () => {
    // console.log('remote-next')
    info('PLAYER', 'remote event', { event: 'RemoteNext' })
    markEvent('remote.RemoteNext')
    void playNext()
  })

  TrackPlayer.addEventListener(TPEvent.RemotePrevious, () => {
    // console.log('remote-previous')
    info('PLAYER', 'remote event', { event: 'RemotePrevious' })
    markEvent('remote.RemotePrevious')
    void playPrev()
  })

  TrackPlayer.addEventListener(TPEvent.RemoteStop, () => {
    // console.log('remote-stop')
    info('PLAYER', 'remote event', { event: 'RemoteStop' })
    markEvent('remote.RemoteStop')
    void handleExitApp('Remote Stop')
  })

  // 音频焦点/系统打断（来电、其它 App 抢占、拔耳机、系统降音）。
  // 字段语义见 classifyRemoteDuck 的注释；这里既补日志，也把"被其它应用占用"
  // 落到状态栏文案上，避免瞬时抑制被误认为用户手动暂停。
  TrackPlayer.addEventListener(TPEvent.RemoteDuck, async({ permanent, paused, ducking }: any) => {
    const kind = classifyRemoteDuck({ permanent, paused, ducking })
    info('PLAYBACK', 'remote duck (audio focus changed)', {
      kind,
      permanent,
      paused,
      ducking,
      playerTrackId: global.lx.playerTrackId || '',
      isPlay: playerState.isPlay,
      isTempId: isTempId(),
    })
    markEvent('playback.remoteDuck', { kind, permanent, paused, ducking })
    // 恢复时只清掉自己写的文案，避免覆盖"缓冲中"等其它状态。
    const focusLostText = global.i18n.t('player__audio_focus_lost')
    if (kind === 'focus-suppressed-transient' || kind === 'focus-lost-permanent') {
      setStatusText(focusLostText)
    } else if (kind === 'focus-regained' && playerState.statusText === focusLostText) {
      setStatusText('')
    }
    void flush()
  })

  TrackPlayer.addEventListener(TPEvent.PlaybackError, async(err: any) => {
    console.log('playback-error', err)
    // "歌曲不播放"最关键的证据：error code/message + 当前曲目 id
    error('PLAYBACK_ERROR', 'playback error', {
      code: err?.code,
      message: err?.message,
      trackId: global.lx.playerTrackId,
      gettingUrlId: global.lx.gettingUrlId,
      isTempId: isTempId(),
      isEmpty: isEmpty(),
      isPlayedStop: global.lx.isPlayedStop,
    })
    markEvent('playback.error', { code: err?.code, message: err?.message })
    void flush()
    global.app_event.error()
    global.app_event.playerError()
  })

  TrackPlayer.addEventListener(TPEvent.RemoteSeek, async({ position }) => {
    info('PLAYER', 'remote event', { event: 'RemoteSeek', position })
    global.app_event.setProgress(position as number)
  })

  TrackPlayer.addEventListener(TPEvent.PlaybackState, async info_ => {
    // 热路径：只记标量（state 名 + position + 两个守卫标记），不序列化整个 event 对象
    const stateName = TPState[info_.state] ?? String(info_.state)
    info('PLAYBACK', 'state', {
      state: stateName,
      position: info_.position,
      isGettingUrlId: global.lx.gettingUrlId || '',
      isTempId: isTempId(),
    })
    markEvent('playback.state', { state: stateName })

    if (global.lx.gettingUrlId || isTempId()) {
      info('PLAYBACK', 'state ignored by guard', {
        state: stateName,
        gettingUrlId: global.lx.gettingUrlId || '',
        // "取链接闩锁"存在期间所有状态事件都会被丢弃（表现为无声/进度不动/切歌无效）。
        // 记录闩锁年龄，才能区分"正常取链接"与"取链接永远不返回"。
        gettingUrlIdAgeMs: global.lx.gettingUrlIdSince ? Date.now() - global.lx.gettingUrlIdSince : 0,
        isTempId: isTempId(),
        isPlay: playerState.isPlay,
        playerTrackId: global.lx.playerTrackId || '',
        nowPlayTime: Math.round(playerState.progress.nowPlayTime),
        position: info_.position,
      })
      return
    }
    // let currentIsPlaying = false

    switch (info_.state) {
      case TPState.None:
        // console.log('state', 'State.NONE')
        break
      case TPState.Ready:
      case TPState.Stopped:
      case TPState.Paused:
        global.app_event.playerPause()
        global.app_event.pause()
        break
      case TPState.Playing:
        global.app_event.playerPlaying()
        global.app_event.play()
        break
      case TPState.Buffering:
        // 缓冲**不是暂停**：这里原来先 `global.app_event.pause()`，会把 UI 置成"已暂停"、
        // 停掉进度轮询，并在每次重新缓冲时产生一对 pause/play 事件。
        // 2026-11-12 的诊断日志里，原生播放器在 ~0.58s 的周期内反复 BUFFERING↔PLAYING
        // （同一位置 277.42s 卡住 60s 以上），于是 UI 每秒闪一次"暂停/播放"，进度轮询被
        // 反复停掉 —— 用户看到的就是"进度条卡死、按钮乱跳"。
        // 缓冲只应更新状态文案（playerWaiting 会写"缓冲中"），不改变播放/暂停语义。
        global.app_event.playerWaiting()
        break
      case TPState.Connecting:
        global.app_event.playerLoadstart()
        break
      default:
        // console.log('playback-state', info)
        break
    }
    if (global.lx.isPlayedStop) return handleExitApp('Timeout Exit')

    // console.log('currentIsPlaying', currentIsPlaying, global.lx.playInfo.isPlaying)
    // void updateMetaData(global.lx.store_playMusicInfo.musicInfo, currentIsPlaying)
  })
  TrackPlayer.addEventListener(TPEvent.PlaybackTrackChanged, async info_ => {
    // console.log('PlaybackTrackChanged====>', info)
    markEvent('playback.trackChanged', { track: info_.track, nextTrack: info_.nextTrack })
    const prevTrackId = global.lx.playerTrackId
    global.lx.playerTrackId = await getCurrentTrackId()
    info('PLAYBACK', 'track changed', {
      track: info_.track,
      nextTrack: info_.nextTrack,
      prevTrackId: prevTrackId || '',
      playerTrackId: global.lx.playerTrackId || '',
      isEmpty: isEmpty(),
      isPlayedStop: global.lx.isPlayedStop,
    })
    if (info_.track == null) return
    if (global.lx.isPlayedStop) return handleExitApp('Timeout Exit')

    // console.log('global.lx.playerTrackId====>', global.lx.playerTrackId)
    if (isEmpty()) {
      // console.log('====TEMP PAUSE====')
      warn('PLAYBACK', 'temp track detected, pause and report ended', {
        playerTrackId: global.lx.playerTrackId || '',
      })
      markEvent('playback.tempPause')
      await TrackPlayer.pause()
      global.app_event.playerPause()
      global.app_event.pause()
      global.app_event.playerEnded()
      global.app_event.playerEmptied()
      // if (retryTrack) {
      //   if (retryTrack.musicId == retryGetUrlId) {
      //     if (++retryGetUrlNum > 1) {
      //       store.dispatch(playerAction.playNext(true))
      //       retryGetUrlId = null
      //       retryTrack = null
      //       return
      //     }
      //   } else {
      //     retryGetUrlId = retryTrack.musicId
      //     retryGetUrlNum = 0
      //   }
      //   store.dispatch(playerAction.refreshMusicUrl(global.lx.playInfo.currentPlayMusicInfo, errorTime))
      // } else {
      //   store.dispatch(playerAction.playNext(true))
      // }
    }
  //   // if (!info.nextTrack) return
  //   // if (info.track) {
  //   //   const track = info.track.substring(0, info.track.lastIndexOf('__//'))
  //   //   const nextTrack = info.track.substring(0, info.nextTrack.lastIndexOf('__//'))
  //   //   console.log(nextTrack, track)
  //   //   if (nextTrack == track) return
  //   // }
  //   // const track = await TrackPlayer.getTrack(info.nextTrack)
  //   // if (!track) return
  //   // let newTrack
  //   // if (track.url == defaultUrl) {
  //   //   TrackPlayer.pause().then(async() => {
  //   //     isRefreshUrl = true
  //   //     retryGetUrlId = track.id
  //   //     retryGetUrlNum = 0
  //   //     try {
  //   //       newTrack = await updateTrackUrl(track)
  //   //       console.log('++++newTrack++++', newTrack)
  //   //     } catch (error) {
  //   //       console.log('error', error)
  //   //       if (error.message != '跳过播放') TrackPlayer.skipToNext()
  //   //       isRefreshUrl = false
  //   //       retryGetUrlId = null
  //   //       return
  //   //     }
  //   //     retryGetUrlId = null
  //   //     isRefreshUrl = false
  //   //     console.log(await TrackPlayer.getQueue(), null, 2)
  //   //     await TrackPlayer.play()
  //   //   })
  //   // }
  //   // store.dispatch(playerAction.playNext())
  })
  // TrackPlayer.addEventListener('playback-queue-ended', async info => {
  //   // console.log('playback-queue-ended', info)
  //   store.dispatch(playerAction.playNext())
  //   // if (!info.nextTrack) return
  //   // const track = await TrackPlayer.getTrack(info.nextTrack)
  //   // if (!track) return
  //   // // if (track.url == defaultUrl) {
  //   // //   TrackPlayer.pause()
  //   // //   getMusicUrl(track.original).then(url => {
  //   // //     TrackPlayer.updateMetadataForTrack(info.nextTrack, {
  //   // //       url,
  //   // //     })
  //   // //     TrackPlayer.play()
  //   // //   })
  //   // // }
  //   // if (!track.artwork) {
  //   //   getMusicPic(track.original).then(url => {
  //   //     console.log(url)
  //   //     TrackPlayer.updateMetadataForTrack(info.nextTrack, {
  //   //       artwork: url,
  //   //     })
  //   //   })
  //   // }
  // })
  // TrackPlayer.addEventListener('playback-destroy', async() => {
  //   console.log('playback-destroy')
  //   store.dispatch(playerAction.destroy())
  // })
  isInitialized = true
  info('PLAYER', 'registerPlaybackService done')
}


export default () => {
  if (global.lx.playerStatus.isRegisteredService) {
    info('PLAYER', 'registerPlaybackService skipped, already registered')
    return
  }
  console.log('handle registerPlaybackService...')
  info('PLAYER', 'registerPlaybackService registering')
  TrackPlayer.registerPlaybackService(() => registerPlaybackService)
  global.lx.playerStatus.isRegisteredService = true
}
