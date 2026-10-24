import { getData, saveData, getAllKeys, removeDataMultiple, saveDataMultiple, removeData, getDataMultiple } from '@/plugins/storage'
import { DEFAULT_SETTING, LIST_IDS, storageDataPrefix, type NAV_ID_Type } from '@/config/constant'
import { throttle } from './common'
// import { gzip, ungzip } from '@/utils/nativeModules/gzip'
// import { readFile, writeFile, temporaryDirectoryPath, unlink } from '@/utils/fs'
// import { isNotificationsEnabled, openNotificationPermissionActivity, shareText } from '@/utils/nativeModules/utils'
// import { i18n } from '@/plugins/i18n'
// import musicSdk from '@/utils/musicSdk'

const fontSizeKey = storageDataPrefix.fontSize
const themeKey = storageDataPrefix.theme
const playInfoStorageKey = storageDataPrefix.playInfo
const userListKey = storageDataPrefix.userList
const viewPrevStateKey = storageDataPrefix.viewPrevState
const listScrollPositionKey = storageDataPrefix.listScrollPosition
const listPrevSelectIdKey = storageDataPrefix.listPrevSelectId
const syncAuthKeyPrefix = storageDataPrefix.syncAuthKey
const syncHostPrefix = storageDataPrefix.syncHost
const syncHostHistoryPrefix = storageDataPrefix.syncHostHistory
const musicFileSyncBaselineKey = storageDataPrefix.musicFileSyncBaseline
const listPrefix = storageDataPrefix.list
const dislikeListPrefix = storageDataPrefix.dislikeList
const openStoragePathPrefix = storageDataPrefix.openStoragePath
const selectedManagedFolderPrefix = storageDataPrefix.selectedManagedFolder

// const defaultListKey = listPrefix + 'default'
// const loveListKey = listPrefix + 'love'

let listPosition: LX.List.ListPositionInfo
let listPrevSelectId: string


const saveListPositionThrottle = throttle(() => {
  void saveData(listScrollPositionKey, listPosition)
}, 1000)
const saveViewPrevStateThrottle = throttle((state) => {
  void saveData(viewPrevStateKey, state)
}, 1000)

export const getFontSize = async() => (await getData<number>(fontSizeKey) ?? 1)
export const saveFontSize = async(size: number) => {
  await saveData(fontSizeKey, size)
}

export const getUserTheme = async() => (await getData<LX.Theme[]>(themeKey) ?? [])
export const saveUserTheme = async(themes: LX.Theme[]) => {
  await saveData(themeKey, themes)
}


const initPosition = async() => {
  // eslint-disable-next-line require-atomic-updates
  listPosition ??= await getData(listScrollPositionKey) ?? {}
}
export const getListPosition = async(id: string): Promise<number> => {
  await initPosition()
  return listPosition[id] ?? 0
}
export const saveListPosition = async(id: string, position?: number) => {
  await initPosition()
  listPosition[id] = position ?? 0
  saveListPositionThrottle()
}
export const removeListPosition = async(id: string) => {
  await initPosition()
  delete listPosition[id]
  saveListPositionThrottle()
}
export const overwriteListPosition = async(ids: string[]) => {
  await initPosition()
  const removedIds = []
  for (const id of Object.keys(listPosition)) {
    if (ids.includes(id)) continue
    removedIds.push(id)
  }
  for (const id of removedIds) delete listPosition[id]
  saveListPositionThrottle()
}

const saveListPrevSelectIdThrottle = throttle(() => {
  void saveData(listPrevSelectIdKey, listPrevSelectId)
}, 200)
export const getListPrevSelectId = async() => {
  // eslint-disable-next-line require-atomic-updates
  listPrevSelectId ??= await getData(listPrevSelectIdKey) ?? LIST_IDS.DEFAULT
  return listPrevSelectId || LIST_IDS.DEFAULT
}
export const saveListPrevSelectId = (id: string) => {
  listPrevSelectId = id
  saveListPrevSelectIdThrottle()
}


let openStoragePath: string | null = ''
export const saveOpenStoragePath = async(path: string) => {
  if (path) {
    openStoragePath = path
    await saveData(openStoragePathPrefix, path)
  } else {
    if (!openStoragePath) return
    openStoragePath = null
    await removeData(openStoragePathPrefix)
  }
}
// 获取上次打开的存储路径
export const getOpenStoragePath = async() => {
  if (openStoragePath === '') {
    // eslint-disable-next-line require-atomic-updates
    openStoragePath = await getData<string | null>(openStoragePathPrefix)
  }
  return openStoragePath
}

