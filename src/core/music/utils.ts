import {
  getPlayerLyric as getStoreLyric,
} from '@/utils/data'
import { langS2T } from '@/utils'
import settingState from '@/store/setting/state'


export const existTimeExp = /\[\d{1,2}:.*\d{1,4}\]/

export const buildLyricInfo = async(lyricInfo: MakeOptional<LX.Player.LyricInfo, 'rawlrcInfo'>): Promise<LX.Player.LyricInfo> => {
  if (!settingState.setting['player.isS2t']) {
    // @ts-expect-error
    if (lyricInfo.rawlrcInfo) return lyricInfo
    return { ...lyricInfo, rawlrcInfo: { ...lyricInfo } }
  }

  const tasks = [
    lyricInfo.lyric ? langS2T(lyricInfo.lyric) : Promise.resolve(''),
    lyricInfo.tlyric ? langS2T(lyricInfo.tlyric) : Promise.resolve(''),
    lyricInfo.rlyric ? langS2T(lyricInfo.rlyric) : Promise.resolve(''),
    lyricInfo.lxlyric ? langS2T(lyricInfo.lxlyric) : Promise.resolve(''),
  ]
  if (lyricInfo.rawlrcInfo) {
    tasks.push(lyricInfo.lyric ? langS2T(lyricInfo.lyric) : Promise.resolve(''))
    tasks.push(lyricInfo.tlyric ? langS2T(lyricInfo.tlyric) : Promise.resolve(''))
    tasks.push(lyricInfo.rlyric ? langS2T(lyricInfo.rlyric) : Promise.resolve(''))
    tasks.push(lyricInfo.lxlyric ? langS2T(lyricInfo.lxlyric) : Promise.resolve(''))
  }
  return Promise.all(tasks).then(([lyric, tlyric, rlyric, lxlyric, lyric_raw, tlyric_raw, rlyric_raw, lxlyric_raw]) => {
    const rawlrcInfo = lyric_raw ? {
      lyric: lyric_raw,
      tlyric: tlyric_raw,
      rlyric: rlyric_raw,
      lxlyric: lxlyric_raw,
    } : {
      lyric,
      tlyric,
      rlyric,
      lxlyric,
    }
    return {
      lyric,
      tlyric,
      rlyric,
      lxlyric,
      rawlrcInfo,
    }
  })
}

export const getCachedLyricInfo = async(musicInfo: LX.Music.MusicInfo): Promise<LX.Player.LyricInfo | null> => {
  const lrcInfo = await getStoreLyric(musicInfo)
  if (existTimeExp.test(lrcInfo.lyric) && lrcInfo.tlyric != null) return lrcInfo
  return null
}
