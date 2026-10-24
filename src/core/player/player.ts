import { isInitialized, initial as playerInitial, isEmpty, setPause, setPlay, setResource, setStop, initTrackInfo } from '@/plugins/player'
import {
  setStatusText,
} from '@/core/player/playStatus'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import {
  getList,
  setPlayMusicInfo,
  setMusicInfo,
  setPlayListId,
} from '@/core/player/playInfo'
import {
  clearPlayedList,
  addPlayedList,
  removePlayedList,
} from '@/core/player/playedList'
import {
  clearTempPlayeList,
  removeTempPlayList,
} from '@/core/player/tempPlayList'
import { getMusicUrl, getPicPath, getLyricInfo } from '@/core/music'
import { requestMsg } from '@/utils/message'
import { getRandom } from '@/utils/common'
import { filterList } from './utils'
import BackgroundTimer from 'react-native-background-timer'
import { checkIgnoringBatteryOptimization, checkNotificationPermission, debounceBackgroundTimer } from '@/utils/tools'
import { LIST_IDS } from '@/config/constant'
import { addListMusics, removeListMusics } from '@/core/list'
import { addDislikeInfo } from '@/core/dislikeList'
import { applyMusicVolume, getEffectiveVolume } from '@/core/player/volume'
import { info, warn, error, flush } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'

// import { checkMusicFileAvailable } from '@renderer/utils/music'

const createDelayNextTimeout = (delay: number) => {
  let timeout: number | null
  const clearDelayNextTimeout = () => {
    // console.log(this.timeout)
    if (timeout) {
      BackgroundTimer.clearTimeout(timeout)
      timeout = null
    }
  }

  const addDelayNextTimeout = () => {
    clearDelayNextTimeout()
    timeout = BackgroundTimer.setTimeout(() => {
      timeout = null
      if (global.lx.isPlayedStop) return
      console.log('delay next timeout timeout', delay)
      info('PLAYER', 'delay next timeout fired', { delay })
      markEvent('player.delayNextTimeout', { delay })
      void playNext(true)
    }, delay)
  }

  return {
    clearDelayNextTimeout,
    addDelayNextTimeout,
  }
}
const { addDelayNextTimeout, clearDelayNextTimeout } = createDelayNextTimeout(5000)
const { addDelayNextTimeout: addLoadTimeout, clearDelayNextTimeout: clearLoadTimeout } = createDelayNextTimeout(100000)
info('PLAYER', 'player module loaded', { delayNextTimeout: 5000, loadTimeout: 100000 })

const createGettingUrlId = (musicInfo: LX.Music.MusicInfo) => {
  return musicInfo.id
}
/**
 * 检查音乐信息是否已更改
 */
const diffCurrentMusicInfo = (curMusicInfo: LX.Music.MusicInfo): boolean => {
  // return curMusicInfo !== playerState.playMusicInfo.musicInfo || playerState.isPlay
  return createGettingUrlId(curMusicInfo) != global.lx.gettingUrlId || curMusicInfo.id != playerState.playMusicInfo.musicInfo?.id || playerState.isPlay
}