export const getViewPrevState = async() => {
  return (await getData<{ id: NAV_ID_Type }>(viewPrevStateKey)) ?? { ...DEFAULT_SETTING.viewPrevState }
}
export const saveViewPrevState = (state: { id: NAV_ID_Type }) => {
  saveViewPrevStateThrottle(state)
}


const idFixRxp = /\.0$/
/**
 * 获取用户列表
 */
export const getUserLists = async(): Promise<LX.List.UserListInfo[]> => {
  const list = await getData<LX.List.UserListInfo[]>(userListKey) ?? []
  for (const info of list) {
    // 兼容v2.3.0之前版本PC端插入数字类型的ID导致其意外在末尾追加 .0 的问题
    if (info.sourceListId?.endsWith?.('.0')) {
      info.sourceListId = info.sourceListId.replace(idFixRxp, '')
    }
  }
  return list
}

/**
 * 保存用户列表
 * @param listInfo
 */
export const saveUserList = async(listInfo: LX.List.UserListInfo[]) => {
  await saveData(userListKey, listInfo)
}

/**
 * 获取列表内歌曲
 * @param listId 列表id
 * @returns
 */
export const getListMusics = async(listId: string): Promise<LX.Music.MusicInfo[]> => {
  const list = await getData<LX.Music.MusicInfo[]>(listPrefix + listId)
  return list ?? []
}

/**
 * 保存列表内歌曲
 * @param listData 列表数据
 */
export const saveListMusics = async(listData: Array<{ id: string, musics: LX.Music.MusicInfo[] }>) => {
  if (listData.length > 1) {
    await saveDataMultiple(listData.map(list => ([listPrefix + list.id, list.musics])))
  } else {
    const list = listData[0]
    await saveData(listPrefix + list.id, list.musics)
  }
}

/**
 * 移除歌曲列表
 * @param ids
 */
export const removeListMusics = async(ids: string[]): Promise<void> => {
  if (ids.length > 1) {
    await removeDataMultiple(ids.map(id => {
      // delete global.lx.listScrollPosition[id]
      // delete global.lx.listSort[id]
      return listPrefix + id
    }))
  } else {
    await removeData(listPrefix + ids[0])
  }
  // await saveData(listSortPrefix, global.lx.listSort)
  // delaySaveListScrollPosition(global.lx.listScrollPosition)
}

export const getLyric = async(musicInfo: LX.Music.MusicInfo) => getData<LX.Music.LyricInfo>(`${storageDataPrefix.lyric}${musicInfo.id}`).then(lrcInfo => lrcInfo ?? { lyric: '' })
export const saveLyric = async(musicInfo: LX.Music.MusicInfo, lyricInfo: LX.Music.LyricInfo) => saveData(`${storageDataPrefix.lyric}${musicInfo.id}`, lyricInfo)
export const clearLyric = async(keys?: string[]) => {
  if (!keys) keys = (await getAllKeys()).filter(key => key.startsWith(storageDataPrefix.lyric))
  await removeDataMultiple(keys)
}
export const saveEditedLyric = async(musicInfo: LX.Music.MusicInfo, lyricInfo: LX.Music.LyricInfo) => saveData(`${storageDataPrefix.lyric}${musicInfo.id}_edited`, lyricInfo)
export const clearEditedLyric = async() => {
  let keys = (await getAllKeys()).filter(key => key.startsWith(storageDataPrefix.lyric) && key.endsWith('_edited'))
  await removeDataMultiple(keys)
}
export const getPlayerLyric = async(musicInfo: LX.Music.MusicInfo): Promise<LX.Player.LyricInfo> => {
  return getDataMultiple([
    `${storageDataPrefix.lyric}${musicInfo.id}`,
    `${storageDataPrefix.lyric}${musicInfo.id}_edited`,
  ]).then(([lrcInfo, lrcInfo_edited]) => {
    const lyricInfo: LX.Music.LyricInfo = lrcInfo_edited[1] as LX.Music.LyricInfo | null ?? {
      lyric: '',
    }
    let rawLyricInfo: LX.Music.LyricInfo = lrcInfo[1] as LX.Music.LyricInfo | null ?? {
      lyric: '',
    }
    return lyricInfo.lyric ? {
      ...lyricInfo,
      rawlrcInfo: rawLyricInfo,
    } : {
      ...rawLyricInfo,
      rawlrcInfo: rawLyricInfo,
    }
  })
}

export const getMusicVolume = async(musicInfo: LX.Music.MusicInfo) => getData<number>(`${storageDataPrefix.musicVolume}${musicInfo.id}`).then((volume) => volume ?? 1)
export const saveMusicVolume = async(musicInfo: LX.Music.MusicInfo, volume: number) => saveData(`${storageDataPrefix.musicVolume}${musicInfo.id}`, volume)
export const removeMusicVolume = async(musicInfo: LX.Music.MusicInfo) => removeData(`${storageDataPrefix.musicVolume}${musicInfo.id}`)
export const clearMusicVolume = async(keys?: string[]) => {
  if (!keys) keys = (await getAllKeys()).filter(key => key.startsWith(storageDataPrefix.musicVolume))
  await removeDataMultiple(keys)
}

