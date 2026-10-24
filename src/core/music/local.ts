import { updateListMusics } from '@/core/list'
import {
  buildLyricInfo,
  getCachedLyricInfo,
} from './utils'
import { formatLocalFilePathToUrl, getLocalFilePath } from '@/utils/music'
import { readLyric, readPic } from '@/utils/localMediaMetadata'


export const getMusicUrl = async({ musicInfo, isRefresh }: {
  musicInfo: LX.Music.MusicInfo
  isRefresh: boolean
}): Promise<string> => {
  const path = await getLocalFilePath(musicInfo as LX.Music.MusicInfoLocal)
  if (path) return formatLocalFilePathToUrl(path)

  throw new Error('本地文件不存在')
}

export const getPicUrl = async({ musicInfo, listId, isRefresh, skipFilePic }: {
  musicInfo: LX.Music.MusicInfo
  listId?: string | null
  isRefresh: boolean
  skipFilePic?: boolean
}): Promise<string> => {
  if (!isRefresh && !skipFilePic) {
    const localInfo = musicInfo as LX.Music.MusicInfoLocal
    let pic = await readPic(localInfo.meta.filePath).catch(() => null)
    if (pic) {
      if (pic.startsWith('/')) pic = formatLocalFilePathToUrl(pic)
      return pic
    }

    if (localInfo.meta.picUrl) return localInfo.meta.picUrl
  }

  return ''
}

// 本地歌曲的封面缓存更新（供后续在线匹配封面使用）
export const updateLocalPic = (listId: string, musicInfo: LX.Music.MusicInfo, url: string) => {
  (musicInfo as LX.Music.MusicInfoLocal).meta.picUrl = url
  void updateListMusics([{ id: listId, musicInfo }])
}

export const parseLyric = (lrc: string): LX.Music.LyricInfo => {
  const verifyAwlrc = (lrc: string) => {
    return /(?:^|\s*)\[\d+:\d+(?:\.\d+)]<\d+,\d+>.+$/m.test(lrc)
  }
  const verifylrc = (lrc: string) => {
    return /(?:^|\s*)\[\d+:\d+(?:\.\d+)].+$/m.test(lrc)
  }
  const lrcTags = {
    awlrc: {
      name: 'lxlyric',
      verify: verifyAwlrc,
    },
    lrc: {
      name: 'lyric',
      verify: verifylrc,
    },
    tlrc: {
      name: 'tlyric',
      verify: verifylrc,
    },
    rlrc: {
      name: 'rlyric',
      verify: verifylrc,
    },
  } as const
  const tagRxp = /(?:^|\n\s*)\[awlrc:([^\]]+)]/i
  const lrcRxp = /^(lrc|awlrc|tlrc|rlrc):([^,]+)$/i
  const parse = (content: string) => {
    const lyricInfo: Partial<LX.Music.LyricInfo> = {}
    const lrcs = content.trim().split(',')
    for (const lrc of lrcs) {
      const result = lrcRxp.exec(lrc.trim())
      if (!result) continue
      const target = lrcTags[result[1].toLowerCase() as 'tlrc' | 'rlrc' | 'lrc' | 'awlrc']
      if (!target) continue
      const data = Buffer.from(result[2], 'base64').toString('utf-8').trim()
      if (target.verify(data)) lyricInfo[target.name] = data
    }
    return lyricInfo
  }
  let parsedInfo: Partial<LX.Music.LyricInfo> = {}
  const lyric = lrc.replace(tagRxp, (_: string, p1: string) => {
    parsedInfo = parse(p1)
    return ''
  }).trim()
  return { lyric, ...parsedInfo }
}

const getMusicFileLyric = async(filePath: string) => {
  const lyric = await readLyric(filePath).catch(() => null)
  if (!lyric) return null
  return parseLyric(lyric)
}

export const getLyricInfo = async({ musicInfo, isRefresh, skipFileLyric }: {
  musicInfo: LX.Music.MusicInfo
  isRefresh: boolean
  skipFileLyric?: boolean
}): Promise<LX.Player.LyricInfo> => {
  if (!isRefresh && !skipFileLyric) {
    // 尝试读取文件内歌词
    const rawlrcInfo = await getMusicFileLyric((musicInfo as LX.Music.MusicInfoLocal).meta.filePath)
    if (rawlrcInfo) return buildLyricInfo(rawlrcInfo)

    const lyricInfo = await getCachedLyricInfo(musicInfo)
    if (lyricInfo?.lyric) return buildLyricInfo(lyricInfo)
  }

  return buildLyricInfo({ lyric: '', tlyric: '', rlyric: '', lxlyric: '' })
}
