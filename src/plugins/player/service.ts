/* eslint-disable @typescript-eslint/no-misused-promises */
import TrackPlayer, { State as TPState, Event as TPEvent } from 'react-native-track-player'
// import { store } from '@/store'
// import { action as playerAction, STATUS } from '@/store/modules/player'
import { isTempId, isEmpty } from './utils'
// import { play as lrcPlay, pause as lrcPause } from '@/core/lyric'
import { exitApp } from '@/core/common'
import { getCurrentTrackId } from './playList'
import { pause, play, playNext, playPrev } from '@/core/player/player'
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

  // 音频焦点/系统打断（来电、其它 App 抢占、系统降音）。
  // 这是"突然没有声音"的一条独立成因，而原实现整段被注释掉 —— 完全不可见。
  // 这里只补日志，不改变任何既有的播放行为（原来的注释代码会 dispatch store action）。
  TrackPlayer.addEventListener(TPEvent.RemoteDuck, async({ permanent, paused, ducking }: any) => {
    info('PLAYBACK', 'remote duck (audio focus changed)', {
      permanent,
      paused,
      ducking,
      playerTrackId: global.lx.playerTrackId || '',
      isPlay: playerState.isPlay,
      isTempId: isTempId(),
    })
    markEvent('playback.remoteDuck', { permanent, paused, ducking })
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
        global.app_event.pause()
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
