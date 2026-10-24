import {
  getMusicUrl as getLocalMusicUrl,
  getPicUrl as getLocalPicUrl,
  getLyricInfo as getLocalLyricInfo,
} from './local'


export const getMusicUrl = async({
  musicInfo,
  isRefresh = false,
}: {
  musicInfo: LX.Music.MusicInfo
  isRefresh?: boolean
}): Promise<string> => {
  return getLocalMusicUrl({ musicInfo, isRefresh })
}

export const getPicPath = async({
  musicInfo,
  isRefresh = false,
  listId,
}: {
  musicInfo: LX.Music.MusicInfo
  listId?: string | null
  isRefresh?: boolean
}): Promise<string> => {
  return getLocalPicUrl({ musicInfo, isRefresh, listId })
}

export const getLyricInfo = async({
  musicInfo,
  isRefresh = false,
}: {
  musicInfo: LX.Music.MusicInfo
  isRefresh?: boolean
}): Promise<LX.Player.LyricInfo> => {
  return getLocalLyricInfo({ musicInfo, isRefresh })
}