let cancelDelayRetry: (() => void) | null = null
const delayRetry = async(musicInfo: LX.Music.MusicInfo, isRefresh = false): Promise<string | null> => {
  // if (cancelDelayRetry) cancelDelayRetry()
  return new Promise<string | null>((resolve, reject) => {
    const time = getRandom(2, 6)
    setStatusText(global.i18n.t('player__getting_url_delay_retry', { time }))
    info('MUSIC_URL', 'delay retry scheduled', {
      id: musicInfo.id,
      isRefresh,
      delayMs: time * 1000,
    })
    markEvent('musicUrl.delayRetry', { id: musicInfo.id, delayMs: time * 1000 })
    const tiemout = setTimeout(() => {
      getMusicPlayUrl(musicInfo, isRefresh, true).then((result) => {
        cancelDelayRetry = null
        resolve(result)
      }).catch(async(err: any) => {
        cancelDelayRetry = null
        reject(err)
      })
    }, time * 1000)
    cancelDelayRetry = () => {
      clearTimeout(tiemout)
      cancelDelayRetry = null
      info('MUSIC_URL', 'delay retry cancelled', { id: musicInfo.id })
      resolve(null)
    }
  })
}
const getMusicPlayUrl = async(musicInfo: LX.Music.MusicInfo, isRefresh = false, isRetryed = false): Promise<string | null> => {
  // this.musicInfo.url = await getMusicPlayUrl(targetSong, type)
  setStatusText(global.i18n.t('player__getting_url'))
  addLoadTimeout()

  info('MUSIC_URL', 'getMusicPlayUrl start', {
    id: musicInfo.id,
    isRefresh,
    isRetryed,
    gettingUrlId: global.lx.gettingUrlId || '',
  })
  markEvent('musicUrl.getMusicPlayUrl.start', { id: musicInfo.id, isRefresh, isRetryed })

  return getMusicUrl({
    musicInfo,
    isRefresh,
  }).then(url => {
    if (global.lx.isPlayedStop || diffCurrentMusicInfo(musicInfo)) {
      info('MUSIC_URL', 'url discarded by guard', {
        id: musicInfo.id,
        isPlayedStop: global.lx.isPlayedStop,
        diffCurrent: diffCurrentMusicInfo(musicInfo),
      })
      return null
    }

    info('MUSIC_URL', 'getMusicPlayUrl done', { id: musicInfo.id, hasUrl: !!url })
    markEvent('musicUrl.getMusicPlayUrl.done', { id: musicInfo.id })
    return url
  }).catch(async err => {
    // console.log('err', err.message)
    if (global.lx.isPlayedStop ||
      diffCurrentMusicInfo(musicInfo) ||
      err.message == requestMsg.cancelRequest) {
      info('MUSIC_URL', 'getMusicPlayUrl failed but ignored', {
        id: musicInfo.id,
        isPlayedStop: global.lx.isPlayedStop,
        message: err.message,
      })
      return null
    }

    if (err.message == requestMsg.tooManyRequests) {
      warn('MUSIC_URL', 'too many requests, delay retry', { id: musicInfo.id })
      return delayRetry(musicInfo, isRefresh)
    }

    if (!isRetryed) {
      warn('MUSIC_URL', 'first attempt failed, retry once', { id: musicInfo.id, message: err.message })
      markEvent('musicUrl.retry', { id: musicInfo.id, message: err.message })
      return getMusicPlayUrl(musicInfo, isRefresh, true)
    }

    error('MUSIC_URL', 'getMusicPlayUrl failed permanently', {
      id: musicInfo.id,
      isRefresh,
      message: err.message,
    })
    markEvent('musicUrl.getMusicPlayUrl.failed', { id: musicInfo.id, message: err.message })
    throw err
  })
}

export const setMusicUrl = (musicInfo: LX.Music.MusicInfo, isRefresh?: boolean) => {
  // addLoadTimeout()
  if (!diffCurrentMusicInfo(musicInfo)) {
    info('MUSIC_URL', 'setMusicUrl skipped by diff guard', { id: musicInfo.id, gettingUrlId: global.lx.gettingUrlId || '' })
    return
  }
  if (cancelDelayRetry) cancelDelayRetry()
  global.lx.gettingUrlId = createGettingUrlId(musicInfo)
  global.lx.gettingUrlIdSince = Date.now()
  info('MUSIC_URL', 'setMusicUrl start', {
    id: musicInfo.id,
    isRefresh: !!isRefresh,
    gettingUrlId: global.lx.gettingUrlId,
  })
  markEvent('musicUrl.setMusicUrl.start', { id: musicInfo.id, isRefresh: !!isRefresh })
  const startTime = Date.now()
  void getMusicPlayUrl(musicInfo, isRefresh).then((url) => {
    if (!url) return
    info('MUSIC_URL', 'setResource with url', { id: musicInfo.id, elapsed: Date.now() - startTime })
    setResource(musicInfo, url, playerState.progress.nowPlayTime)
  }).catch((err: any) => {
    console.log(err)
    error('MUSIC_URL', 'setMusicUrl failed', {
      id: musicInfo.id,
      message: err.message,
      elapsed: Date.now() - startTime,
    })
    markEvent('musicUrl.setMusicUrl.failed', { id: musicInfo.id, message: err.message })
    setStatusText(err.message as string)
    global.app_event.error()
    addDelayNextTimeout()
  }).finally(() => {
    if (musicInfo === playerState.playMusicInfo.musicInfo) {
      const urlWaitMs = global.lx.gettingUrlIdSince ? Date.now() - global.lx.gettingUrlIdSince : 0
      global.lx.gettingUrlId = ''
      global.lx.gettingUrlIdSince = 0
      clearLoadTimeout()
      info('MUSIC_URL', 'setMusicUrl finally, load timeout cleared', { id: musicInfo.id, urlWaitMs })
    }
    void flush()
  })
}

