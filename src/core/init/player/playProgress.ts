import { updateListMusics } from '@/core/list'
import { setMaxplayTime, setNowPlayTime } from '@/core/player/progress'
import { setCurrentTime, getDuration, getPosition } from '@/plugins/player'
import { formatPlayTime2 } from '@/utils/common'
import { savePlayInfo } from '@/utils/data'
import { throttleBackgroundTimer } from '@/utils/tools'
import BackgroundTimer from 'react-native-background-timer'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { onScreenStateChange } from '@/utils/nativeModules/utils'
import { AppState } from 'react-native'
import { info, warn, error } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'

const delaySavePlayInfo = throttleBackgroundTimer(() => {
  void savePlayInfo({
    time: playerState.progress.nowPlayTime,
    maxTime: playerState.progress.maxPlayTime,
    listId: playerState.playMusicInfo.listId!,
    index: playerState.playInfo.playIndex,
  })
}, 2000)

/**
 * 进度轮询的屏幕状态（对模块外可见，供心跳/诊断导出使用）。
 *
 * 进度轮询在息屏时会被主动停止，而"误判息屏后不再恢复"是"进度条永久不动"
 * 的一个真实机制，因此这个标记必须能被其它模块读到（心跳日志会带上它）。
 */
let currentIsScreenOn = true
export const getProgressScreenOn = () => currentIsScreenOn

/**
 * 进度轮询链路的存活计数（幂等诊断用）。
 * armSeq 只在真正（重新）挂上轮询时递增；tickSeq 由轮询回调递增。
 * 若 tickSeq 长时间不增长而 App 仍在播放，说明轮询链路已死（或被误判息屏）。
 */
let pollArmSeq = 0
let pollTickSeq = 0
let lastPollTickAt = 0
export const getProgressPollState = () => ({
  armSeq: pollArmSeq,
  tickSeq: pollTickSeq,
  lastTickAgoMs: lastPollTickAt ? Date.now() - lastPollTickAt : -1,
  isScreenOn: currentIsScreenOn,
  hasTimeout: updateTimeoutRef != null,
})

// updateTimeout 的模块级镜像，供 getProgressPollState 读取（真实状态仍在闭包内维护）
let updateTimeoutRef: number | null = null

