// 在线歌词匹配的查询构造（纯函数，无平台依赖）
import { collapseWhitespace, toHalfWidth } from './normalize'

export interface MatchQueryInput {
  name: string
  singer: string
  albumName: string
  durationSec: number | null
  fileStem: string
}

// 标题/文件名里的伴奏标记（词边界/括号标记，避免把含 inst 子串的普通歌名误判为纯音乐）
const instrumentalMarkerRxp = /[(（[【]\s*(?:inst(?:\.|_)?|off ?vocal|instrumental|纯音乐|纯音樂|純音樂|カラオケ)\s*[)）\]】]|(?:^|[\s\-_~])(?:inst(?:\.|_)?|off ?vocal|instrumental|纯音乐|纯音樂|純音樂|カラオケ)(?:[\s\-_~]|$)/i
// 尾部常见后缀标记
const tailSuffixRxp = /[\s\-_~·]*(?:off ?vocal|instrumental|inst\.?|tv ?ver\.?|tv ?size|short ?ver\.?|short ?size|アニメ ?ver\.?|カラオケ|纯音乐|纯音樂|純音樂)$/i
const bracketContentRxp = /[（(【[<][^）)】\]>]*[）)】\]>]/g
const featSuffixRxp = /\s+(?:feat|ft|featuring)\.?\s+.*$/i
const tailSeparatorRxp = /[\s\-_~·]+$/

/**
 * 从文件路径取文件名（去掉扩展名，原样保留）
 */
export const getFileStem = (filePath: string): string => {
  if (!filePath) return ''
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const fileName = filePath.substring(index + 1)
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex > 0 ? fileName.substring(0, dotIndex) : fileName
}

/**
 * 解析 `mm:ss` 格式的时长（歌曲信息里的 interval）为秒
 */
export const parseIntervalToSec = (interval?: string | null): number | null => {
  if (!interval) return null
  const parts = interval.split(':')
  if (parts.length < 2) return null
  const minutes = Number(parts[parts.length - 2])
  const seconds = Number(parts[parts.length - 1])
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
  return minutes * 60 + seconds
}

/**
 * 判断标题里是否有明确的伴奏/纯音乐标记（`(inst)`、`(Off Vocal)`、`off vocal`、`纯音乐` 等）
 */
export const hasInstrumentalMarker = (str?: string | null): boolean => {
  if (!str) return false
  return instrumentalMarkerRxp.test(str)
}

/**
 * 判断歌名/文件名是否疑似纯音乐（与 hasInstrumentalMarker 语义一致，避免裸 `inst` 子串误判）
 */
export const isInstrumentalName = (str?: string | null): boolean => {
  return hasInstrumentalMarker(str)
}

/**
 * 清洗用于关键字搜索的歌曲名：
 * 去括号内容、feat. 合作歌手、尾部常见的 off vocal / instrumental / TV size 等标记
 */
export const cleanSearchName = (name?: string | null): string => {
  if (!name) return ''
  let result = collapseWhitespace(toHalfWidth(name))
  result = result.replace(bracketContentRxp, ' ')
  result = result.replace(featSuffixRxp, '')
  let last = ''
  while (last !== result) {
    last = result
    result = result.replace(tailSuffixRxp, '')
  }
  return collapseWhitespace(result).replace(tailSeparatorRxp, '').trim()
}

const pushVariant = (variants: string[], value: string) => {
  const variant = collapseWhitespace(value)
  if (!variant || variants.includes(variant)) return
  variants.push(variant)
}

/**
 * 构造匹配查询（含按优先级排序、去重后的 variants）
 * @param input 歌曲信息
 * @param keyword 用户在搜索框手动输入的查询串，优先生效
 */
export const createMatchQuery = (input: MatchQueryInput, keyword?: string): LX.Music.MatchQuery => {
  const name = collapseWhitespace(toHalfWidth(input.name ?? ''))
  const singer = collapseWhitespace(toHalfWidth(input.singer ?? ''))
  const albumName = collapseWhitespace(input.albumName ?? '')
  const fileStem = input.fileStem ?? ''
  const variants: string[] = []

  const trimmedKeyword = keyword?.trim()
  if (trimmedKeyword) pushVariant(variants, trimmedKeyword)
  if (name && singer) pushVariant(variants, `${name} ${singer}`)
  if (name) pushVariant(variants, name)

  // 文件名解析结果（与标签不同时）
  if (fileStem && fileStem !== name) {
    const parts = fileStem.split(' - ')
    if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
      pushVariant(variants, `${parts[0]} ${parts[1]}`)
      pushVariant(variants, `${parts[1]} ${parts[0]}`)
    } else {
      pushVariant(variants, fileStem)
    }
  }

  // 清洗后的歌名
  const cleanedName = cleanSearchName(name)
  if (cleanedName && cleanedName !== name) pushVariant(variants, cleanedName)

  return {
    name,
    singer,
    albumName,
    durationSec: input.durationSec ?? null,
    fileStem,
    variants,
  }
}