// 恢复上次播放的状态
const handleRestorePlay = async(restorePlayInfo: LX.Player.SavedPlayInfo) => {
  const musicInfo = playerState.playMusicInfo.musicInfo
  if (!musicInfo) return

  setTimeout(() => {
    global.app_event.setProgress(settingState.setting['player.isSavePlayTime'] ? restorePlayInfo.time : 0, restorePlayInfo.maxTime)
  })

  const playMusicInfo = playerState.playMusicInfo

  void initTrackInfo(musicInfo, playerState.musicInfo)

  void getPicPath({ musicInfo, listId: playMusicInfo.listId }).then((url: string) => {
    if (
      musicInfo.id != playMusicInfo.musicInfo?.id ||
      playerState.musicInfo.pic == url ||
      playerState.loadErrorPicUrl == url
    ) return
    setMusicInfo({ pic: url })
    global.app_event.picUpdated()
  })

  void getLyricInfo({ musicInfo }).then((lyricInfo) => {
    if (musicInfo.id != playMusicInfo.musicInfo?.id) return
    setMusicInfo({
      lrc: lyricInfo.lyric,
      tlrc: lyricInfo.tlyric,
      lxlrc: lyricInfo.lxlyric,
      rlrc: lyricInfo.rlyric,
      rawlrc: lyricInfo.rawlrcInfo.lyric,
    })
    global.app_event.lyricUpdated()
  }).catch((err) => {
    console.log(err)
    if (musicInfo.id != playMusicInfo.musicInfo?.id) return
    setStatusText(global.i18n.t('lyric__load_error'))
  })

  if (settingState.setting['player.togglePlayMethod'] == 'random' && !playMusicInfo.isTempPlay) addPlayedList(playMusicInfo as LX.Player.PlayMusicInfo)
}


const debouncePlay = debounceBackgroundTimer((musicInfo: LX.Player.PlayMusic) => {
  setMusicUrl(musicInfo)

  void getPicPath({ musicInfo, listId: playerState.playMusicInfo.listId }).then((url: string) => {
    if (
      musicInfo.id != playerState.playMusicInfo.musicInfo?.id ||
      playerState.musicInfo.pic == url ||
      playerState.loadErrorPicUrl == url) return
    setMusicInfo({ pic: url })
    global.app_event.picUpdated()
  })

  void getLyricInfo({ musicInfo }).then((lyricInfo) => {
    if (musicInfo.id != playerState.playMusicInfo.musicInfo?.id) return
    setMusicInfo({
      lrc: lyricInfo.lyric,
      tlrc: lyricInfo.tlyric,
      lxlrc: lyricInfo.lxlyric,
      rlrc: lyricInfo.rlyric,
      rawlrc: lyricInfo.rawlrcInfo.lyric,
    })
    global.app_event.lyricUpdated()
  }).catch((err) => {
    console.log(err)
    if (musicInfo.id != playerState.playMusicInfo.musicInfo?.id) return
    setStatusText(global.i18n.t('lyric__load_error'))
  })
}, 200)

