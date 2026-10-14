// import { LIST_ID_LOVE } from '@/config/constant'

import { updateMetaData } from '@/plugins/player'
import playerState from '@/store/player/state'
import { info, error } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'

export default () => {
  // const setVisibleDesktopLyric = useCommit('setVisibleDesktopLyric')
  // const setLockDesktopLyric = useCommit('setLockDesktopLyric')

  const buttons = {
    empty: true,
    collect: false,
    play: false,
    prev: true,
    next: true,
    lrc: false,
    lockLrc: false,
  }
  const setButtons = () => {
    // setPlayerAction(buttons)
    if (!playerState.playMusicInfo.musicInfo) {
      info('PLAYER', 'setButtons skipped, no musicInfo')
      return
    }
    markEvent('playStatus.updateMetaData')
    void updateMetaData(playerState.musicInfo, playerState.isPlay).catch((err: any) => {
      error('PLAYER', 'updateMetaData failed', {
        message: err?.message,
        id: playerState.musicInfo.id,
        isPlay: playerState.isPlay,
      })
    })
  }
  // const updateCollectStatus = async() => {
  //   // let status = !!playMusicInfo.musicInfo && await checkListExistMusic(LIST_ID_LOVE, playerState.playMusicInfo.musicInfo.id)
  //   // if (buttons.collect == status) return false
  //   // buttons.collect = status
  //   return true
  // }

  const handlePlay = () => {
    // if (buttons.empty) buttons.empty = false
    if (buttons.play) {
      info('PLAYER', 'playStatus handlePlay already active, skipped')
      return
    }
    buttons.play = true
    info('PLAYER', 'playStatus handlePlay, updating buttons')
    setButtons()
  }
  const handlePause = () => {
    // if (buttons.empty) buttons.empty = false
    if (!buttons.play) {
      info('PLAYER', 'playStatus handlePause already inactive, skipped')
      return
    }
    buttons.play = false
    info('PLAYER', 'playStatus handlePause, updating buttons')
    setButtons()
  }
  // const handleStop = () => {
  //   // if (playerState.playMusicInfo.musicInfo != null) return
  //   // if (buttons.collect) buttons.collect = false
  //   // buttons.empty = true
  //   setButtons()
  // }
  // const handleSetPlayInfo = () => {
  //   void updateCollectStatus().then(isExist => {
  //     if (isExist) setButtons()
  //   })
  // }
  // const handleSetTaskbarThumbnailClip = (clip) => {
  //   setTaskbarThumbnailClip(clip)
  // }
  // const throttleListChange = throttle(async listIds => {
  //   if (!listIds.includes(loveList.id)) return
  //   if (await updateCollectStatus()) setButtons()
  // })
  // const updateSetting = () => {
  //   const setting = store.getters.setting
  //   buttons.lrc = setting.desktopLyric.enable
  //   buttons.lockLrc = setting.desktopLyric.isLock
  //   setButtons()
  // }
  global.app_event.on('play', handlePlay)
  global.app_event.on('pause', handlePause)
  global.app_event.on('stop', handlePause)
  // global.app_event.on('musicToggled', handleSetPlayInfo)
  // window.app_event.on(eventTaskbarNames.setTaskbarThumbnailClip, handleSetTaskbarThumbnailClip)
  // window.app_event.on('myListMusicUpdate', throttleListChange)

  return async() => {
    // const setting = store.getters.setting
    // buttons.lrc = setting.desktopLyric.enable
    // buttons.lockLrc = setting.desktopLyric.isLock
    // await updateCollectStatus()
    // if (playMusicInfo.musicInfo != null) buttons.empty = false
    info('PLAYER', 'playStatus listener init callback, setButtons')
    setButtons()
  }
}
