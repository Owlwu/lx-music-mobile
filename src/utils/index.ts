import { dateFormat } from './common'
import he from 'he'

export { tranditionalize as langS2T } from '@/utils/simplify-chinese-main'

export * from './common'

// https://stackoverflow.com/a/53387532
export function compareVer(currentVer: string, targetVer: string): -1 | 0 | 1 {
  // treat non-numerical characters as lower version
  // replacing them with a negative number based on charcode of each character
  const fix = (s: string) => `.${s.toLowerCase().charCodeAt(0) - 2147483647}.`

  const currentVerArr: Array<string | number> = ('' + currentVer).replace(/[^0-9.]/g, fix).split('.')
  const targetVerArr: Array<string | number> = ('' + targetVer).replace(/[^0-9.]/g, fix).split('.')
  let c = Math.max(currentVerArr.length, targetVerArr.length)
  for (let i = 0; i < c; i++) {
    // convert to integer the most efficient way
    currentVerArr[i] = ~~currentVerArr[i]
    targetVerArr[i] = ~~targetVerArr[i]
    if (currentVerArr[i] > targetVerArr[i]) return 1
    else if (currentVerArr[i] < targetVerArr[i]) return -1
  }
  return 0
}


export const toNewMusicInfo = (oldMusicInfo: any): LX.Music.MusicInfo | null => {
  // 只迁移本地歌曲；旧数据里的在线条目已无法播放，直接丢弃
  if (oldMusicInfo.source !== 'local') return null
  const filePath: string = oldMusicInfo.filePath ?? oldMusicInfo.songmid ?? ''
  return {
    id: `${oldMusicInfo.source as string}_${oldMusicInfo.songmid as string}`,
    name: oldMusicInfo.name,
    singer: oldMusicInfo.singer,
    source: 'local',
    interval: oldMusicInfo.interval ?? null,
    meta: {
      songId: oldMusicInfo.songmid,
      albumName: oldMusicInfo.albumName ?? '',
      picUrl: oldMusicInfo.img ?? null,
      filePath,
      ext: oldMusicInfo.ext ?? /\.(\w+)$/.exec(filePath)?.[1] ?? '',
    },
  }
}

export const convertLegacyMusicList = (list: any[]): LX.Music.MusicInfo[] => {
  const infos: LX.Music.MusicInfo[] = []
  for (const item of list) {
    const info = toNewMusicInfo(item)
    if (info) infos.push(info)
  }
  return filterMusicList(infos)
}


export const filterMusicList = <T extends LX.Music.MusicInfo>(list: T[]): T[] => {
  const ids = new Set<string>()
  return list.filter(s => {
    if (!s.id || ids.has(s.id) || !s.name) return false
    if (s.singer == null) s.singer = ''
    ids.add(s.id)
    return true
  })
}


export const deduplicationList = <T extends LX.Music.MusicInfo>(list: T[]): T[] => {
  const ids = new Set<string>()
  return list.filter(s => {
    if (ids.has(s.id)) return false
    ids.add(s.id)
    return true
  })
}


/**
 * 时间格式化
 */
export const dateFormat2 = (time: number): string => {
  let differ = Math.trunc((Date.now() - time) / 1000)
  if (differ < 60) {
    return global.i18n.t('date_format_second', { num: differ })
  } else if (differ < 3600) {
    return global.i18n.t('date_format_minute', { num: Math.trunc(differ / 60) })
  } else if (differ < 86400) {
    return global.i18n.t('date_format_hour', { num: Math.trunc(differ / 3600) })
  } else {
    return dateFormat(time)
  }
}

/**
 * 格式化播放数量
 * @param {*} num 数字
 */
export const formatPlayCount = (num: number): string => {
  if (num > 100000000) return `${Math.trunc(num / 10000000) / 10}亿`
  if (num > 10000) return `${Math.trunc(num / 1000) / 10}万`
  return String(num)
}

export const decodeName = (str: string | null = '') => {
  if (!str) return ''
  return he.decode(str)
}