// 处理音乐播放
const handlePlay = async() => {
  const startTime = Date.now()
  markEvent('player.handlePlay.start')
  info('PLAYER', 'handlePlay start', {
    isInitialized: isInitialized(),
    isIniting: global.lx.playerStatus.isIniting,
    isPlayedStop: global.lx.isPlayedStop,
  })
  if (!isInitialized()) {
    info('PLAYER', 'player not initialized, running initial flow')
    await checkNotificationPermission()
    void checkIgnoringBatteryOptimization()
    await playerInitial({
      volume: getEffectiveVolume(settingState.setting['player.volume'], 1),
      playRate: settingState.setting['player.playbackRate'],
      cacheSize: settingState.setting['player.cacheSize'] ? parseInt(settingState.setting['player.cacheSize']) : 0,
      isHandleAudioFocus: settingState.setting['player.isHandleAudioFocus'],
      isEnableAudioOffload: settingState.setting['player.isEnableAudioOffload'],
    })
    info('PLAYER', 'player initial finished', { elapsed: Date.now() - startTime })
  }

  // 切歌时应用该歌曲持久化的音量系数
  void applyMusicVolume(playerState.playMusicInfo.musicInfo)

  global.lx.isPlayedStop &&= false
  resetRandomNextMusicInfo()

  if (global.lx.restorePlayInfo) {
    info('PLAYER', 'handlePlay restore play branch')
    void handleRestorePlay(global.lx.restorePlayInfo)
    global.lx.restorePlayInfo = null
    return
  }

  const playMusicInfo = playerState.playMusicInfo
  const musicInfo = playMusicInfo.musicInfo

  if (!musicInfo) {
    info('PLAYER', 'handlePlay aborted, no musicInfo')
    return
  }

  // 关键点：setStop 内部是无超时的原生 Promise（TrackPlayer.stop/skipToNext）。
  // 若卡在这里，后面的取 URL / 播放全部不会执行 —— 这是"歌曲不播放"的头号嫌疑。
  // 这里只加日志，不改变任何控制流（不加超时、不 catch），保持与原实现一致。
  markEvent('player.handlePlay.setStop.start', { id: musicInfo.id })
  info('PLAYER', 'handlePlay calling setStop', { id: musicInfo.id, elapsed: Date.now() - startTime })
  const stopStart = Date.now()
  await setStop()
  info('PLAYER', 'handlePlay setStop returned', {
    id: musicInfo.id,
    stopElapsed: Date.now() - stopStart,
    elapsed: Date.now() - startTime,
  })
  markEvent('player.handlePlay.setStop.done', { id: musicInfo.id, stopElapsed: Date.now() - stopStart })
  global.app_event.pause()

  clearDelayNextTimeout()
  clearLoadTimeout()


  if (settingState.setting['player.togglePlayMethod'] == 'random' && !playMusicInfo.isTempPlay) addPlayedList(playMusicInfo as LX.Player.PlayMusicInfo)

  debouncePlay(musicInfo)
  info('PLAYER', 'handlePlay done, debouncePlay scheduled', {
    id: musicInfo.id,
    elapsed: Date.now() - startTime,
  })
  markEvent('player.handlePlay.done', { id: musicInfo.id, elapsed: Date.now() - startTime })
  void flush()
}

/**
 * 播放列表内歌曲
 * @param listId 列表id
 * @param id 歌曲id
 */
export const playListById = async(listId: string, id: string) => {
  const prevListId = playerState.playInfo.playerListId
  setPlayListId(listId)
  const musicInfo = getList(listId).find(m => m.id == id)
  if (!musicInfo) return
  setPlayMusicInfo(listId, musicInfo)
  if (settingState.setting['player.isAutoCleanPlayedList'] || prevListId != listId) clearPlayedList()
  clearTempPlayeList()
  await handlePlay()
}

/**
 * 播放列表内歌曲
 * @param listId 列表id
 * @param index 播放的歌曲位置
 */
