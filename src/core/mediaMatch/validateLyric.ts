/**
 * 取词后的歌词有效性校验（provider 层共用，设计 §2.5）
 *
 * - 含 ≥1 个时间标签 → isSynced = true
 * - 长度 < 20 字符 → 无效
 * - 命中占位文本（未经许可/不得翻唱/纯音乐/暂无歌词）→ 视为纯音乐/占位，禁止应用
 * - 无时间标签但长度 ≥ 20 → 允许，isSynced = false（应用前二次确认）
 */

export const timeTagRxp = /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g
export const lyricPlaceholderRxp = /未经许可|不得翻唱|纯音乐|純音樂|暂无歌词/
const MIN_LYRIC_LENGTH = 20

export interface ValidatedLyric {
  lyric: string
  isSynced: boolean
}

/**
 * 校验歌词文本；无效时返回 null
 */
export const validateLyricText = (rawLyric?: string | null): ValidatedLyric | null => {
  if (!rawLyric) return null
  const lyric = rawLyric.replace(/\r\n?/g, '\n').trim()
  if (lyric.length < MIN_LYRIC_LENGTH) return null
  if (lyricPlaceholderRxp.test(lyric)) return null
  const hasSynced = (lyric.match(timeTagRxp) ?? []).length > 0
  return { lyric, isSynced: hasSynced }
}
