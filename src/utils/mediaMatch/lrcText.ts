// LRC 文本生成（纯函数，无平台依赖）

export interface LrcTextCandidate {
  name: string
  singer: string
  albumName: string
  lyric: string
  isSynced: boolean
  /** 行级中文翻译（netease 源）；为空时不写扩展段 */
  tlyric?: string | null
  /** 行级罗马音（netease 源）；为空时不写扩展段 */
  rlyric?: string | null
}

export interface ExtendedLyricData {
  tlyric?: string | null
  rlyric?: string | null
  /** 逐字歌词（桌面端 QQ 逐字用；移动端保留能力，不写时不影响输出） */
  lxlyric?: string | null
}

const trimTagValue = (value: string): string => value.replace(/[\r\n]/g, ' ').replace(/]/g, '〕').trim()

// 源歌词自带的头部标签行（写入前剔除，避免与本地生成的头部重复；[offset:] 等其它标签保留）
const sourceHeaderTagRxp = /^\s*\[(?:ti|ar|al|by):.*]\s*$/i
// 逐字歌词的词级时间标签（如 <0,300>），.lrc 只保留行级时间轴，写入前剔除
const wordTimingRxp = /<[\d:.,]+>/g
// 预览用的纯标签行（如 [offset:0]、[re:]），时间标签行以数字开头不会命中
const metadataTagLineRxp = /^\s*\[[a-z][a-z0-9_-]*:.*]\s*$/i
// 行首连续的行级时间标签（[mm:ss] / [mm:ss.xx] / [mm:ss.xxx]）
const leadingTimeTagsRxp = /^(?:\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?]\s*)+/
const firstTimeTagRxp = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?]/

const encodeBase64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')

const toMilliseconds = (minutes: string, seconds: string, fraction?: string): number => {
  // [mm:ss.xx] 按百分秒、[mm:ss.xxx] 按毫秒；统一归一成毫秒比较
  const fractionMs = Number((fraction ?? '').padEnd(3, '0').slice(0, 3))
  return (Number(minutes) * 60 + Number(seconds)) * 1000 + fractionMs
}

/**
 * 清洗扩展歌词（翻译/罗马音）：
 * - CRLF → LF、逐行 trim
 * - 只保留以行级时间标签开头且正文非空的行（[ti:]/[ar:]/[al:]/[by:]/[offset:]/[kana:]/[language:] 等非时间行丢弃）
 * - 丢弃正文为 `//` 或纯空白的占位行
 * - 保留原时间标签与顺序；空结果返回空字符串
 */