export const playList = async(listId: string, index: number) => {
  const prevListId = playerState.playInfo.playerListId
  setPlayListId(listId)
  setPlayMusicInfo(listId, getList(listId)[index])
  if (settingState.setting['player.isAutoCleanPlayedList'] || prevListId != listId) clearPlayedList()
  clearTempPlayeList()
  await handlePlay()
}

const handleToggleStop = async() => {
  await stop()
  setTimeout(() => {
    setPlayMusicInfo(null, null)
  })
}


const randomNextMusicInfo = {
  info: null as LX.Player.PlayMusicInfo | null,
  // index: -1,
}
export const resetRandomNextMusicInfo = () => {
  if (randomNextMusicInfo.info) {
    randomNextMusicInfo.info = null
    // randomNextMusicInfo.index = -1
  }
}

export const getNextPlayMusicInfo = async(): Promise<LX.Player.PlayMusicInfo | null> => {
  if (playerState.tempPlayList.length) { // 如果稍后播放列表存在歌曲则直接播放改列表的歌曲
    const playMusicInfo = playerState.tempPlayList[0]
    return playMusicInfo
  }

  if (playerState.playMusicInfo.musicInfo == null) return null

  if (randomNextMusicInfo.info) return randomNextMusicInfo.info

  const playMusicInfo = playerState.playMusicInfo
  const playInfo = playerState.playInfo
  // console.log(playInfo.playerListId)
  const currentListId = playInfo.playerListId
  if (!currentListId) return null
  const currentList = getList(currentListId)

  const playedList = playerState.playedList
  if (playedList.length) { // 移除已播放列表内不存在原列表的歌曲
    let currentId: string
    if (playMusicInfo.isTempPlay) {
      const musicInfo = currentList[playInfo.playerPlayIndex]
      if (musicInfo) currentId = musicInfo.id
    } else {
      currentId = playMusicInfo.musicInfo!.id
    }
    // 从已播放列表移除播放列表已删除的歌曲
    let index
    for (index = playedList.findIndex(m => m.musicInfo.id === currentId) + 1; index < playedList.length; index++) {
      const playMusicInfo = playedList[index]
      const currentId = playMusicInfo.musicInfo.id
      if (playMusicInfo.listId == currentListId && !currentList.some(m => m.id === currentId)) {
        removePlayedList(index)
        continue
      }
      break
    }

    if (index < playedList.length) return playedList[index]
  }
  // const isCheckFile = findNum > 2 // 针对下载列表，如果超过两次都碰到无效歌曲，则过滤整个列表内的无效歌曲
  let { filteredList, playerIndex } = await filterList({ // 过滤已播放歌曲
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: true,
  })

  if (!filteredList.length) return null
  // let currentIndex: number = filteredList.indexOf(currentList[playInfo.playerPlayIndex])
  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex

  let togglePlayMethod = settingState.setting['player.togglePlayMethod']
  switch (togglePlayMethod) {
    case 'listLoop':
      nextIndex = playerIndex === filteredList.length - 1 ? 0 : playerIndex + 1
      break
    case 'random':
      nextIndex = getRandom(0, filteredList.length)
      break
    case 'list':
      nextIndex = playerIndex === filteredList.length - 1 ? -1 : playerIndex + 1
      break
    case 'singleLoop':
      break
    default:
      return null
  }
  if (nextIndex < 0) return null

  const nextPlayMusicInfo = {
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  }

  if (togglePlayMethod == 'random') {
    randomNextMusicInfo.info = nextPlayMusicInfo
    // randomNextMusicInfo.index = nextIndex
  }
  return nextPlayMusicInfo
}

const handlePlayNext = async(playMusicInfo: LX.Player.PlayMusicInfo) => {
  setPlayMusicInfo(playMusicInfo.listId, playMusicInfo.musicInfo, playMusicInfo.isTempPlay)
  await handlePlay()
}
/**
 * 下一曲
 * @param isAutoToggle 是否自动切换
 * @returns
 */