/**
 * 获取不喜欢列表信息
 * @returns 不喜欢列表信息
 */
export const getDislikeListRules = async() => {
  return await getData<string>(dislikeListPrefix) ?? ''
}
/**
 * 保存列表信息
 * @param rules 规则信息
 */
export const saveDislikeListRules = async(rules: string) => {
  await saveData(dislikeListPrefix, rules)
}

export const getMetaCache = async() => {
  const keys = await getAllKeys()
  const info = {
    lyricKeys: [] as string[],
  }

  for (const key of keys) {
    if (key.startsWith(storageDataPrefix.lyric)) info.lyricKeys.push(key)
  }

  return info
}

export const savePlayInfo = async(playInfo: LX.Player.SavedPlayInfo) => {
  return saveData(playInfoStorageKey, playInfo)
}
// 获取上次关闭时的当前歌曲播放信息
export const getPlayInfo = async() => {
  return getData<LX.Player.SavedPlayInfo | null>(playInfoStorageKey)
}

let selectedManagedFolder: string | null = ''
export const setSelectedManagedFolder = async(uri: string) => {
  selectedManagedFolder = uri
  return saveData(selectedManagedFolderPrefix, uri)
}
export const getSelectedManagedFolder = async() => {
  if (selectedManagedFolder != '') return selectedManagedFolder
  let uri = await getData<string>(selectedManagedFolderPrefix)
  if (selectedManagedFolder != uri) selectedManagedFolder = uri
  return selectedManagedFolder
}

export const getSyncAuthKey = async(serverId: string) => {
  const keys = await getData<Record<string, LX.Sync.KeyInfo>>(syncAuthKeyPrefix)
  if (!keys) return null
  return keys[serverId] ?? null
}
export const setSyncAuthKey = async(serverId: string, info: LX.Sync.KeyInfo) => {
  let keys = await getData<Record<string, LX.Sync.KeyInfo>>(syncAuthKeyPrefix) ?? {}
  keys[serverId] = info
  await saveData(syncAuthKeyPrefix, keys)
}

let syncHostInfo: string
export const getSyncHost = async() => {
  if (syncHostInfo === undefined) {
    // eslint-disable-next-line require-atomic-updates
    syncHostInfo = await getData(syncHostPrefix) ?? ''

    // 清空1.0.0之前版本的同步主机
    if (typeof syncHostInfo == 'object') syncHostInfo = ''
  }
  return syncHostInfo
}
export const setSyncHost = async(host: string) => {
  // let hostInfo = await getData(syncHostPrefix) || {}
  // hostInfo.host = host
  // hostInfo.port = port
  syncHostInfo = host
  await saveData(syncHostPrefix, syncHostInfo)
}
let syncHostHistory: string[]
export const getSyncHostHistory = async() => {
  if (syncHostHistory === undefined) {
    // eslint-disable-next-line require-atomic-updates
    syncHostHistory = await getData(syncHostHistoryPrefix) ?? []

    // 清空1.0.0之前版本的同步历史
    if (syncHostHistory.length && typeof syncHostHistory[0] !== 'string') syncHostHistory = []
  }
  return syncHostHistory
}
export const addSyncHostHistory = async(host: string) => {
  let syncHostHistory = await getSyncHostHistory()
  if (syncHostHistory.some(h => h == host)) return
  syncHostHistory.unshift(host)
  if (syncHostHistory.length > 20) syncHostHistory = syncHostHistory.slice(0, 20) // 最多存储20个
  await saveData(syncHostHistoryPrefix, syncHostHistory)
}
export const removeSyncHostHistory = async(index: number) => {
  syncHostHistory.splice(index, 1)
  await saveData(syncHostHistoryPrefix, syncHostHistory)
}

let musicFileSyncBaseline: string[] | undefined
/** 本地音乐文件同步：上次同步结束时两端都存在的文件相对路径 */
export const getMusicFileSyncBaseline = async(): Promise<string[]> => {
  if (musicFileSyncBaseline === undefined) {
    // eslint-disable-next-line require-atomic-updates
    musicFileSyncBaseline = await getData<string[]>(musicFileSyncBaselineKey) ?? []
  }
  return musicFileSyncBaseline
}
export const saveMusicFileSyncBaseline = async(paths: string[]) => {
  musicFileSyncBaseline = paths
  await saveData(musicFileSyncBaselineKey, paths)
}

