import { updateListMusics } from '@/core/list'
import {
  buildLyricInfo,
  getCachedLyricInfo,
} from './utils'
import { formatLocalFilePathToUrl, getLocalFilePath } from '@/utils/music'
import { readEmbeddedLyric, readLrcFile, readPic } from '@/utils/localMediaMetadata'
import { getCoverImagePathIfExists } from '@/utils/coverFile'
import settingState from '@/store/setting/state'


export const getMusicUrl = async({ musicInfo, isRefresh }: {
  musicInfo: LX.Music.MusicInfo
  isRefresh: boolean
}): Promise<string> => {
  const path = await getLocalFilePath(musicInfo)
  if (path) return formatLocalFilePathToUrl(path)

  throw new Error('本地文件不存在')
}

export const getPicUrl = async({ musicInfo, listId, isRefresh }: {
  musicInfo: LX.Music.MusicInfo
  listId?: string | null
  isRefresh: boolean
}): Promise<string> => {
  if (!isRefresh) {
    const localInfo = musicInfo
    // 优先同名外挂封面（jpg → png），带 mtime 查询串击穿 Fresco 缓存
    if (localInfo.meta.filePath) {
      const cover = await getCoverImagePathIfExists(localInfo.meta.filePath).catch(() => null)
      if (cover) return `${formatLocalFilePathToUrl(cover.path)}?v=${Math.round(cover.mtime)}`
    }

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
  musicInfo.meta.picUrl = url
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

/**
 * 获取该歌曲的实际歌词来源偏好：
 * 单曲 meta.lyricSource 优先，未设置时使用全局设置 player.lyricSource（默认内嵌）
 */
export const getPreferredLyricSource = (musicInfo: LX.Music.MusicInfoLocal): LX.Music.LyricSource => {
  return musicInfo.meta.lyricSource ?? settingState.setting['player.lyricSource'] ?? 'embedded'
}

/**
 * 同时读取内嵌歌词与同名 .lrc，并按来源偏好选择；
 * 所选来源不存在/为空时自动回退另一来源。
 */
const readFileLyric = async(musicInfo: LX.Music.MusicInfoLocal): Promise<{
  lyricInfo: LX.Music.LyricInfo
  source: LX.Music.LyricSource
} | null> => {
  const filePath = musicInfo.meta.filePath
  if (!filePath) return null

  const [embeddedRaw, lrcRaw] = await Promise.all([
    readEmbeddedLyric(filePath).catch(() => ''),
    readLrcFile(filePath).catch(() => ''),
  ])
  const embeddedInfo = embeddedRaw.trim() ? parseLyric(embeddedRaw) : null
  const lrcInfo = lrcRaw.trim() ? parseLyric(lrcRaw) : null
  const hasEmbedded = !!embeddedInfo?.lyric?.trim()
  const hasLrc = !!lrcInfo?.lyric?.trim()
  if (!hasEmbedded && !hasLrc) return null

  const preferred = getPreferredLyricSource(musicInfo)
  let lyricInfo: LX.Music.LyricInfo
  let source: LX.Music.LyricSource
  if (preferred === 'lrc') {
    if (hasLrc) {
      lyricInfo = lrcInfo!
      source = 'lrc'
    } else {
      lyricInfo = embeddedInfo!
      source = 'embedded'
    }
  } else {
    if (hasEmbedded) {
      lyricInfo = embeddedInfo!
      source = 'embedded'
    } else {
      lyricInfo = lrcInfo!
      source = 'lrc'
    }
  }
  return { lyricInfo, source }
}

export const getLyricInfo = async({ musicInfo, isRefresh }: {
  musicInfo: LX.Music.MusicInfo
  isRefresh: boolean
}): Promise<LX.Player.LyricInfo> => {
  // 按来源偏好读取文件歌词（内嵌 / 同名 .lrc），缺失时自动回退
  const fileLyric = await readFileLyric(musicInfo)
  if (fileLyric) {
    const lyricInfo = await buildLyricInfo(fileLyric.lyricInfo)
    return { ...lyricInfo, source: fileLyric.source }
  }

  // 已编辑歌词（DB）缓存保持现有优先级：仅在文件歌词不可用时使用
  if (!isRefresh) {
    const lyricInfo = await getCachedLyricInfo(musicInfo)
    if (lyricInfo?.lyric) return buildLyricInfo(lyricInfo)
  }

  return buildLyricInfo({ lyric: '', tlyric: '', rlyric: '', lxlyric: '' })
}