export const playNext = async(isAutoToggle = false): Promise<void> => {
  const startTime = Date.now()
  const enterId = playerState.playMusicInfo.musicInfo?.id
  markEvent('player.playNext.start', { isAutoToggle })
  info('PLAYER', 'playNext start', {
    isAutoToggle,
    id: enterId,
    tempPlayListSize: playerState.tempPlayList.length,
    playedListSize: playerState.playedList.length,
    listId: playerState.playInfo.playerListId ?? '',
  })
  if (playerState.tempPlayList.length) { // 如果稍后播放列表存在歌曲则直接播放改列表的歌曲
    const playMusicInfo = playerState.tempPlayList[0]
    removeTempPlayList(0)
    await handlePlayNext(playMusicInfo)
    info('PLAYER', 'playNext exit via tempPlayList', {
      id: playMusicInfo.musicInfo.id,
      elapsed: Date.now() - startTime,
    })
    markEvent('player.playNext.exit', { via: 'tempPlayList', elapsed: Date.now() - startTime })
    return
  }

  const playMusicInfo = playerState.playMusicInfo
  const playInfo = playerState.playInfo
  if (playMusicInfo.musicInfo == null) {
    info('PLAYER', 'playNext exit via handleToggleStop (no musicInfo)')
    return handleToggleStop()
  }

  // console.log(playInfo.playerListId)
  const currentListId = playInfo.playerListId
  if (!currentListId) {
    info('PLAYER', 'playNext exit via handleToggleStop (no listId)')
    return handleToggleStop()
  }
  const currentList = getList(currentListId)

  const playedList = playerState.playedList

  if (playedList.length) { // 移除已播放列表内不存在原列表的歌曲
    let currentId: string
    if (playMusicInfo.isTempPlay) {
      const musicInfo = currentList[playInfo.playerPlayIndex]
      if (musicInfo) currentId = musicInfo.id
    } else {
      currentId = playMusicInfo.musicInfo.id
    }
    // 从已播放列表移除播放列表已删除的歌曲
    let index
    for (index = playedList.findIndex(m => m.musicInfo.id === currentId) + 1; index < playedList.length; index++) {
      const playMusicInfo = playedList[index]
      const currentId = playMusicInfo.musicInfo.id
      if (playMusicInfo.listId == currentListId && !currentList.some(m => m.id === currentId)) {
        removePlayedList(index)
        continue
      }
      break
    }

    if (index < playedList.length) {
      await handlePlayNext(playedList[index])
      info('PLAYER', 'playNext exit via playedList', {
        id: playedList[index].musicInfo.id,
        elapsed: Date.now() - startTime,
      })
      markEvent('player.playNext.exit', { via: 'playedList', elapsed: Date.now() - startTime })
      return
    }
  }
  if (randomNextMusicInfo.info) {
    await handlePlayNext(randomNextMusicInfo.info)
    info('PLAYER', 'playNext exit via randomNextMusicInfo', {
      id: randomNextMusicInfo.info.musicInfo.id,
      elapsed: Date.now() - startTime,
    })
    markEvent('player.playNext.exit', { via: 'random', elapsed: Date.now() - startTime })
    return
  }
  // const isCheckFile = findNum > 2 // 针对下载列表，如果超过两次都碰到无效歌曲，则过滤整个列表内的无效歌曲
  const filterStart = Date.now()
  let { filteredList, playerIndex } = await filterList({ // 过滤已播放歌曲
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: true,
  })
  info('PLAYER', 'playNext filterList done', {
    filteredCount: filteredList.length,
    playerIndex,
    elapsed: Date.now() - filterStart,
  })

  if (!filteredList.length) {
    info('PLAYER', 'playNext exit via handleToggleStop (empty filteredList)')
    return handleToggleStop()
  }
  // let currentIndex: number = filteredList.indexOf(currentList[playInfo.playerPlayIndex])
  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex

  let togglePlayMethod = settingState.setting['player.togglePlayMethod']
  if (!isAutoToggle) {
    switch (togglePlayMethod) {
      case 'list':
      case 'singleLoop':
      case 'none':
        togglePlayMethod = 'listLoop'
    }
  }
  switch (togglePlayMethod) {
    case 'listLoop':
      nextIndex = playerIndex === filteredList.length - 1 ? 0 : playerIndex + 1
      break
    case 'random':
      nextIndex = getRandom(0, filteredList.length)
      break
    case 'list':
      nextIndex = playerIndex === filteredList.length - 1 ? -1 : playerIndex + 1
      break
    case 'singleLoop':
      break
    default:
      nextIndex = -1
      info('PLAYER', 'playNext exit via default method')
      return
  }
  if (nextIndex < 0) {
    info('PLAYER', 'playNext exit via nextIndex < 0', { togglePlayMethod })
    return
  }

  markEvent('player.playNext.handlePlayNext.start', { nextIndex })
  await handlePlayNext({
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  })
  info('PLAYER', 'playNext exit via normal', {
    id: filteredList[nextIndex].id,
    nextIndex,
    togglePlayMethod,
    elapsed: Date.now() - startTime,
  })
  markEvent('player.playNext.exit', { via: 'normal', elapsed: Date.now() - startTime })
}