export const sanitizeExtendedLyric = (lyric?: string | null): string => {
  if (!lyric) return ''
  const lines: string[] = []
  for (const rawLine of lyric.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const match = leadingTimeTagsRxp.exec(line)
    if (!match) continue
    const body = line.substring(match[0].length).trim()
    if (!body || body === '//') continue
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * 在已生成的 LRC 正文后追加扩展段（[awlrc:lrc:<b64>,tlrc:<b64>,rlrc:<b64>]）。
 *
 * - 标签独占一行，与正文之间空一行，结尾补一个换行
 * - 只写非空段，顺序固定 lrc → tlrc → rlrc（lxlyric 若提供则追加在末尾）
 * - 无扩展数据时原样返回 `body`（与旧版逐字节一致）
 */
export const buildExtendedLrcText = (body: string, data: ExtendedLyricData = {}): string => {
  const text = (body ?? '').replace(/\r\n?/g, '\n')
  const tlyric = sanitizeExtendedLyric(data.tlyric)
  const rlyric = sanitizeExtendedLyric(data.rlyric)
  const lxlyric = sanitizeExtendedLyric(data.lxlyric)
  if (!tlyric && !rlyric && !lxlyric) return body

  // base64 里存完整正文（去尾部空白），供播放器回读覆盖
  const content = text.trimEnd()
  if (!content) return body
  const segments = [`lrc:${encodeBase64(content)}`]
  if (tlyric) segments.push(`tlrc:${encodeBase64(tlyric)}`)
  if (rlyric) segments.push(`rlrc:${encodeBase64(rlyric)}`)
  if (lxlyric) segments.push(`awlrc:${encodeBase64(lxlyric)}`)
  return `${content}\n\n[awlrc:${segments.join(',')}]\n`
}

/**
 * 生成写入 .lrc 文件的文本：
 * - 头部有值才写 [ti:]/[ar:]/[al:]
 * - 正文保留源返回的行（剔除源自带的 [ti:]/[ar:]/[al:]/[by:] 头部行），
 *   每行 trimEnd，连续空行合并，结尾补一个换行
 * - 有翻译/罗马音时追加扩展段；没有时输出与旧版完全一致
 * - 统一 \n 换行、UTF-8 无 BOM（BOM 在 lrcFile 写入时二次兜底清理）
 */
export const buildLrcText = (candidate: LrcTextCandidate): string => {
  const lines: string[] = []
  const name = trimTagValue(candidate.name ?? '')
  const singer = trimTagValue(candidate.singer ?? '')
  const albumName = trimTagValue(candidate.albumName ?? '')
  if (name) lines.push(`[ti:${name}]`)
  if (singer) lines.push(`[ar:${singer}]`)
  if (albumName) lines.push(`[al:${albumName}]`)

  const body: string[] = []
  const sourceLines = (candidate.lyric ?? '').replace(/\r\n?/g, '\n').split('\n')
  for (const sourceLine of sourceLines) {
    // 剔除源歌词自带的 [ti:]/[ar:]/[al:]/[by:] 行，头部统一由本地歌曲信息生成
    if (sourceHeaderTagRxp.test(sourceLine)) continue
    let line = sourceLine.replace(wordTimingRxp, '').trimEnd()
    if (!line) {
      // 连续空行合并为一个
      if (body.length && body[body.length - 1] !== '') body.push('')
      continue
    }
    body.push(line)
  }
  // 去掉正文首尾的空行
  while (body.length && body[0] === '') body.shift()
  while (body.length && body[body.length - 1] === '') body.pop()

  lines.push(...body)
  const text = lines.length ? `${lines.join('\n')}\n` : ''
  return buildExtendedLrcText(text, { tlyric: candidate.tlyric, rlyric: candidate.rlyric })
}

/**
 * 生成用于预览的歌词行（最多 maxLines 行）
 * - 过滤 [ti:]/[ar:]/[al:]/[by:] 等纯标签行（含 [offset:]）
 * - 剔除 <0,300> 这类词级时间标签，避免预览出现原始标签
 * - 跳过空行
 */
export const getLyricPreviewLines = (lyric: string, maxLines = 30): string[] => {
  if (!lyric) return []
  const lines: string[] = []
  for (const sourceLine of lyric.replace(/\r\n?/g, '\n').split('\n')) {
    if (metadataTagLineRxp.test(sourceLine)) continue
    const line = sourceLine.replace(wordTimingRxp, '').trimEnd()
    if (!line.trim()) continue
    lines.push(line)
    if (lines.length >= maxLines) break
  }
  return lines
}

export type LyricPreviewEntryType = 'main' | 'translation' | 'roma'

export interface LyricPreviewEntry {
  text: string
  type: LyricPreviewEntryType
}

interface TimedLyricLine {
  time: number
  text: string
}

const collectTimedLines = (lyric?: string | null): TimedLyricLine[] => {
  if (!lyric) return []
  const lines: TimedLyricLine[] = []
  for (const rawLine of lyric.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const match = leadingTimeTagsRxp.exec(line)
    if (!match) continue
    const text = line.substring(match[0].length).trim()
    if (!text || text === '//') continue
    lines.push({ time: toMilliseconds(match[1], match[2], match[3]), text })
  }
  return lines
}

const createTimeMap = (lines: TimedLyricLine[]): Map<number, string[]> => {
  const map = new Map<number, string[]>()
  for (const line of lines) {
    const queue = map.get(line.time)
    if (queue) queue.push(line.text)
    else map.set(line.time, [line.text])
  }
  return map
}

const takeTimeLine = (map: Map<number, string[]>, time: number): string | null => {
  const queue = map.get(time)
  if (!queue?.length) return null
  return queue.shift() ?? null
}

/**
 * 生成预览行：主行后插入对应时间的翻译行（再罗马音），最多 maxLines 行（含扩展行）。
 *
 * - 时间标签按毫秒归一（[mm:ss.xx] 按百分秒、[mm:ss.xxx] 按毫秒），取主行同时间/同顺序的扩展行
 * - 没有对应扩展行的主行不插；主行无时间标签时不插
 * - 扩展行用 `type` 区分，UI 据此弱化显示
 */
export const getLyricPreviewEntries = (lyric: string, tlyric?: string | null, rlyric?: string | null, maxLines = 30): LyricPreviewEntry[] => {
  if (maxLines <= 0) return []
  const entries: LyricPreviewEntry[] = []
  const translationMap = createTimeMap(collectTimedLines(tlyric))
  const romaMap = createTimeMap(collectTimedLines(rlyric))

  for (const line of getLyricPreviewLines(lyric, maxLines)) {
    if (entries.length >= maxLines) break
    entries.push({ text: line, type: 'main' })

    const timeMatch = firstTimeTagRxp.exec(line)
    if (!timeMatch) continue
    const time = toMilliseconds(timeMatch[1], timeMatch[2], timeMatch[3])

    const translation = takeTimeLine(translationMap, time)
    if (translation && entries.length < maxLines) entries.push({ text: translation, type: 'translation' })

    const roma = takeTimeLine(romaMap, time)
    if (roma && entries.length < maxLines) entries.push({ text: roma, type: 'roma' })
  }
  return entries
}