export default () => {
  // const updateMusicInfo = useCommit('list', 'updateMusicInfo')

  let updateTimeout: number | null = null

  let isScreenOn = true

  // getPosition() 是一次原生调用；若它一直不返回，说明播放器（native）已经卡住。
  // 原实现只在 reject 时记日志，"永不 resolve"完全无声——这里补上耗时检测。
  let positionPendingSince = 0
  let hasReportedPositionPending = false
  const getCurrentTime = () => {
    let id = playerState.musicInfo.id
    if (positionPendingSince) {
      const pendingMs = Date.now() - positionPendingSince
      if (pendingMs > 10000 && !hasReportedPositionPending) {
        hasReportedPositionPending = true
        warn('PLAYBACK', 'getPosition has been pending for a long time (native player may be stuck)', {
          id,
          pendingMs,
          isPlay: playerState.isPlay,
          tickSeq: pollTickSeq,
        })
        markEvent('playback.getPositionPending', { id })
      }
      // 只在上一次调用仍未返回的短时间内跳过，避免把原生调用堆积成灾；
      // 但超过 15s 必须允许重新发起 —— 否则"旧的永不 resolve 的调用"会让轮询
      // 永久停摆，反而制造出我们要排查的那个现象（进度条再也不动）。
      if (pendingMs < 15000) return
      positionPendingSince = 0
    }
    positionPendingSince = Date.now()
    void getPosition().then(position => {
      positionPendingSince = 0
      hasReportedPositionPending = false
      if (!position || id != playerState.musicInfo.id) return
      setNowPlayTime(position)
      if (!playerState.isPlay) return

      if (settingState.setting['player.isSavePlayTime'] && !playerState.playMusicInfo.isTempPlay && isScreenOn) {
        delaySavePlayInfo()
      }
    }).catch((err: any) => {
      positionPendingSince = 0
      // 1s 轮询热路径：只在失败时记标量，不刷屏
      error('PLAYBACK', 'getPosition failed', { message: err?.message, id })
    })
  }
  const getMaxTime = async() => {
    setMaxplayTime(await getDuration())

    if (playerState.playMusicInfo.musicInfo && 'source' in playerState.playMusicInfo.musicInfo && !playerState.playMusicInfo.musicInfo.interval) {
      // console.log(formatPlayTime2(playProgress.maxPlayTime))

      if (playerState.playMusicInfo.listId) {
        void updateListMusics([{
          id: playerState.playMusicInfo.listId,
          musicInfo: {
            ...playerState.playMusicInfo.musicInfo,
            interval: formatPlayTime2(playerState.progress.maxPlayTime),
          },
        }])
      }
    }
  }

  const clearUpdateTimeout = (reason = 'unknown') => {
    if (!updateTimeout) return
    BackgroundTimer.clearInterval(updateTimeout)
    updateTimeout = null
    updateTimeoutRef = null
    info('PLAYBACK', 'progress polling stopped', { reason, tickSeq: pollTickSeq, isScreenOn })
  }
  const startUpdateTimeout = (reason = 'unknown') => {
    if (!isScreenOn) {
      info('PLAYBACK', 'startUpdateTimeout skipped, screen off', { reason })
      return
    }
    clearUpdateTimeout('restart')
    pollArmSeq++
    const intervalMs = 1000 / settingState.setting['player.playbackRate']
    updateTimeout = BackgroundTimer.setInterval(() => {
      pollTickSeq++
      lastPollTickAt = Date.now()
      getCurrentTime()
    }, intervalMs)
    updateTimeoutRef = updateTimeout
    // 这一行是"进度条到底还在不在轮询"的直接证据：
    // 有 started 而没有后续 tick（见心跳里的 pollTickAgoMs）就说明轮询链路已死。
    info('PLAYBACK', 'progress polling started', {
      reason,
      intervalMs,
      armSeq: pollArmSeq,
      isScreenOn,
      isPlay: playerState.isPlay,
    })
    getCurrentTime()
  }

  const setProgress = (time: number, maxTime?: number) => {
    if (!playerState.musicInfo.id) return
    // console.log('setProgress', time, maxTime)
    info('PLAYBACK', 'setProgress', { time, maxTime, id: playerState.musicInfo.id })
    markEvent('playback.setProgress', { time })
    setNowPlayTime(time)
    void setCurrentTime(time)

    if (maxTime != null) setMaxplayTime(maxTime)

    // if (!isPlay) audio.play()
  }


  const handlePlay = () => {
    info('PLAYBACK', 'progress handler: play', { id: playerState.musicInfo.id, isScreenOn })
    markEvent('playback.progress.play')
    void getMaxTime()
    // prevProgressStatus = 'normal'
    // handleSetTaskBarState(playProgress.progress, prevProgressStatus)
    startUpdateTimeout('play event')
  }
  const handlePause = () => {
    info('PLAYBACK', 'progress handler: pause', { id: playerState.musicInfo.id, isScreenOn })
    // prevProgressStatus = 'paused'
    // handleSetTaskBarState(playProgress.progress, prevProgressStatus)
    // clearBufferTimeout()
    clearUpdateTimeout('pause event')
  }

  const handleStop = () => {
    info('PLAYBACK', 'progress handler: stop', { id: playerState.musicInfo.id })
    clearUpdateTimeout('stop event')
    setNowPlayTime(0)
    setMaxplayTime(0)
    // prevProgressStatus = 'none'
    // handleSetTaskBarState(playProgress.progress, prevProgressStatus)
  }

  const handleError = () => {
    // if (!restorePlayTime) restorePlayTime = getCurrentTime() // 记录出错的播放时间
    // console.log('handleError')
    warn('PLAYBACK', 'progress handler: error, stop polling', {
      id: playerState.musicInfo.id,
      nowPlayTime: playerState.progress.nowPlayTime,
      maxPlayTime: playerState.progress.maxPlayTime,
    })
    markEvent('playback.progress.error')
    // prevProgressStatus = 'error'
    // handleSetTaskBarState(playProgress.progress, prevProgressStatus)
    clearUpdateTimeout('error event')
  }


  const handleSetPlayInfo = () => {
    // restorePlayTime = playProgress.nowPlayTime
    // void setCurrentTime(playerState.progress.nowPlayTime)
    // setMaxplayTime(playProgress.maxPlayTime)
    handlePause()
    if (!playerState.playMusicInfo.isTempPlay) {
      void savePlayInfo({
        time: playerState.progress.nowPlayTime,
        maxTime: playerState.progress.maxPlayTime,
        listId: playerState.playMusicInfo.listId!,
        index: playerState.playInfo.playIndex,
      })
    }
  }

  // watch(() => playerState.progress.nowPlayTime, (newValue, oldValue) => {
  //   if (settingState.setting['player.isSavePlayTime'] && !playMusicInfo.isTempPlay) {
  //     delaySavePlayInfo({
  //       time: newValue,
  //       maxTime: playerState.progress.maxPlayTime,
  //       listId: playMusicInfo.listId as string,
  //       index: playInfo.playIndex,
  //     })
  //   }
  // })
  // watch(() => playerState.progress.maxPlayTime, maxPlayTime => {
  //   if (!playMusicInfo.isTempPlay) {
  //     delaySavePlayInfo({
  //       time: playerState.progress.nowPlayTime,
  //       maxTime: maxPlayTime,
  //       listId: playMusicInfo.listId as string,
  //       index: playInfo.playIndex,
  //     })
  //   }
  // })

  const handleConfigUpdated: typeof global.state_event.configUpdated = (keys, settings) => {
    if (keys.includes('player.playbackRate')) {
      info('PLAYBACK', 'playbackRate config updated, restart polling', {
        playbackRate: settingState.setting['player.playbackRate'],
      })
      startUpdateTimeout('playbackRate changed')
    }
  }

  const handleScreenStateChanged: Parameters<typeof onScreenStateChange>[0] = (state) => {
    info('PLAYBACK', 'screen state changed', { state, prevIsScreenOn: isScreenOn, isPlay: playerState.isPlay })
    markEvent('playback.screenState', { state })
    isScreenOn = state == 'ON'
    currentIsScreenOn = isScreenOn
    if (isScreenOn) {
      if (playerState.isPlay) startUpdateTimeout('screen on')
    } else clearUpdateTimeout('screen off')
  }

  // 修复在某些设备上屏幕状态改变事件未触发导致的进度条未更新的问题
  AppState.addEventListener('change', (state) => {
    if (state == 'active' && !isScreenOn) {
      info('PLAYBACK', 'AppState active while screen flagged off, resync screen state')
      handleScreenStateChanged('ON')
    }
  })

  global.app_event.on('play', handlePlay)
  global.app_event.on('pause', handlePause)
  global.app_event.on('stop', handleStop)
  global.app_event.on('error', handleError)
  global.app_event.on('setProgress', setProgress)
  // global.app_event.on(eventPlayerNames.restorePlay, handleRestorePlay)
  // global.app_event.on('playerLoadeddata', handleLoadeddata)
  // global.app_event.on('playerCanplay', handleCanplay)
  // global.app_event.on('playerWaiting', handleWating)
  // global.app_event.on('playerEmptied', handleEmpied)
  global.app_event.on('musicToggled', handleSetPlayInfo)
  global.state_event.on('configUpdated', handleConfigUpdated)

  onScreenStateChange(handleScreenStateChanged)
}