/**
 * 上一曲
 */
export const playPrev = async(isAutoToggle = false): Promise<void> => {
  const startTime = Date.now()
  markEvent('player.playPrev.start', { isAutoToggle })
  info('PLAYER', 'playPrev start', {
    isAutoToggle,
    id: playerState.playMusicInfo.musicInfo?.id,
    playedListSize: playerState.playedList.length,
    listId: playerState.playInfo.playerListId ?? '',
  })
  const playMusicInfo = playerState.playMusicInfo
  if (playMusicInfo.musicInfo == null) {
    info('PLAYER', 'playPrev exit via handleToggleStop (no musicInfo)')
    return handleToggleStop()
  }
  const playInfo = playerState.playInfo

  const currentListId = playInfo.playerListId
  if (!currentListId) {
    info('PLAYER', 'playPrev exit via handleToggleStop (no listId)')
    return handleToggleStop()
  }
  const currentList = getList(currentListId)

  const playedList = playerState.playedList
  if (playedList.length) {
    let currentId: string
    if (playMusicInfo.isTempPlay) {
      const musicInfo = currentList[playInfo.playerPlayIndex]
      if (musicInfo) currentId = musicInfo.id
    } else {
      currentId = playMusicInfo.musicInfo.id
    }
    // 从已播放列表移除播放列表已删除的歌曲
    let index
    for (index = playedList.findIndex(m => m.musicInfo.id === currentId) - 1; index > -1; index--) {
      const playMusicInfo = playedList[index]
      const currentId = playMusicInfo.musicInfo.id
      if (playMusicInfo.listId == currentListId && !currentList.some(m => m.id === currentId)) {
        removePlayedList(index)
        continue
      }
      break
    }

    if (index > -1) {
      await handlePlayNext(playedList[index])
      info('PLAYER', 'playPrev exit via playedList', {
        id: playedList[index].musicInfo.id,
        elapsed: Date.now() - startTime,
      })
      markEvent('player.playPrev.exit', { via: 'playedList', elapsed: Date.now() - startTime })
      return
    }
  }

  // const isCheckFile = findNum > 2
  const filterStart = Date.now()
  let { filteredList, playerIndex } = await filterList({ // 过滤已播放歌曲
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: false,
  })
  info('PLAYER', 'playPrev filterList done', {
    filteredCount: filteredList.length,
    playerIndex,
    elapsed: Date.now() - filterStart,
  })
  if (!filteredList.length) {
    info('PLAYER', 'playPrev exit via handleToggleStop (empty filteredList)')
    return handleToggleStop()
  }

  // let currentIndex = filteredList.indexOf(currentList[playInfo.playerPlayIndex])
  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex
  if (!playMusicInfo.isTempPlay) {
    let togglePlayMethod = settingState.setting['player.togglePlayMethod']
    if (!isAutoToggle) {
      switch (togglePlayMethod) {
        case 'list':
        case 'singleLoop':
        case 'none':
          togglePlayMethod = 'listLoop'
      }
    }
    switch (togglePlayMethod) {
      case 'random':
        nextIndex = getRandom(0, filteredList.length)
        break
      case 'listLoop':
      case 'list':
        nextIndex = playerIndex === 0 ? filteredList.length - 1 : playerIndex - 1
        break
      case 'singleLoop':
        break
      default:
        nextIndex = -1
        info('PLAYER', 'playPrev exit via default method')
        return
    }
    if (nextIndex < 0) {
      info('PLAYER', 'playPrev exit via nextIndex < 0', { togglePlayMethod })
      return
    }
  }


  await handlePlayNext({
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  })
  info('PLAYER', 'playPrev exit via normal', {
    id: filteredList[nextIndex].id,
    nextIndex,
    elapsed: Date.now() - startTime,
  })
  markEvent('player.playPrev.exit', { via: 'normal', elapsed: Date.now() - startTime })
}

