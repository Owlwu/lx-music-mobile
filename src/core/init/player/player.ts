import { addPlayedList, clearPlayedList } from '@/core/player/playedList'
import { pause, playNext } from '@/core/player/player'
import { setStatusText, setIsPlay } from '@/core/player/playStatus'
// import { resetPlayerMusicInfo } from '@/core/player/playInfo'
import { setStop } from '@/plugins/player'
import { delayUpdateMusicInfo } from '@/plugins/player/playList'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { info } from '@/utils/runtimeLog'


export default async(setting: LX.AppSetting) => {
  // 这两个函数是 UI"正在播放/已暂停"状态的唯一来源（原实现完全没有日志）：
  // 用户看到"状态还是正在播放"，等价于 setIsPlay(true) 之后再也没有被改成 false，
  // 因此这里的每一跳都必须留痕。
  const setPlayStatus = () => {
    info('PLAYBACK', 'ui state -> playing', {
      trackId: global.lx.playerTrackId || '',
      id: playerState.musicInfo.id,
    })
    setIsPlay(true)
  }
  const setPauseStatus = () => {
    info('PLAYBACK', 'ui state -> paused', {
      trackId: global.lx.playerTrackId || '',
      id: playerState.musicInfo.id,
      isPlayedStop: global.lx.isPlayedStop,
    })
    setIsPlay(false)
    if (global.lx.isPlayedStop) void pause()
  }

  const handleEnded = () => {
    // 自动切歌的唯一入口：卡住时这里会"有进无出"，必须记录
    info('PLAYBACK', 'playerEnded event -> playNext', {
      isPlayedStop: global.lx.isPlayedStop,
      trackId: global.lx.playerTrackId || '',
      id: playerState.musicInfo.id,
      playIndex: playerState.playInfo.playIndex,
    })
    // setTimeout(() => {
    if (global.lx.isPlayedStop) {
      setStatusText(global.i18n.t('player__end'))
      return
    }
    // resetPlayerMusicInfo()
    // global.app_event.stop()
    global.app_event.setProgress(0)
    setStatusText(global.i18n.t('player__end'))
    void playNext(true)
    // })
  }

  const setStopStatus = () => {
    info('PLAYBACK', 'ui state -> stopped', {
      trackId: global.lx.playerTrackId || '',
      id: playerState.musicInfo.id,
    })
    setIsPlay(false)
    setStatusText('')
    void setStop()
  }

  const updatePic = () => {
    if (!settingState.setting['player.isShowNotificationImage']) return
    if (playerState.playMusicInfo.musicInfo && playerState.musicInfo.pic) {
      delayUpdateMusicInfo(playerState.musicInfo)
    }
  }

  const handleConfigUpdated: typeof global.state_event.configUpdated = (keys, settings) => {
    if (keys.includes('player.togglePlayMethod')) {
      const newValue = settings['player.togglePlayMethod']
      if (playerState.playedList.length) clearPlayedList()
      const playMusicInfo = playerState.playMusicInfo
      if (newValue == 'random' && playMusicInfo.musicInfo && !playMusicInfo.isTempPlay) addPlayedList({ ...(playMusicInfo as LX.Player.PlayMusicInfo) })
    }
  }


  global.app_event.on('play', setPlayStatus)
  global.app_event.on('pause', setPauseStatus)
  global.app_event.on('error', setPauseStatus)
  global.app_event.on('stop', setStopStatus)
  global.app_event.on('playerEnded', handleEnded)
  global.app_event.on('picUpdated', updatePic)
  global.state_event.on('configUpdated', handleConfigUpdated)
}