/**
 * 恢复播放
 */
export const play = () => {
  markEvent('player.play')
  info('PLAYER', 'play called', {
    id: playerState.playMusicInfo.musicInfo?.id,
    isEmpty: isEmpty(),
    isPlay: playerState.isPlay,
    gettingUrlId: global.lx.gettingUrlId || '',
  })
  if (playerState.playMusicInfo.musicInfo == null) {
    info('PLAYER', 'play aborted, no musicInfo')
    return
  }
  if (isEmpty()) {
    if (createGettingUrlId(playerState.playMusicInfo.musicInfo) != global.lx.gettingUrlId) {
      info('PLAYER', 'play empty track, refreshing url')
      setMusicUrl(playerState.playMusicInfo.musicInfo)
    } else {
      info('PLAYER', 'play empty track but url already being fetched, skipped')
    }
    return
  }
  void setPlay()
}

/**
 * 暂停播放
 */
export const pause = async() => {
  markEvent('player.pause')
  info('PLAYER', 'pause called', { id: playerState.playMusicInfo.musicInfo?.id })
  await setPause()
}

/**
 * 停止播放
 */
export const stop = async() => {
  markEvent('player.stop')
  info('PLAYER', 'stop called', { id: playerState.playMusicInfo.musicInfo?.id })
  await setStop()
  setTimeout(() => {
    global.app_event.stop()
  })
  void flush()
}

/**
 * 播放、暂停播放切换
 */
export const togglePlay = () => {
  global.lx.isPlayedStop &&= false
  info('PLAYER', 'togglePlay called', {
    isPlay: playerState.isPlay,
    isEmpty: isEmpty(),
    id: playerState.playMusicInfo.musicInfo?.id,
  })
  markEvent('player.togglePlay', { isPlay: playerState.isPlay })
  if (playerState.isPlay) {
    void pause()
  } else {
    play()
  }
}

/**
 * 收藏当前播放的歌曲
 */
export const collectMusic = () => {
  if (!playerState.playMusicInfo.musicInfo) return
  void addListMusics(LIST_IDS.LOVE, [
    playerState.playMusicInfo.musicInfo,
  ], settingState.setting['list.addMusicLocationType'])
}

/**
 * 取消收藏当前播放的歌曲
 */
export const uncollectMusic = () => {
  if (!playerState.playMusicInfo.musicInfo) return
  void removeListMusics(LIST_IDS.LOVE, [
    playerState.playMusicInfo.musicInfo.id,
  ])
}

/**
 * 不喜欢当前播放的歌曲
 */
export const dislikeMusic = async() => {
  if (!playerState.playMusicInfo.musicInfo) return
  const minfo = playerState.playMusicInfo.musicInfo
  await addDislikeInfo([{ name: minfo.name, singer: minfo.singer }])
  await playNext(true)
}

